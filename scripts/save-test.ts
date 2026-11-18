/**
 * Save/load: round trip, v1 migration, corrupted saves.
 * Run: node --import ./scripts/register-ts.mjs scripts/save-test.ts
 */
import assert from 'node:assert/strict';
import { parseSave, serializeSave, roadSeedFor, presetSpec, ROUND_SEED_STEP, SAVE_VERSION, type SaveData } from '../src/core/save.ts';
import { generatePath } from '../src/core/path.ts';
import { FORGE_LIMIT } from '../src/core/config.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const forged = {
  id: 'ai-x1',
  kind: 'ai' as const,
  presetId: 'ai',
  name: 'Gravity Loom',
  damageType: 'gravity',
  effect: 'pull' as const,
  damage: 12.5,
  fireRate: 1.4,
  range: 4.2,
  burst: 2,
  projectileShape: 'singing-lattice',
  color: 0x7c4dff,
  impact: 'A thrum.',
  sound: 'A hum.',
  mechanic: 'Pulls.',
  price: 180,
  dps: 35,
};

function sample(): Omit<SaveData, 'version'> {
  return {
    savedAt: 1763475000000,
    runSeed: 987654321,
    pathSeed: roadSeedFor(987654321, 14),
    gold: 512,
    score: 4321,
    wave: 14,
    lives: 17,
    roundTowerSpend: 640,
    forgedCount: 2,
    cooldowns: { dynamite: 0, laser: 7.5, freeze: 0, hellfire: 3 },
    towers: [
      { padId: 'pad-1-2', presetId: 'cannon', level: 2 },
      { padId: 'pad-4-7', presetId: 'ai', spec: forged, level: 3 },
    ],
    pendingForge: { ...forged, id: 'ai-x2', name: 'Spare Loom', color: 0x123456 },
    waveActive: true,
    waveClock: 6.25,
    spawnQueue: [
      { at: 7, kind: 'swarm' },
      { at: 7.22, kind: 'swarm' },
      { at: 9, kind: 'skyguard' },
    ],
    enemies: [
      { kind: 'leaper', hp: 80, maxHp: 120, shield: 0, maxShield: 0, armor: 2, baseSpeed: 1.6, distance: 12.5, volatile: false },
      { kind: 'shielded', hp: 90, maxHp: 90, shield: 20, maxShield: 54, armor: 2, baseSpeed: 1.4, distance: 4, volatile: true },
      { kind: 'flyer', hp: 50, maxHp: 70, shield: 0, maxShield: 0, armor: 2, baseSpeed: 1.7, distance: 20, volatile: false },
    ],
    seenKinds: ['grunt', 'leaper', 'flyer'],
  };
}

console.log('save/load');

test('round trip keeps every field, including new creep kinds mid-wave', () => {
  const src = sample();
  const parsed = parseSave(serializeSave(src));
  assert.ok(parsed.ok, !parsed.ok ? parsed.error : '');
  if (!parsed.ok) return;
  assert.equal(parsed.migrated, false);
  const d = parsed.data;
  assert.equal(d.version, SAVE_VERSION);
  for (const k of ['runSeed', 'pathSeed', 'gold', 'score', 'wave', 'lives', 'roundTowerSpend', 'forgedCount', 'waveActive', 'waveClock'] as const) {
    assert.equal(d[k], src[k], k);
  }
  assert.deepEqual(d.cooldowns, src.cooldowns);
  assert.deepEqual(d.enemies, src.enemies);
  assert.deepEqual(d.spawnQueue, src.spawnQueue);
  assert.deepEqual(d.seenKinds, src.seenKinds);
  assert.equal(d.towers.length, 2);
  assert.equal(d.towers[1].spec?.name, 'Gravity Loom');
  assert.equal(d.towers[1].level, 3);
  assert.equal(d.pendingForge?.name, 'Spare Loom');
  // Saving the loaded data again is stable.
  const again = parseSave(serializeSave(d));
  assert.ok(again.ok && JSON.stringify(again.data) === JSON.stringify(d));
});

test('road seed is reproducible from the run seed', () => {
  const s = sample();
  assert.equal(generatePath(s.pathSeed).length, generatePath(roadSeedFor(s.runSeed, s.wave)).length);
  assert.equal(roadSeedFor(5, 3), 5, 'round 1 uses the run seed');
  assert.equal(roadSeedFor(5, 11), (5 + 2 * ROUND_SEED_STEP) >>> 0);
});

test('v1 save migrates and recovers the run seed', () => {
  const runSeed = 424242;
  const v1 = {
    seed: roadSeedFor(runSeed, 23),
    gold: 300,
    score: 900,
    wave: 23,
    lives: 9,
    towers: [
      { padId: 'pad-0-0', presetId: 'tesla', level: 1 },
      { padId: 'pad-2-3', presetId: 'ai', spec: forged, level: 2 },
    ],
  };
  const parsed = parseSave(JSON.stringify(v1));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.data.runSeed, runSeed);
  assert.equal(parsed.data.pathSeed, v1.seed);
  assert.equal(parsed.data.forgedCount, 1, 'forged towers on the board count against the limit');
  assert.equal(parsed.data.towers.length, 2);
  assert.equal(parsed.data.waveActive, false);
  // Round 1 v1 save: path seed IS the run seed.
  const r1 = parseSave(JSON.stringify({ ...v1, wave: 4, seed: 77 }));
  assert.ok(r1.ok && r1.data.runSeed === 77);
});

test('corrupted saves are rejected without throwing', () => {
  const bad: [string | null, RegExp][] = [
    [null, /no save/],
    ['', /no save/],
    ['{"gold":', /JSON/],
    ['[1,2,3]', /object/],
    ['"hello"', /object/],
    [JSON.stringify({ ...sample(), version: 99 }), /version/],
    [JSON.stringify({ ...sample(), version: 2, gold: 'lots' }), /gold/],
    [JSON.stringify({ ...sample(), version: 2, pathSeed: undefined }), /seed/],
    [JSON.stringify({ ...sample(), version: 2, lives: 0 }), /lost/],
  ];
  for (const [text, re] of bad) {
    const r = parseSave(text);
    assert.equal(r.ok, false, String(text).slice(0, 40));
    if (!r.ok) assert.match(r.error, re);
  }
});

test('bad towers / creeps are dropped individually, values clamped', () => {
  const s: any = { ...sample(), version: 2 };
  s.towers = [
    { padId: 'pad-1-1', presetId: 'cannon', level: 99 },
    { padId: 'pad-1-1', presetId: 'tesla', level: 1 }, // duplicate pad
    { padId: 'not-a-pad', presetId: 'cannon', level: 1 },
    { padId: 'pad-2-2', presetId: 'does-not-exist', level: 1 },
    { padId: 'pad-3-3', presetId: 'ai', spec: { name: '' }, level: 1 },
    { padId: 'pad-4-4', presetId: 'ai', spec: { ...forged, damage: 'NaN', fireRate: 1 }, level: 1 },
    'garbage',
    null,
  ];
  s.enemies = [
    { kind: 'dragon', hp: 10, maxHp: 10 },
    { kind: 'boss', hp: -5, maxHp: 10 },
    { kind: 'swarm', hp: 500, maxHp: 10, shield: 99, maxShield: 0, distance: -3 },
  ];
  s.gold = -50;
  s.forgedCount = 999;
  const r = parseSave(JSON.stringify(s));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.data.towers.length, 1);
  assert.equal(r.data.towers[0].level, 3, 'level clamped to 3');
  assert.equal(r.data.enemies.length, 1);
  assert.equal(r.data.enemies[0].hp, 10, 'hp clamped to max');
  assert.equal(r.data.enemies[0].shield, 0);
  assert.equal(r.data.enemies[0].distance, 0);
  assert.equal(r.data.gold, 0);
  assert.equal(r.data.forgedCount, FORGE_LIMIT);
});

test('a wave with nothing left to fight is not resumed as active', () => {
  const s: any = { ...sample(), version: 2, enemies: [], spawnQueue: [] };
  const r = parseSave(JSON.stringify(s));
  assert.ok(r.ok && r.data.waveActive === false);
});

test('preset specs are rebuilt from the table', () => {
  const spec = presetSpec('sniper');
  assert.ok(spec && spec.kind === 'preset' && spec.dps > 0);
  assert.equal(presetSpec('nope'), null);
});

console.log(`\n${passed} save tests passed`);
