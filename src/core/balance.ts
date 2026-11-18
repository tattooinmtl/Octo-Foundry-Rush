/**
 * Wave economy and the 5% power rule.
 *
 * The rule the whole economy is built around:
 *   requiredDps = totalWaveHp / waveDuration
 *   targetDps   = requiredDps * 1.05     <- the player must be able to field
 *                                          5% MORE damage than the wave needs.
 *
 * Tower price is derived from DPS (PRICE_PER_DPS), and the gold paid out by a
 * wave is derived from the same target budget, so gold income and tower power
 * can never drift apart. Everything else falls out of that equation.
 */

import { CREEP_TIERS } from './config';
import { PRESETS, type TowerSpec } from './towerDefs';

/** Gold cost per point of DPS. Sets the whole price ladder. */
export const PRICE_PER_DPS = 10;

/** Player power headroom over the wave requirement (the "5% more"). */
export const POWER_MARGIN = 1.05;

/** Extra income above the tower budget so the player can keep upgrading. */
export const INCOME_SLACK = 1.28;

export interface WavePlan {
  wave: number;
  count: number;
  hpPerCreep: number;
  totalHp: number;
  speed: number;
  spawnInterval: number;
  waveDuration: number;
  requiredDps: number;
  targetDps: number;
  towerBudget: number;
  goldIncome: number;
  killGold: number;
  waveBonus: number;
  armor: number;
}

/** How many waves make up one round. */
export const WAVES_PER_ROUND = 10;

/** Share of the towers' cost returned to the player when a round ends. */
export const ROUND_REFUND = 0.25;

/** Foe count grows this much per wave inside a round. */
export const FOE_RAMP_PER_WAVE = 0.1;

export function roundOf(wave: number): number {
  return Math.floor((wave - 1) / WAVES_PER_ROUND) + 1;
}

export function waveInRound(wave: number): number {
  return ((wave - 1) % WAVES_PER_ROUND) + 1;
}

/** True on the first wave of a round - the board is rebuilt here. */
export function isRoundStart(wave: number): boolean {
  return waveInRound(wave) === 1;
}

export function waveHp(wave: number): number {
  // Continuous growth across the whole run, so a round never gets easier
  // than the round before it.
  const exponent = Math.min(50, wave - 1);
  return Math.round(52 * Math.pow(1.16, exponent) + 8 * (roundOf(wave) - 1));
}

export function waveCount(wave: number): number {
  const r = roundOf(wave);
  const w = waveInRound(wave);
  // Base for the round, then 10% more foes than the previous wave inside it.
  const base = Math.min(26, 6 + 2.2 * (r - 1));
  return Math.max(3, Math.round(base * Math.pow(1 + FOE_RAMP_PER_WAVE, w - 1)));
}

export function waveSpeed(wave: number, pathLength = 26): number {
  // The road is long, so the creeps move faster: the kill window stays the
  // same length no matter how much road the wave has to cover.
  const base = Math.min(2.6, Math.max(0.9, pathLength / 26));
  return Math.min(base * 1.9, base * (1 + 0.035 * (wave - 1)));
}

export function waveArmor(wave: number): number {
  return Math.min(Math.floor(wave / 6), 7);
}

/**
 * @param wave        1-based wave number
 * @param pathLength  path length in world units (creeps walk this far)
 */
export function planWave(wave: number, pathLength: number): WavePlan {
  const count = waveCount(wave);
  const hpPerCreep = waveHp(wave);
  const totalHp = count * hpPerCreep;
  const speed = waveSpeed(wave, pathLength);
  const spawnInterval = Math.max(0.42, 0.92 - wave * 0.015);
  const traverseTime = pathLength / speed;
  const waveDuration = spawnInterval * count + traverseTime;

  const requiredDps = totalHp / waveDuration;
  const targetDps = requiredDps * POWER_MARGIN;
  const towerBudget = targetDps * PRICE_PER_DPS;

  const waveBonus = Math.round(25 + wave * 10);
  const goldIncome = Math.round(towerBudget * INCOME_SLACK);
  const killGold = Math.max(2, Math.round((goldIncome - waveBonus) / count));

  return {
    wave,
    count,
    hpPerCreep,
    totalHp,
    speed,
    spawnInterval,
    waveDuration,
    requiredDps,
    targetDps,
    towerBudget,
    goldIncome,
    killGold,
    waveBonus,
    armor: waveArmor(wave),
  };
}

/** Price a tower purely from its DPS so presets and forged towers stay balanced. */
export function priceFromDps(dps: number): number {
  return Math.max(60, Math.round((dps * PRICE_PER_DPS) / 5) * 5);
}

export function dpsOf(damage: number, fireRate: number, burst = 1): number {
  return damage * fireRate * burst;
}

/** Total sustained DPS of a tower list. */
export function playerDps(towers: { spec: TowerSpec; level: number }[]): number {
  let total = 0;
  for (const t of towers) {
    // Level 2 = x1.75, level 3 = x2.7 (multiplicative on the whole tower).
    const mult = t.level === 1 ? 1 : t.level === 2 ? 1.75 : 2.7;
    total += t.spec.dps * mult;
  }
  return total;
}

export interface BalanceRow {
  wave: number;
  totalHp: number;
  requiredDps: number;
  targetDps: number;
  goldIncome: number;
  cheapestTower: number;
}

export function balanceTable(pathLength: number, waves = 12): BalanceRow[] {
  const rows: BalanceRow[] = [];
  const cheapest = Math.min(...PRESETS.map((p) => priceFromDps(dpsOf(p.damage, p.fireRate, p.burst))));
  for (let w = 1; w <= waves; w++) {
    const p = planWave(w, pathLength);
    rows.push({
      wave: w,
      totalHp: p.totalHp,
      requiredDps: Math.round(p.requiredDps * 10) / 10,
      targetDps: Math.round(p.targetDps * 10) / 10,
      goldIncome: p.goldIncome,
      cheapestTower: cheapest,
    });
  }
  return rows;
}

/** How strongly a tier is present at a wave: 0 before minWave, ramping to 1 over 3 waves. */
export function tierPresence(tierIndex: number, wave: number): number {
  const t = CREEP_TIERS[tierIndex];
  if (!t || t.boss) return 0;
  if (wave < t.minWave) return 0;
  // Bulwarks used to be rare before wave 4; keep that early-game feel.
  if (t.id === 'tank' && wave < 4) return 0.3;
  return Math.min(1, (wave - t.minWave + 1) / 3);
}

/** Pick the creep tier for a spawn, weighted, with tougher kinds arriving later. */
export function pickTier(rand: number, wave: number): number {
  const weights = CREEP_TIERS.map((t, i) => t.weight * tierPresence(i, wave));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand * total;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    r -= weights[i];
    if (r <= 0) return i;
  }
  return 0;
}

/** Effective HP (body + shield) one wave slot of this tier is worth, in units of hpPerCreep. */
export function slotHpWeight(tierIndex: number): number {
  const t = CREEP_TIERS[tierIndex];
  return t.hpMult * (1 + t.shield) * t.group;
}

export interface SpawnEntry {
  /** Seconds after the wave starts. */
  at: number;
  tier: number;
}

/**
 * Build a wave's spawn list. Swarm slots spawn their fry in a tight cluster,
 * and the last wave of every round (from wave 10) ends with a Kraken boss,
 * which replaces enough regular slots to keep the wave's total HP - and so
 * the 5% power rule - in line.
 */
export function buildSpawnList(plan: WavePlan, rand: () => number = Math.random): SpawnEntry[] {
  const out: SpawnEntry[] = [];
  const bossIndex = CREEP_TIERS.findIndex((t) => t.boss);
  const boss = bossIndex >= 0 ? CREEP_TIERS[bossIndex] : null;
  const bossWave = !!boss && waveInRound(plan.wave) === WAVES_PER_ROUND && plan.wave >= boss.minWave;
  let slots = plan.count;
  if (bossWave && boss) slots = Math.max(3, slots - Math.ceil(slotHpWeight(bossIndex) * 0.6));

  for (let i = 0; i < slots; i++) {
    const tier = pickTier(rand(), plan.wave);
    const t = CREEP_TIERS[tier];
    for (let g = 0; g < t.group; g++) {
      out.push({ at: i * plan.spawnInterval + g * 0.22, tier });
    }
  }
  if (bossWave) out.push({ at: slots * plan.spawnInterval + 0.8, tier: bossIndex });
  return out.sort((a, b) => a.at - b.at);
}
