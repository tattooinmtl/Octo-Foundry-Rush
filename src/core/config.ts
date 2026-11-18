/**
 * Global world + palette constants for OCTO FOUNDRY.
 * Pure data module: no three.js import so balance/audio/path can use it freely.
 */

export const COLS = 9;
export const ROWS = 16;
export const CELL = 1;

export const WORLD_W = COLS * CELL;
export const WORLD_H = ROWS * CELL;

/** Grid cell -> world coordinate (grid is centred on the origin). */
export function cellToWorld(col: number, row: number): { x: number; z: number } {
  return {
    x: (col - (COLS - 1) / 2) * CELL,
    z: (row - (ROWS - 1) / 2) * CELL,
  };
}

export const COLORS = {
  steel: 0x8d959e,
  darkSteel: 0x24282e,
  chrome: 0xe4ecf5,
  hazard: 0xf5c518,
  hazardDark: 0x141414,
  concrete: 0x3f444b,
  concreteDark: 0x2a2e34,
  danger: 0xffd21e,
  blood: 0x8e2742,
  gold: 0xffcc33,
} as const;

/** Fixed simulation step for deterministic feel. */
export const FIXED_DT = 1 / 60;

/** Road geometry */
export const ROAD_HALF_WIDTH = 0.42;

/** Build pad geometry */
export const PAD_RADIUS = 0.3;

/** Lives at the start of a run. */
export const START_LIVES = 20;

/** Starting gold so wave 1 can be answered immediately. */
export const START_GOLD = 260;

/** Gold returned when a tower is sold. */
export const SELL_REFUND = 0.7;

/** Cost of one dynamite charge. */
export const DYNAMITE_BASE_COST = 70;

/** Dynamite damage scales with wave number. */
export const DYNAMITE_BASE_DAMAGE = 92;
export const DYNAMITE_DAMAGE_PER_WAVE = 26;

/** Dynamite blast radius in world units. */
export const DYNAMITE_RADIUS = 1.9;

/** Cost of forging an AI tower (flat, so the player pays for novelty). */
export const FORGE_COST = 180;

/** How many AI towers may be forged per run. */
export const FORGE_LIMIT = 12;

/** Enemy archetypes: ratio of wave spawns and per-creep multipliers. */
export interface CreepTier {
  id: string;
  weight: number;
  hpMult: number;
  speedMult: number;
  armor: number;
  color: number;
  scale: number;
  label: string;
}

export const CREEP_TIERS: CreepTier[] = [
  { id: 'grunt', weight: 0.62, hpMult: 1.0, speedMult: 1.0, armor: 0, color: 0x9b6ad6, scale: 1.0, label: 'Drifter' },
  { id: 'runner', weight: 0.2, hpMult: 0.62, speedMult: 1.42, armor: 0, color: 0xe05fa8, scale: 0.82, label: 'Skitter' },
  { id: 'tank', weight: 0.18, hpMult: 1.85, speedMult: 0.78, armor: 5, color: 0x3f7fd4, scale: 1.28, label: 'Bulwark' },
];

/** Total run lives lost per leak depends on the creep tier. */
export const LEAK_COST = 1;

/* ------------------------------------------------------------------ */
/* Special weapons (all scale off the dynamite damage curve)           */
/* ------------------------------------------------------------------ */

export type WeaponId = 'dynamite' | 'laser' | 'freeze' | 'hellfire';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Gold = base + perWave * wave. */
  baseCost: number;
  costPerWave: number;
  /** Seconds before it can be used again (game time). */
  cooldown: number;
  /** Targeting circle radius in world units. */
  radius: number;
  /** Targeting circle colour. */
  color: number;
  blurb: string;
}

export const WEAPONS: WeaponDef[] = [
  {
    id: 'dynamite',
    name: 'Dynamite',
    baseCost: DYNAMITE_BASE_COST,
    costPerWave: 6,
    cooldown: 0,
    radius: DYNAMITE_RADIUS,
    color: 0xff7a2a,
    blurb: 'Fused charge on the road. Big blast.',
  },
  {
    id: 'laser',
    name: 'Orbital Laser',
    baseCost: 130,
    costPerWave: 10,
    cooldown: 18,
    radius: 1.15,
    color: 0xff2a6a,
    blurb: '3s beam from orbit. Ignores armour.',
  },
  {
    id: 'freeze',
    name: 'Deep Freeze',
    baseCost: 90,
    costPerWave: 5,
    cooldown: 15,
    radius: 2.0,
    color: 0x7fdcff,
    blurb: 'Encases every foe in the zone for 4s.',
  },
  {
    id: 'hellfire',
    name: 'Hellfire',
    baseCost: 110,
    costPerWave: 7,
    cooldown: 16,
    radius: 1.9,
    color: 0xff5a1a,
    blurb: 'Meteor strike. Zone burns for 4s.',
  },
];

/** Orbital laser: total damage per foe across the 3s beam = this x dynamite. */
export const LASER_DURATION = 3;
export const LASER_DAMAGE_MULT = 2.25;
export const FREEZE_SECONDS = 4;
export const HELLFIRE_SECONDS = 4;
/** Hellfire zone dps as a share of a dynamite hit, plus an ignite after. */
export const HELLFIRE_DPS_MULT = 0.32;
