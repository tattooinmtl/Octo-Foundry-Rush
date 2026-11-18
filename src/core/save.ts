/**
 * Save-game format, validation and migration. Pure - no DOM, no three.js -
 * so the round trip is unit-tested in scripts/save-test.ts.
 *
 * v1 (original): { seed, gold, score, wave, lives, towers[] } where `seed`
 *   was the CURRENT ROAD's seed. It lost the run seed (later rounds then got
 *   the wrong roads), the forge count, the round spend and anything mid-wave.
 * v2: everything needed to resume exactly, including live creeps (with their
 *   kind, HP and shield) and the rest of the wave's spawn queue.
 */

import { AI_EFFECTS, PRESETS, type EffectId, type TowerSpec } from './towerDefs';
import { CREEP_TIERS, FORGE_LIMIT, START_LIVES, type WeaponId } from './config';
import { roundOf } from './balance';
import type { EnemySnapshot } from './enemies';

export const SAVE_VERSION = 2;
/** localStorage key (name kept from v1 so old saves are found and migrated). */
export const SAVE_KEY = 'octo-foundry-save-v1';
/** Where an unreadable save is parked instead of being silently overwritten. */
export const CORRUPT_SAVE_KEY = 'octo-foundry-save-corrupt';
/** Same constant the game uses to derive each round's road seed. */
export const ROUND_SEED_STEP = 104729;

const WEAPON_IDS: WeaponId[] = ['dynamite', 'laser', 'freeze', 'hellfire'];
const MAX_TOWERS = 400;
const MAX_ENEMIES = 600;

export interface SavedTower {
  padId: string;
  presetId: string;
  /** Full spec for forged towers; presets are rebuilt from PRESETS. */
  spec?: TowerSpec;
  level: number;
}

export interface SaveData {
  version: typeof SAVE_VERSION;
  savedAt: number;
  runSeed: number;
  pathSeed: number;
  gold: number;
  score: number;
  wave: number;
  lives: number;
  roundTowerSpend: number;
  forgedCount: number;
  cooldowns: Record<WeaponId, number>;
  towers: SavedTower[];
  pendingForge: TowerSpec | null;
  waveActive: boolean;
  waveClock: number;
  spawnQueue: { at: number; kind: string }[];
  enemies: EnemySnapshot[];
  /** Creep kinds already announced this run. */
  seenKinds: string[];
}

export type ParseResult = { ok: true; data: SaveData; migrated: boolean } | { ok: false; error: string };

/** Road seed for a given round of a run (round 1 uses the run seed itself). */
export function roadSeedFor(runSeed: number, wave: number): number {
  const r = roundOf(Math.max(1, wave));
  return r <= 1 ? runSeed >>> 0 : (runSeed + r * ROUND_SEED_STEP) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Field validators                                                    */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function fin(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function int(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.round(fin(v, lo, hi, fallback));
}

function str(v: unknown, max: number, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

/** Rebuild a preset spec from the built-in table (presets are never stored in full). */
export function presetSpec(presetId: string): TowerSpec | null {
  const p = PRESETS.find((x) => x.presetId === presetId);
  if (!p) return null;
  const dps = p.damage * p.fireRate * p.burst;
  return {
    id: `t-${Math.random().toString(36).slice(2, 9)}`,
    kind: 'preset',
    presetId: p.presetId,
    name: p.name,
    damageType: p.damageType,
    effect: p.effect,
    damage: p.damage,
    fireRate: p.fireRate,
    range: p.range,
    burst: p.burst,
    projectileShape: p.projectileShape,
    color: p.color,
    impact: p.impact,
    sound: p.sound,
    mechanic: p.mechanic,
    price: Math.max(60, Math.round((dps * 10) / 5) * 5),
    dps,
  };
}

/** Validate a stored forged-tower spec; null when it is unusable. */
export function sanitiseSpec(raw: unknown): TowerSpec | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 40).trim();
  if (!name) return null;
  const damage = fin(raw.damage, 0.1, 2000, NaN);
  const fireRate = fin(raw.fireRate, 0.05, 20, NaN);
  if (!Number.isFinite(damage) || !Number.isFinite(fireRate)) return null;
  const burst = int(raw.burst, 1, 6, 1);
  const effect: EffectId = AI_EFFECTS.includes(raw.effect) ? raw.effect : 'none';
  return {
    id: str(raw.id, 60) || `ai-${Math.random().toString(36).slice(2, 9)}`,
    kind: raw.kind === 'preset' ? 'preset' : 'ai',
    presetId: str(raw.presetId, 40, 'ai') || 'ai',
    name,
    damageType: str(raw.damageType, 40, 'exotic') || 'exotic',
    effect,
    damage,
    fireRate,
    range: fin(raw.range, 1, 12, 4),
    burst,
    projectileShape: str(raw.projectileShape, 30, 'orb').replace(/[^a-z0-9-]/gi, '') || 'orb',
    color: int(raw.color, 0, 0xffffff, 0xffffff),
    impact: str(raw.impact, 200),
    sound: str(raw.sound, 200),
    mechanic: str(raw.mechanic, 260),
    price: int(raw.price, 1, 100000, 180),
    dps: damage * fireRate * burst,
  };
}

function sanitiseTower(raw: unknown): SavedTower | null {
  if (!isObj(raw)) return null;
  const padId = str(raw.padId, 40);
  if (!/^pad-\d+-\d+$/.test(padId)) return null;
  const presetId = str(raw.presetId, 40);
  const level = int(raw.level, 1, 3, 1);
  if (raw.spec !== undefined && raw.spec !== null) {
    const spec = sanitiseSpec(raw.spec);
    if (!spec) return null;
    return { padId, presetId: spec.presetId, spec, level };
  }
  if (!PRESETS.some((p) => p.presetId === presetId)) return null;
  return { padId, presetId, level };
}

function sanitiseEnemy(raw: unknown): EnemySnapshot | null {
  if (!isObj(raw)) return null;
  // v2 stores the kind id; accept a numeric tier index too.
  const kind = typeof raw.kind === 'string' ? raw.kind : typeof raw.tier === 'number' ? CREEP_TIERS[raw.tier]?.id : undefined;
  if (!kind || !CREEP_TIERS.some((t) => t.id === kind)) return null;
  const maxHp = fin(raw.maxHp, 1, 1e9, NaN);
  const hp = fin(raw.hp, 0, 1e9, NaN);
  if (!Number.isFinite(maxHp) || !Number.isFinite(hp) || hp <= 0) return null;
  const maxShield = fin(raw.maxShield, 0, 1e9, 0);
  return {
    kind,
    hp: Math.min(hp, maxHp),
    maxHp,
    shield: Math.min(fin(raw.shield, 0, 1e9, 0), maxShield),
    maxShield,
    armor: fin(raw.armor, 0, 100, 0),
    baseSpeed: fin(raw.baseSpeed, 0.05, 20, 1),
    distance: fin(raw.distance, 0, 1e4, 0),
    volatile: raw.volatile === true,
  };
}

/* ------------------------------------------------------------------ */
/* Parse / migrate                                                     */
/* ------------------------------------------------------------------ */

/** v1 -> v2. The v1 `seed` was the road of the round being played. */
export function migrateV1(raw: Record<string, any>): Record<string, any> {
  const wave = int(raw.wave, 0, 100000, 0);
  const round = roundOf(Math.max(1, wave));
  const pathSeed = int(raw.seed, 0, 0xffffffff, 0) >>> 0;
  const runSeed = round <= 1 ? pathSeed : (pathSeed - round * ROUND_SEED_STEP) >>> 0;
  const towers = Array.isArray(raw.towers) ? raw.towers : [];
  return {
    version: SAVE_VERSION,
    savedAt: 0,
    runSeed,
    pathSeed,
    gold: raw.gold,
    score: raw.score,
    wave,
    lives: raw.lives,
    roundTowerSpend: 0,
    // v1 forgot how many towers were forged; count the forged towers on the board.
    forgedCount: towers.filter((t: any) => isObj(t) && isObj(t.spec)).length,
    cooldowns: {},
    towers,
    pendingForge: null,
    waveActive: false,
    waveClock: 0,
    spawnQueue: [],
    enemies: [],
    seenKinds: [],
  };
}

/**
 * Parse and validate a stored save. Never throws. Invalid towers/creeps are
 * dropped individually; a save with broken core fields is rejected whole so a
 * half-loaded run can never replace the current one.
 */
export function parseSave(text: string | null | undefined): ParseResult {
  if (!text) return { ok: false, error: 'no save found' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'save is not valid JSON' };
  }
  if (!isObj(raw)) return { ok: false, error: 'save is not an object' };

  let migrated = false;
  let r: Record<string, any> = raw;
  const version = raw.version === undefined ? 1 : Number(raw.version);
  if (version === 1) {
    r = migrateV1(raw);
    migrated = true;
  } else if (version !== SAVE_VERSION) {
    return { ok: false, error: `save version ${String(raw.version)} is not supported` };
  }

  for (const key of ['gold', 'score', 'wave', 'lives'] as const) {
    if (!Number.isFinite(Number(r[key]))) return { ok: false, error: `save is missing "${key}"` };
  }
  const pathSeedRaw = Number(r.pathSeed);
  const runSeedRaw = Number(r.runSeed);
  if (!Number.isFinite(pathSeedRaw) || !Number.isFinite(runSeedRaw)) return { ok: false, error: 'save is missing its map seed' };
  const lives = int(r.lives, 0, 999, START_LIVES);
  if (lives <= 0) return { ok: false, error: 'that run was already lost' };

  const towers: SavedTower[] = [];
  const pads = new Set<string>();
  for (const t of (Array.isArray(r.towers) ? r.towers : []).slice(0, MAX_TOWERS)) {
    const tower = sanitiseTower(t);
    if (!tower || pads.has(tower.padId)) continue;
    pads.add(tower.padId);
    towers.push(tower);
  }

  const cooldowns = {} as Record<WeaponId, number>;
  for (const id of WEAPON_IDS) cooldowns[id] = fin(isObj(r.cooldowns) ? r.cooldowns[id] : 0, 0, 600, 0);

  const enemies = (Array.isArray(r.enemies) ? r.enemies : [])
    .slice(0, MAX_ENEMIES)
    .map(sanitiseEnemy)
    .filter((e: EnemySnapshot | null): e is EnemySnapshot => !!e);

  const spawnQueue = (Array.isArray(r.spawnQueue) ? r.spawnQueue : [])
    .slice(0, MAX_ENEMIES)
    .filter((s: any) => isObj(s) && typeof s.kind === 'string' && CREEP_TIERS.some((t) => t.id === s.kind))
    .map((s: any) => ({ at: fin(s.at, 0, 1e5, 0), kind: s.kind as string }))
    .sort((a: { at: number }, b: { at: number }) => a.at - b.at);

  const wave = int(r.wave, 0, 100000, 0);
  // Mid-wave state is only meaningful if a wave had actually started.
  const waveActive = r.waveActive === true && wave > 0 && (enemies.length > 0 || spawnQueue.length > 0);

  const data: SaveData = {
    version: SAVE_VERSION,
    savedAt: fin(r.savedAt, 0, 1e15, 0),
    runSeed: runSeedRaw >>> 0,
    pathSeed: pathSeedRaw >>> 0,
    gold: int(r.gold, 0, 1e9, 0),
    score: int(r.score, 0, 1e12, 0),
    wave,
    lives,
    roundTowerSpend: int(r.roundTowerSpend, 0, 1e9, 0),
    forgedCount: int(r.forgedCount, 0, FORGE_LIMIT, 0),
    cooldowns,
    towers,
    pendingForge: r.pendingForge ? sanitiseSpec(r.pendingForge) : null,
    waveActive,
    waveClock: waveActive ? fin(r.waveClock, 0, 1e5, 0) : 0,
    spawnQueue: waveActive ? spawnQueue : [],
    enemies: waveActive ? enemies : [],
    seenKinds: (Array.isArray(r.seenKinds) ? r.seenKinds : []).filter((k: unknown) => typeof k === 'string').slice(0, 50),
  };
  return { ok: true, data, migrated };
}

export function serializeSave(data: Omit<SaveData, 'version'>): string {
  return JSON.stringify({ ...data, version: SAVE_VERSION });
}
