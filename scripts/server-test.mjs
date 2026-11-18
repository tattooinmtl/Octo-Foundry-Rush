/**
 * Server: forge JSON recovery/validation/repair, the LLM client's retry +
 * timeout behaviour against a local mock provider, the endpoint finder's
 * heuristics, SSRF guard, and a full /api/forge round trip.
 * Run: node scripts/server-test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extractJson, validateTower, repairTower, finaliseTower, sanitiseBrief, sanitiseModel, sanitiseUsed, PRESET_FINGERPRINTS, usedSets,
} from '../server/forge-core.mjs';
import { chatOnce, withRetry, chatUrl, modelsUrl, backoffDelay, assertPublicUrl, LlmError } from '../server/llm-client.mjs';
import { deriveBase, rankCandidates, parseDuckDuckGo, findEndpoint, probeEndpoint } from '../server/endpoint-finder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const tower = { name: 'Hush Engine', damageType: 'sonic', effect: 'stun', damage: 20, fireRate: 1.2, range: 4.5, burst: 1, projectileShape: 'pulse', color: '#abcdef', impact: 'x', sound: 'y', mechanic: 'z' };
const T = JSON.stringify(tower);

console.log('forge-core');

await test('extractJson recovers towers from messy model output', () => {
  const cases = [
    T,
    '```json\n' + T + '\n```  ',
    '<think>let me plan {"draft":1}</think>\n' + T,
    'Sure! Here is your tower:\n' + T + '\nHope you like it.',
    '<think>reasoning that never closes... {"name":"draft"}\n' + T,
    T.replace('"burst":1,', '"burst":1,,').replace(/,,/, ','), // still valid
    T.slice(0, -1) + ',}', // trailing comma
    T.replace(/"/g, '\u201c').replace(/\u201c/g, '"'), // smart quotes normalised
    T.slice(0, T.indexOf('"impact"')) + '"impact":"cut off mid', // truncated
    '{"name":"first","damageType":"a"} then corrected: ' + T,
  ];
  for (const c of cases) {
    const j = extractJson(c);
    assert.ok(j && typeof j === 'object', `parsed: ${c.slice(0, 50)}`);
    assert.ok(j.name, 'has a name');
  }
  assert.equal(extractJson('{"name":"first","damageType":"a"} then corrected: ' + T).name, 'Hush Engine', 'last tower wins');
  assert.equal(extractJson(T.slice(0, T.indexOf('"impact"')) + '"impact":"cut').damageType, 'sonic');
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('no json here'), null);
});

await test('validation separates hard (name/type) from cosmetic clashes', () => {
  assert.equal(validateTower(tower, []).ok, true);
  const colour = validateTower({ ...tower, color: '#ff8a3d' }, []);
  assert.equal(colour.ok, false);
  assert.equal(colour.hard, false, 'colour clash is repairable');
  const name = validateTower({ ...tower, name: 'Iron Cannon' }, []);
  assert.equal(name.hard, true);
  assert.equal(validateTower(null, []).hard, true);
  // Numbers out of range are no longer a reason to burn a retry.
  assert.equal(validateTower({ ...tower, damage: 9999, range: 0 }, []).ok, true);
  const fin = finaliseTower({ ...tower, damage: 9999, range: 0, burst: 50, effect: 'teleport' });
  assert.equal(fin.damage, 260);
  assert.equal(fin.range, 2.2);
  assert.equal(fin.burst, 6);
  assert.equal(fin.effect, 'none');
});

await test('repair makes every fingerprint unique', () => {
  const used = [{ name: 'Hush Engine', damageType: 'sonic', projectileShape: 'pulse', color: '#abcdef' }];
  const fixed = repairTower(tower, used);
  const sets = usedSets(used);
  assert.ok(!sets.names.has(fixed.name.toLowerCase()), fixed.name);
  assert.ok(!sets.types.has(fixed.damageType), fixed.damageType);
  assert.ok(!sets.shapes.has(fixed.projectileShape), fixed.projectileShape);
  assert.ok(!sets.colors.has(fixed.color), fixed.color);
  assert.match(fixed.color, /^#[0-9a-f]{6}$/);
  assert.equal(validateTower(fixed, used).ok, true);
  const fromNothing = repairTower(null, []);
  assert.equal(validateTower(fromNothing, []).ok, true);
  // Preset fingerprints are respected too.
  assert.equal(validateTower(repairTower({ ...PRESET_FINGERPRINTS[0] }, []), []).ok, true);
});

await test('inputs from the client are sanitised', () => {
  const b = sanitiseBrief('make a "tower"\n```ignore rules```');
  assert.ok(!/["`\n]/.test(b), b);
  assert.match(b, /^make a 'tower' /);
  assert.equal(sanitiseBrief('x'.repeat(1000)).length, 240);
  assert.equal(sanitiseModel('meta/llama-3.3-70b-instruct', 'd'), 'meta/llama-3.3-70b-instruct');
  assert.equal(sanitiseModel('bad model; rm -rf', 'd'), 'd');
  assert.equal(sanitiseUsed(new Array(1000).fill({ name: 'a' })).length, 200);
  assert.deepEqual(sanitiseUsed('nope'), []);
});

console.log('llm-client');

await test('URL building for both dialects', () => {
  assert.equal(chatUrl('https://api.x.ai/v1/', 'openai'), 'https://api.x.ai/v1/chat/completions');
  assert.equal(chatUrl('https://a.b/v1/chat/completions', 'openai'), 'https://a.b/v1/chat/completions');
  assert.equal(chatUrl('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com/v1/messages');
  assert.equal(chatUrl('https://api.minimax.io/anthropic', 'anthropic'), 'https://api.minimax.io/anthropic/v1/messages');
  assert.equal(chatUrl('https://h/v1', 'anthropic'), 'https://h/v1/messages');
  assert.equal(modelsUrl('https://integrate.api.nvidia.com/v1', 'openai'), 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(modelsUrl('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com/v1/models');
  const d = backoffDelay(3, 600, 8000, () => 0.5);
  assert.equal(d, 4800);
  assert.ok(backoffDelay(10, 600, 8000, () => 1) <= 10000);
});

// Mock provider: behaviour picked per request by the model name.
const hits = {};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const model = j.model ?? 'models';
    hits[model] = (hits[model] ?? 0) + 1;
    const n = hits[model];
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const openai = (content) => send(200, { choices: [{ message: { content }, finish_reason: 'stop' }] });
    if (req.url.endsWith('/models')) return send(401, { error: { message: 'Incorrect API key', code: 'invalid_api_key' } });
    if (req.url.endsWith('/v1/messages')) {
      assert.equal(req.headers['x-api-key'], 'k-anthropic');
      return send(200, { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: T }], stop_reason: 'end_turn' });
    }
    switch (model) {
      case 'flaky': return n < 3 ? send(503, { error: 'busy' }) : openai(T);
      case 'ratelimited': return n < 2 ? send(429, { error: 'slow down' }, { 'Retry-After': '0' }) : openai(T);
      case 'quota': return send(429, { error: 'insufficient balance quota' });
      case 'badkey': return send(401, { error: 'invalid key' });
      case 'slow': return n < 2 ? setTimeout(() => openai(T), 1500) : openai(T);
      case 'empty': return n < 2 ? openai('') : openai(T);
      case 'minimax-err': return send(200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } });
      case 'dup-colour': return openai(JSON.stringify({ ...tower, color: '#ff8a3d' }));
      case 'always-dup-name': return openai(JSON.stringify({ ...tower, name: 'Iron Cannon' }));
      case 'garbage': return openai('I refuse to answer in JSON.');
      case 'longkey': return openai(`${req.headers.authorization.length}`);
      default: return openai(T);
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}/v1`;
const call = (model, extra = {}) =>
  withRetry(() => chatOnce({ compat: 'openai', baseUrl: base, apiKey: 'k', model, system: 's', prompt: 'p', timeoutMs: 800, ...extra }), { retries: 2, baseMs: 10, maxMs: 50 });

await test('retries transient 5xx / 429 / timeouts / empty answers, then succeeds', async () => {
  for (const m of ['flaky', 'ratelimited', 'slow', 'empty']) {
    const out = await call(m);
    assert.ok(extractJson(out.text)?.name, m);
  }
  assert.equal(hits.flaky, 3);
});

await test('does NOT retry bad keys or exhausted quota', async () => {
  await assert.rejects(call('badkey'), (e) => e instanceof LlmError && e.kind === 'auth');
  assert.equal(hits.badkey, 1);
  await assert.rejects(call('quota'), (e) => e.kind === 'quota');
  assert.equal(hits.quota, 1);
  await assert.rejects(call('minimax-err'), (e) => e.kind === 'quota');
});

await test('Anthropic-compatible endpoint: x-api-key header, text blocks only', async () => {
  const out = await chatOnce({ compat: 'anthropic', baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: 'k-anthropic', model: 'claude-x', system: 's', prompt: 'p' });
  assert.equal(extractJson(out.text).name, 'Hush Engine');
});

await test('very long API keys are sent whole', async () => {
  const key = 'rfl_' + 'x'.repeat(400);
  const out = await chatOnce({ compat: 'openai', baseUrl: base, apiKey: key, model: 'longkey', system: 's', prompt: 'p' });
  assert.equal(Number(out.text), `Bearer ${key}`.length);
});

await test('SSRF guard blocks private targets unless allowed', async () => {
  for (const u of ['http://127.0.0.1:1/v1', 'http://localhost/v1', 'http://169.254.169.254/latest', 'http://10.0.0.5/v1', 'http://[::1]/v1', 'file:///etc/passwd', 'https://user:pw@api.x.ai/v1']) {
    await assert.rejects(assertPublicUrl(u), u);
  }
  await assertPublicUrl('http://127.0.0.1:1/v1', { allowPrivate: true });
  await assertPublicUrl('https://api.example.org/v1', { lookup: async () => [{ address: '93.184.216.34' }] });
  await assert.rejects(assertPublicUrl('https://rebind.example/v1', { lookup: async () => [{ address: '192.168.1.4' }] }));
});

console.log('endpoint-finder');

await test('deriveBase understands common API URL shapes', () => {
  assert.deepEqual(
    [deriveBase('https://api.groq.com/openai/v1/chat/completions')].map((d) => [d.baseUrl, d.compat]),
    [['https://api.groq.com/openai/v1', 'openai']],
  );
  assert.equal(deriveBase('https://api.anthropic.com/v1/messages').compat, 'anthropic');
  assert.equal(deriveBase('https://api.anthropic.com/v1/messages').baseUrl, 'https://api.anthropic.com');
  assert.equal(deriveBase('https://api.minimax.io/anthropic').baseUrl, 'https://api.minimax.io/anthropic');
  assert.equal(deriveBase('https://api.minimax.io/anthropic').compat, 'anthropic');
  assert.equal(deriveBase('https://api.mistral.ai/v1/models').baseUrl, 'https://api.mistral.ai/v1');
  assert.equal(deriveBase('https://github.com/foo/v1/chat/completions'), null);
  assert.equal(deriveBase('https://docs.foo.ai/guide/intro'), null);
});

const fixtureDoc = `
  <h1>Acme Lab API</h1>
  <p>The Acme API is OpenAI-compatible. Base URL:</p>
  <pre>https://api.acmelab.ai/v1</pre>
  <pre>curl https://api.acmelab.ai/v1/chat/completions -H "Authorization: Bearer $KEY"</pre>
  <p>See also https://github.com/acmelab/sdk and https://status.acmelab.ai</p>
  <p>Anthropic-compatible endpoint: https://api.acmelab.ai/anthropic (POST /v1/messages)</p>`;

await test('rankCandidates picks the provider API base and dialect', () => {
  const ranked = rankCandidates('Acme Lab', [{ url: 'https://docs.acmelab.ai', text: fixtureDoc }]);
  assert.equal(ranked[0].baseUrl, 'https://api.acmelab.ai/v1');
  assert.equal(ranked[0].compat, 'openai');
  const an = ranked.find((c) => c.baseUrl.endsWith('/anthropic'));
  assert.equal(an?.compat, 'anthropic');
});

await test('DuckDuckGo results are parsed and redirect links decoded', () => {
  const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.acmelab.ai%2Fapi&amp;rut=x">Acme <b>API</b></a>
    <a class="result__snippet" href="#">Base URL https://api.acmelab.ai/v1 is OpenAI-compatible</a></div>`;
  const r = parseDuckDuckGo(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://docs.acmelab.ai/api');
  assert.match(r[0].snippet, /OpenAI-compatible/);
});

await test('findEndpoint: built-in table answers instantly, web path works with a mocked web', async () => {
  const known = await findEndpoint('NVIDIA', { web: false });
  assert.equal(known.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(known.source, 'known');
  const reflection = await findEndpoint('reflection ai', { web: false });
  assert.equal(reflection.baseUrl, 'https://api.reflection.ai/openai/v1');
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://html.duckduckgo.com')) {
      return new Response(`<a class="result__a" href="https://docs.acmelab.ai/api">Acme</a><a class="result__snippet">docs</a>`, { status: 200 });
    }
    if (u === 'https://docs.acmelab.ai/api') return new Response(fixtureDoc, { status: 200 });
    if (u === 'https://api.acmelab.ai/v1/models') return new Response(JSON.stringify({ data: [{ id: 'acme-1' }] }), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  // DNS is not available for the fake host, so allowPrivate skips resolution in this unit test.
  const web = await findEndpoint('Acme Lab', { fetchImpl: fakeFetch, allowPrivate: true });
  assert.equal(web.ok, true, web.error);
  assert.equal(web.source, 'web');
  assert.equal(web.baseUrl, 'https://api.acmelab.ai/v1');
  assert.equal(web.compat, 'openai');
  assert.equal(web.model, 'acme-1', 'model suggested from the public /models list');
  const none = await findEndpoint('', {});
  assert.equal(none.ok, false);
});

await test('probe reads Anthropic-style errors', async () => {
  const f = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } }), { status: 401 });
  const p = await probeEndpoint('https://api.x.test', 'openai', { fetchImpl: f, allowPrivate: true });
  assert.equal(p.reachable, true);
  assert.equal(p.compatHint, 'anthropic');
});

console.log('/api/forge (integration, custom provider -> mock)');

const port = 3900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), ALLOW_PRIVATE_PROVIDER_URLS: '1', FORGE_RETRIES: '2', MINIMAX_API_KEY: '', DOTENV_CONFIG_QUIET: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50 && !log.includes('Local:'); i++) await new Promise((r) => setTimeout(r, 100));

const forge = (model, extra = {}) =>
  fetch(`http://127.0.0.1:${port}/api/forge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ provider: 'custom', custom: { name: 'Mock', baseUrl: base, compat: 'openai', model }, used: [], brief: 'quiet please', ...extra }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

try {
  await test('happy path', async () => {
    const r = await forge('default');
    assert.equal(r.status, 200);
    assert.equal(r.body.tower.name, 'Hush Engine');
  });
  await test('transient failures are retried server-side', async () => {
    hits.flaky = 0;
    const r = await forge('flaky');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  await test('cosmetic clash is repaired without another model call', async () => {
    hits['dup-colour'] = 0;
    const r = await forge('dup-colour');
    assert.equal(r.status, 200);
    assert.equal(r.body.repaired, true);
    assert.notEqual(r.body.tower.color, '#ff8a3d');
    assert.equal(hits['dup-colour'], 1);
  });
  await test('a model that keeps repeating a name still ships a unique tower', async () => {
    const r = await forge('always-dup-name');
    assert.equal(r.status, 200);
    assert.notEqual(r.body.tower.name.toLowerCase(), 'iron cannon');
  });
  await test('garbage answers end in a clear 422', async () => {
    const r = await forge('garbage');
    assert.equal(r.status, 422);
    assert.equal(r.body.kind, 'invalid');
  });
  await test('bad key -> 401 with kind=auth (no retries)', async () => {
    hits.badkey = 0;
    const r = await forge('badkey');
    assert.equal(r.status, 401);
    assert.equal(r.body.kind, 'auth');
    assert.equal(hits.badkey, 1);
  });
  await test('missing key / unknown provider / bad URL are reported', async () => {
    const nokey = await fetch(`http://127.0.0.1:${port}/api/forge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'nvidia' }) });
    assert.equal(nokey.status, 503);
    assert.match((await nokey.json()).error, /NVIDIA_API_KEY/);
    const unk = await fetch(`http://127.0.0.1:${port}/api/forge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'nope' }) });
    assert.equal(unk.status, 400);
    const bad = await forge('x', { custom: { baseUrl: 'ftp://x', model: 'm' } });
    assert.equal(bad.status, 400);
  });
  await test('/api/providers lists the four presets without leaking keys', async () => {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json();
    assert.deepEqual(r.providers.map((p) => p.id), ['minimax', 'nvidia', 'reflection', 'agnes']);
    assert.ok(!JSON.stringify(r).includes('"k"'));
  });
  await test('/api/provider-lookup answers from the table', async () => {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/provider-lookup?name=agnes&web=0`)).json();
    assert.equal(r.baseUrl, 'https://apihub.agnes-ai.com/v1');
  });
} finally {
  server.kill();
  mock.close();
}

console.log(`\n${passed} server tests passed`);
