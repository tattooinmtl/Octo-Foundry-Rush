/**
 * Offline check of the brief-aware forge.
 * Run: node --import ./scripts/register-ts.mjs scripts/forge-test.ts
 */
import { localForge } from '../src/core/forge.ts';

const used: any[] = [
  { name: 'Iron Cannon', damageType: 'kinetic', projectileShape: 'shell', color: '#ff8a3d' },
  { name: 'Rimechain Pylon', damageType: 'cryovoltic', projectileShape: 'frost-helix', color: '#b388ff' },
];

const briefs = [
  'a tower that lobs burning oil in an arc and sets a wide fire trail along the road',
  'something that freezes everything it touches solid',
  'a tower that chains lightning between groups of creeps',
  'a sniper that pierces a whole line of enemies',
  'a vacuum that pulls enemies together',
];

for (const brief of briefs) {
  const { spec } = localForge(used, brief);
  console.log(
    `"${brief.slice(0, 42)}..."\n   -> ${spec.name} | ${spec.damageType} | ${spec.effect} | ${spec.projectileShape} | dps ${spec.dps.toFixed(1)}`,
  );
}

// The fallback must never repeat an existing name, damage type or colour.
const all = [...used];
for (let i = 0; i < 30; i++) {
  const { spec } = localForge(all, briefs[i % briefs.length]);
  const names = new Set(all.map((u) => u.name.toLowerCase()));
  const types = new Set(all.map((u) => u.damageType.toLowerCase()));
  const colors = new Set(all.map((u) => u.color.toLowerCase()));
  if (names.has(spec.name.toLowerCase())) throw new Error(`repeated name ${spec.name}`);
  if (types.has(spec.damageType.toLowerCase())) throw new Error(`repeated damage type ${spec.damageType}`);
  if (colors.has('#' + spec.color.toString(16).padStart(6, '0'))) throw new Error('repeated colour');
  all.push({ name: spec.name, damageType: spec.damageType, projectileShape: spec.projectileShape, color: '#' + spec.color.toString(16).padStart(6, '0') });
}
console.log('\n30 offline forges: no repeated name, damage type or colour');

/* ------------------------------------------------------------------ */
/* Reliability checks for the client forge (mocked server)             */
/* ------------------------------------------------------------------ */
import assert from 'node:assert/strict';
import { forgeTower, classify, isUsableTower } from '../src/core/forge.ts';
import { PROJECTILE_SHAPES } from '../src/core/towerDefs.ts';

// Every built-in silhouette used: the fallback must still invent a new one.
const allShapes = PROJECTILE_SHAPES.map((s, i) => ({ name: `T${i}`, damageType: `d${i}`, projectileShape: s, color: `#0000${(i + 16).toString(16)}` }));
const { spec: odd } = localForge(allShapes, '');
assert.ok(!PROJECTILE_SHAPES.includes(odd.projectileShape as any), `fallback shape is new (${odd.projectileShape})`);

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const goodTower = { name: 'Hush Engine', damageType: 'sonic', effect: 'stun', damage: 20, fireRate: 1, range: 4, burst: 1, projectileShape: 'pulse', color: '#abcdef' };

const r1 = await forgeTower({ used, fetchImpl: async () => jsonRes(200, { tower: goodTower }) });
assert.equal(r1.source, 'ai');
assert.equal(r1.spec.name, 'Hush Engine');

const r2 = await forgeTower({ used, providerName: 'NVIDIA', fetchImpl: async () => jsonRes(401, { error: 'bad key', kind: 'auth' }) });
assert.equal(r2.source, 'local');
assert.equal(r2.reason, 'NVIDIA REJECTED THE API KEY');

const r3 = await forgeTower({ used, fetchImpl: async () => jsonRes(200, { tower: { nope: true } }) });
assert.equal(r3.source, 'local', 'broken server answer falls back');

const r4 = await forgeTower({
  used,
  providerName: 'REFLECTION',
  timeoutMs: 50,
  fetchImpl: (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
});
assert.equal(r4.source, 'local');
assert.equal(r4.reason, 'REFLECTION TIMED OUT', 'a hung server no longer leaves the forge spinning forever');

const r5 = await forgeTower({ used, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
assert.equal(r5.reason, 'THE FORGE IS UNREACHABLE');

// The caller's own cancel is passed through, not swallowed.
const ctrl = new AbortController();
const p6 = forgeTower({
  used,
  signal: ctrl.signal,
  fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
});
ctrl.abort();
await assert.rejects(p6);

assert.equal(classify('', 429, 'quota', 'MINIMAX'), 'MINIMAX QUOTA REACHED');
assert.equal(classify('', 503, 'nokey'), 'NO API KEY ON THE SERVER');
assert.equal(classify('', 504, 'timeout', 'AGNES'), 'AGNES TIMED OUT');
assert.equal(classify('', 400, 'config'), 'CHECK THE PROVIDER SETTINGS');
assert.equal(isUsableTower(null), false);
assert.equal(isUsableTower(goodTower), true);
console.log('client forge: timeout, auth, broken-answer and offline fallbacks OK');
