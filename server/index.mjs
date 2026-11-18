/**
 * OCTO FOUNDRY server.
 *
 * - Dev mode (--dev): Vite in middleware mode, so one port serves the game and
 *   the API. Phone connects over the LAN.
 * - Prod mode: serves the built dist/ folder plus the same API.
 *
 * Provider API keys live here (env MINIMAX_API_KEY, NVIDIA_API_KEY,
 * REFLECTION_API_KEY, AGNES_API_KEY, CUSTOM_API_KEY or .env) and are never
 * sent to the browser. A key pasted into the in-game Settings is forwarded
 * per-request via the x-api-key header and is not stored on the server.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  PROVIDERS,
  CUSTOM_PROVIDER_ID,
  providerById,
  validateApiKey,
} from '../shared/providers.mjs';
import {
  SYSTEM_PROMPT,
  buildPrompt,
  extractJson,
  finaliseTower,
  repairTower,
  sanitiseBrief,
  sanitiseModel,
  sanitiseUsed,
  stripThinking,
  validateTower,
} from './forge-core.mjs';
import { LlmError, assertPublicUrl, chatOnce, withRetry } from './llm-client.mjs';
import { findEndpoint, probeEndpoint } from './endpoint-finder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || (DEV ? 5173 : 3000));

dotenv.config({ path: path.join(ROOT, '.env') });

const DEFAULT_PROVIDER_ID = providerById(process.env.FORGE_PROVIDER || '') ? process.env.FORGE_PROVIDER : 'minimax';
const DEFAULT_MODEL =
  (DEFAULT_PROVIDER_ID === 'minimax' ? process.env.MINIMAX_MODEL : process.env[`${DEFAULT_PROVIDER_ID.toUpperCase()}_MODEL`]) ||
  providerById(DEFAULT_PROVIDER_ID).defaultModel;

const app = express();
app.use(express.json({ limit: '256kb' }));
// Long provider keys (Reflection keys are ~3x a normal key) travel in the
// x-api-key header; Node's default 16 KB header limit leaves plenty of room
// and validateApiKey() caps them at MAX_API_KEY_LENGTH.

/* ------------------------------------------------------------------ */
/* Providers                                                          */
/* ------------------------------------------------------------------ */

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_PROVIDER_URLS === '1';
const FORGE_TIMEOUT_MS = Math.max(5000, Number(process.env.FORGE_TIMEOUT_MS) || 45000);
const FORGE_RETRIES = Math.min(5, Math.max(0, Number(process.env.FORGE_RETRIES ?? 2)));

/** Server-side key for a provider, from the environment / .env. */
function envKeyFor(providerId) {
  if (providerId === CUSTOM_PROVIDER_ID) return process.env.CUSTOM_API_KEY || '';
  const p = providerById(providerId);
  return p ? process.env[p.envKey] || '' : '';
}

/**
 * Resolve which endpoint a request should hit. Preset providers always use
 * the registry URL (the client cannot redirect them); a custom provider uses
 * the base URL the player typed, after an SSRF check.
 */
async function resolveProvider(body, headerKey) {
  const providerId = String(body?.provider || DEFAULT_PROVIDER_ID);
  const keyCheck = validateApiKey(headerKey);
  if (!keyCheck.ok) throw new LlmError(`API key rejected: ${keyCheck.problem}`, { kind: 'config' });

  if (providerId === CUSTOM_PROVIDER_ID) {
    const custom = body?.custom ?? {};
    const baseUrl = String(custom.baseUrl || process.env.CUSTOM_BASE_URL || '').trim();
    const compat = (custom.compat || process.env.CUSTOM_COMPAT) === 'anthropic' ? 'anthropic' : 'openai';
    if (!baseUrl) throw new LlmError('The custom provider has no base URL. Fill it in under Settings.', { kind: 'config' });
    await assertPublicUrl(baseUrl, { allowPrivate: ALLOW_PRIVATE });
    const model = sanitiseModel(body?.model || custom.model || process.env.CUSTOM_MODEL, '');
    if (!model) throw new LlmError('The custom provider has no model name.', { kind: 'config' });
    return { id: CUSTOM_PROVIDER_ID, label: String(custom.name || 'Custom').slice(0, 40), baseUrl, compat, model, apiKey: keyCheck.key || envKeyFor(CUSTOM_PROVIDER_ID) };
  }

  const preset = providerById(providerId);
  if (!preset) throw new LlmError(`Unknown provider "${providerId}"`, { kind: 'config' });
  // MINIMAX_API_HOST stays supported for existing .env files.
  const baseUrl = preset.id === 'minimax' && process.env.MINIMAX_API_HOST
    ? `${process.env.MINIMAX_API_HOST.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
    : preset.baseUrl;
  const envModel = preset.id === 'minimax' ? process.env.MINIMAX_MODEL : process.env[`${preset.id.toUpperCase()}_MODEL`];
  const model = sanitiseModel(body?.model, '') || sanitiseModel(envModel, '') || preset.defaultModel;
  return { id: preset.id, label: preset.label, baseUrl, compat: preset.compat, model, apiKey: keyCheck.key || envKeyFor(preset.id) };
}

app.get('/api/providers', (_req, res) => {
  res.json({
    defaultProvider: DEFAULT_PROVIDER_ID,
    providers: PROVIDERS.map((p) => ({ ...p, keyPresent: !!envKeyFor(p.id) })),
    custom: { keyPresent: !!envKeyFor(CUSTOM_PROVIDER_ID) },
    allowPrivate: ALLOW_PRIVATE,
  });
});

/** SEARCH button: suggest a base URL + compatibility for a service name. */
app.get('/api/provider-lookup', async (req, res) => {
  const name = String(req.query.name ?? '').slice(0, 80);
  try {
    const result = await findEndpoint(name, { web: req.query.web !== '0', probe: req.query.probe !== '0', allowPrivate: ALLOW_PRIVATE });
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: `Lookup failed: ${err.message}` });
  }
});

/** TEST button: does this endpoint answer, and does the key work? */
app.post('/api/provider-test', async (req, res) => {
  try {
    const p = await resolveProvider(req.body, req.get('x-api-key'));
    const probe = await probeEndpoint(p.baseUrl, p.compat, { allowPrivate: ALLOW_PRIVATE });
    let chat = null;
    if (p.apiKey) {
      try {
        const out = await chatOnce({ ...p, system: 'Reply with the single word OK.', prompt: 'ping', maxTokens: 400, temperature: 0, timeoutMs: 20000 });
        chat = { ok: true, sample: out.text.slice(0, 80) };
      } catch (err) {
        chat = { ok: false, error: err.message.slice(0, 300), kind: err.kind };
      }
    }
    res.json({ ok: true, provider: p.id, baseUrl: p.baseUrl, compat: p.compat, model: p.model, keyPresent: !!p.apiKey, probe, chat });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Tower forge                                                        */
/* ------------------------------------------------------------------ */

function forgeErrorStatus(err) {
  if (err.kind === 'config') return 400;
  if (err.kind === 'auth') return 401;
  if (err.kind === 'quota' || err.kind === 'rate') return 429;
  if (err.kind === 'timeout') return 504;
  return 502;
}

app.post('/api/forge', async (req, res) => {
  let provider;
  try {
    provider = await resolveProvider(req.body, req.get('x-api-key'));
  } catch (err) {
    res.status(400).json({ error: err.message, kind: err.kind ?? 'config' });
    return;
  }
  if (!provider.apiKey) {
    res.status(503).json({
      error: `No API key for ${provider.label}. Set ${providerById(provider.id)?.envKey ?? 'CUSTOM_API_KEY'} in .env or paste one in Settings.`,
      kind: 'nokey',
      provider: provider.id,
    });
    return;
  }

  const used = sanitiseUsed(req.body?.used);
  const brief = sanitiseBrief(req.body?.brief);
  const attempts = Math.min(4, Math.max(1, Number(req.body?.attempts) || 3));

  // Stop working if the player closes the tab.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let lastProblems = [];
  let lastRaw = '';
  let lastTower = null;
  for (let i = 0; i < attempts; i++) {
    const note = i === 0 ? '' : lastProblems.join('; ');
    const prompt = buildPrompt(used, note, brief);
    let raw = '';
    let finishReason = '';
    try {
      const out = await withRetry(
        () => chatOnce({ ...provider, system: SYSTEM_PROMPT, prompt, maxTokens: 3000, temperature: i === 0 ? 1 : 0.9, timeoutMs: FORGE_TIMEOUT_MS, signal: abort.signal }),
        {
          retries: FORGE_RETRIES,
          signal: abort.signal,
          onRetry: (err, n, wait) => console.log(`[forge] ${provider.id} transient failure (${err.message.slice(0, 120)}), retry ${n} in ${wait} ms`),
        },
      );
      raw = out.text;
      finishReason = out.finishReason;
    } catch (err) {
      if (abort.signal.aborted) return;
      const e = err instanceof LlmError ? err : new LlmError(String(err?.message ?? err));
      // A usable answer from an earlier attempt beats an error now.
      if (lastTower) break;
      res.status(forgeErrorStatus(e)).json({ error: `${provider.label} call failed: ${e.message}`, kind: e.kind, provider: provider.id });
      return;
    }

    const tower = extractJson(raw);
    const check = validateTower(tower, used);
    if (check.ok || (tower && !check.hard)) {
      // Only cosmetic clashes (colour/silhouette) - patch locally, no extra call.
      const fixed = check.ok ? tower : repairTower(tower, used);
      res.json({ tower: finaliseTower(fixed), model: provider.model, provider: provider.id, attempt: i + 1, repaired: !check.ok });
      return;
    }
    if (tower) lastTower = tower;
    lastProblems = check.problems;
    lastRaw = stripThinking(raw).slice(0, 400);
    console.log(`[forge] attempt ${i + 1} rejected (finish=${finishReason}): ${check.problems.join('; ')}`);
  }

  if (lastTower) {
    // Out of attempts but the model did answer: make it unique and ship it.
    res.json({ tower: finaliseTower(repairTower(lastTower, used)), model: provider.model, provider: provider.id, attempt: attempts, repaired: true });
    return;
  }
  console.log(`[forge] rejected raw: ${lastRaw}`);
  res.status(422).json({ error: 'The model never returned a usable tower.', kind: 'invalid', problems: lastProblems, raw: lastRaw });
});

app.get('/api/health', async (_req, res) => {
  const p = providerById(DEFAULT_PROVIDER_ID);
  const keyPresent = !!envKeyFor(DEFAULT_PROVIDER_ID);
  let models = [];
  if (keyPresent && p) {
    try {
      const r = await fetch(`${p.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${envKeyFor(DEFAULT_PROVIDER_ID)}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const j = await r.json();
        models = (j?.data ?? []).map((m) => m.id);
      }
    } catch {
      models = [];
    }
  }
  res.json({
    keyPresent,
    provider: DEFAULT_PROVIDER_ID,
    model: DEFAULT_MODEL,
    models,
    keys: Object.fromEntries([...PROVIDERS.map((x) => x.id), CUSTOM_PROVIDER_ID].map((id) => [id, !!envKeyFor(id)])),
  });
});

/* ------------------------------------------------------------------ */
/* Static + dev server                                                */
/* ------------------------------------------------------------------ */

if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: ROOT,
    server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('dist/ not found - run "npm run build" first.');
  }
  // Hashed assets are safe to cache hard; index.html must never be cached or
  // the browser keeps running an old bundle.
  app.use(express.static(dist, { maxAge: '1y', immutable: true, etag: true, index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    // Express 5 + send cannot resolve an absolute Windows path here, so the
    // file is addressed through `root`.
    res.sendFile('index.html', { root: dist });
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  OCTO FOUNDRY  ${DEV ? '[dev]' : '[build]'}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://0.0.0.0:${PORT}  (phone on the same LAN)`);
  for (const p of PROVIDERS) {
    console.log(`  ${p.label.padEnd(30)} key: ${envKeyFor(p.id) ? 'loaded' : `not set (${p.envKey})`}`);
  }
  console.log(`  Default forge: ${DEFAULT_PROVIDER_ID} · ${DEFAULT_MODEL}\n`);
});
