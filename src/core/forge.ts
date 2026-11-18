/**
 * AI tower forge.
 *
 * The Node server owns the MiniMax call (so the API key never reaches the
 * browser) and enforces the uniqueness rules: a forged tower must use a
 * damage type, projectile style and colour that no earlier tower used.
 * This module validates the answer and falls back to a local procedural
 * generator if the server cannot be reached, so the game never dead-ends.
 */

import { AI_EFFECTS, PROJECTILE_SHAPES, type EffectId, type TowerSpec } from './towerDefs';
import { FORGE_COST } from './config';

export interface UsedFingerprint {
  name: string;
  damageType: string;
  projectileShape: string;
  color: string;
}

export interface ForgeOptions {
  used: UsedFingerprint[];
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  /** What the player asked the forge to build. */
  brief?: string;
}

export class ForgeError extends Error {}

function hexToNumber(hex: string): number {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const v = parseInt(full, 16);
  return Number.isFinite(v) ? v : 0xffffff;
}

function numberToHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

export function fingerprintOf(spec: TowerSpec): UsedFingerprint {
  return {
    name: spec.name,
    damageType: spec.damageType,
    projectileShape: spec.projectileShape,
    color: numberToHex(spec.color),
  };
}

/** Balance band for a forged tower's DPS. The fee is fixed, so the power is
 *  normalised into this band instead of whatever the model invented. */
export const FORGE_DPS_MIN = 14;
export const FORGE_DPS_MAX = 38;

/** Clamp whatever the model returned into legal gameplay values. */
function normalise(raw: any, used: UsedFingerprint[]): TowerSpec {
  const name = String(raw?.name ?? 'Unknown Device').slice(0, 28).trim() || 'Unknown Device';
  const damageType = String(raw?.damageType ?? 'exotic').toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim() || 'exotic';
  // The AI may invent a silhouette the renderer has never seen - keep it.
  const rawShape = String(raw?.projectileShape ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24);
  const shape = rawShape || PROJECTILE_SHAPES[Math.floor(Math.random() * PROJECTILE_SHAPES.length)];
  const effect: EffectId = AI_EFFECTS.includes(raw?.effect) ? raw.effect : 'none';
  const fireRate = Math.min(10, Math.max(0.25, Number(raw?.fireRate) || 1));
  const burst = Math.min(6, Math.max(1, Math.round(Number(raw?.burst) || 1)));
  const range = Math.min(9, Math.max(2.2, Number(raw?.range) || 3.5));

  // Normalise power into the band, keeping the model's fire rate and burst.
  const wanted = Math.min(260, Math.max(2, Number(raw?.damage) || 10)) * fireRate * burst;
  const dps = Math.min(FORGE_DPS_MAX, Math.max(FORGE_DPS_MIN, wanted));
  const damage = Math.max(1, Math.round((dps / (fireRate * burst)) * 10) / 10);

  return {
    id: `ai-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    kind: 'ai',
    presetId: 'ai',
    name,
    damageType,
    effect,
    damage,
    fireRate,
    range,
    burst,
    projectileShape: shape,
    color: hexToNumber(String(raw?.color ?? '#ffffff')),
    impact: String(raw?.impact ?? 'A dull impact.').slice(0, 160),
    sound: String(raw?.sound ?? 'A plain mechanical clank.').slice(0, 160),
    mechanic: String(raw?.mechanic ?? 'Standard single-target damage.').slice(0, 220),
    price: FORGE_COST,
    dps,
  };
}

/** Keyword rules so the offline fallback still answers the player's brief. */
const BRIEF_RULES: { match: RegExp; effect: EffectId; type: string; word: string }[] = [
  { match: /\b(chain|chains|chaining|jump|jumps|between|link)\w*/i, effect: 'chain', type: 'arcane', word: 'Chain' },
  { match: /\b(fire|fires|burn|burns|burning|flame|flames|oil|torch|ember|incendiar\w*|scorch\w*)\b/i, effect: 'burn', type: 'thermal', word: 'Ember' },
  { match: /\b(freez\w*|frost\w*|ice|icy|cold|chill\w*|glac\w*|snow)\b/i, effect: 'chill', type: 'cryo', word: 'Rime' },
  { match: /\b(lightning|electric\w*|shock\w*|volt\w*|thunder|arc)\w*/i, effect: 'emp', type: 'electric', word: 'Volt' },
  { match: /\b(poison\w*|acid|corrosive|venom\w*|toxin\w*|rot)\b/i, effect: 'burn', type: 'corrosive', word: 'Bile' },
  { match: /\b(explode\w*|explosion\w*|blast\w*|boom|bomb)\w*/i, effect: 'splash', type: 'blast', word: 'Demolition' },
  { match: /\b(pierce\w*|through|line|long[- ]range|drill)\b/i, effect: 'pierce', type: 'kinetic', word: 'Lance' },
  { match: /\b(pull|vacuum|gravity|drag\w*|suck|collapse)\w*/i, effect: 'pull', type: 'gravity', word: 'Gravity' },
  { match: /\b(stun\w*|shock|paraly\w*|stagger)\w*/i, effect: 'stun', type: 'kinetic', word: 'Hammer' },
  { match: /\b(slow\w*|drag)\b/i, effect: 'chill', type: 'cryo', word: 'Creep' },
  { match: /\b(laser|beam|ray)\w*/i, effect: 'beam', type: 'radiant', word: 'Lattice' },
  { match: /\b(mark|expose|weak|vulnerab\w*)\w*/i, effect: 'mark', type: 'psychic', word: 'Spotlight' },
];

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'that', 'which', 'this', 'those', 'tower', 'thing', 'stuff', 'build', 'make',
  'want', 'need', 'please', 'with', 'from', 'into', 'onto', 'every', 'everything', 'something',
  'should', 'would', 'could', 'when', 'then', 'than', 'also', 'just', 'very', 'some', 'more', 'most',
]);

/** Local fallback forge - keeps the button useful when the server is down,
 *  and still answers the player's brief instead of inventing at random. */
export function localForge(used: UsedFingerprint[], brief = ''): TowerForgeResult {
  const usedShapes = new Set(used.map((u) => u.projectileShape));
  const usedTypes = new Set(used.map((u) => u.damageType.toLowerCase()));
  const usedColors = new Set(used.map((u) => u.color.toLowerCase()));
  const usedNames = new Set(used.map((u) => u.name.toLowerCase()));

  const rule = BRIEF_RULES.find((r) => r.match.test(brief));
  const shape = PROJECTILE_SHAPES.find((s) => !usedShapes.has(s)) ?? 'orb';

  let damageType = rule ? rule.type : 'exotic';
  if (usedTypes.has(damageType)) {
    const alt = ['sonic', 'void', 'plasma', 'oomyc', 'resonant', 'umbral', 'crystal', 'ferric'];
    damageType = alt.find((t) => !usedTypes.has(t)) ?? `${damageType}-${used.length + 1}`;
  }

  // Name it after the player's own words when we can.
  const words = brief
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const core = rule ? rule.word : words[0] ? words[0].toUpperCase() : 'EXOTIC';
  const suffix = ['Emitter', 'Array', 'Coil', 'Prism', 'Lattice', 'Engine', 'Nest', 'Forge'][
    Math.floor(Math.random() * 8)
  ];
  let name = `${core.toUpperCase().slice(0, 1)}${core.slice(1).toUpperCase()} ${suffix}`;
  let guard = 0;
  while (usedNames.has(name.toLowerCase()) && guard++ < 20) {
    name = `${core.toUpperCase().slice(0, 1)}${core.slice(1).toUpperCase()} ${suffix} ${guard + 1}`;
  }

  let color = 0x9ad8ff;
  guard = 0;
  while (usedColors.has(numberToHex(color).toLowerCase()) && guard++ < 50) {
    color = Math.floor(Math.random() * 0xffffff);
  }

  const damage = 8 + Math.floor(Math.random() * 34);
  const fireRate = 0.6 + Math.random() * 3.4;
  const range = 3 + Math.random() * 4;
  const burst = 1 + Math.floor(Math.random() * 3);
  const effect: EffectId = rule ? rule.effect : AI_EFFECTS[Math.floor(Math.random() * AI_EFFECTS.length)];
  const rawDps = damage * fireRate * burst;
  const dps = Math.min(FORGE_DPS_MAX, Math.max(FORGE_DPS_MIN, rawDps));
  const dmg = Math.max(1, Math.round((dps / (fireRate * burst)) * 10) / 10);

  return {
    spec: {
      id: `ai-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      kind: 'ai',
      presetId: 'ai',
      name,
      damageType,
      effect,
      damage: dmg,
      fireRate: Math.round(fireRate * 100) / 100,
      range: Math.round(range * 10) / 10,
      burst,
      projectileShape: shape,
      color,
      impact: 'A locally generated impact (the forge could not reach the model).',
      sound: 'A generic mechanical pulse.',
      mechanic: `Offline fallback design answering the brief: ${brief.slice(0, 120) || 'no brief given'}.`,
      price: FORGE_COST,
      dps,
    },
    source: 'local',
    reason: 'THE FORGE IS OFFLINE',
  };
}

export interface ForgeResult {
  spec: TowerSpec;
  source: 'ai' | 'local';
  reason?: string;
}

export type TowerForgeResult = ForgeResult;

/** Ask the server to forge a tower. Throws ForgeError on a hard failure. */
export async function forgeTower(opts: ForgeOptions): Promise<ForgeResult> {
  try {
    const res = await fetch('/api/forge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
      },
      body: JSON.stringify({ used: opts.used, model: opts.model, brief: opts.brief ?? '' }),
      signal: opts.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = String(data?.error ?? '');
      } catch {
        detail = `HTTP ${res.status}`;
      }
      throw new ForgeError(classify(detail, res.status));
    }
    const data = await res.json();
    const spec = normalise(data.tower, opts.used);
    return { spec, source: 'ai' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const reason = err instanceof ForgeError ? err.message : 'THE FORGE IS UNREACHABLE';
    return { ...localForge(opts.used, opts.brief ?? ''), reason };
  }
}

/** Turn a server error into something a player can act on. */
function classify(detail: string, status: number): string {
  const text = detail.toLowerCase();
  if (status === 429 || text.includes('429') || text.includes('limit') || text.includes('quota')) {
    return 'MINIMAX QUOTA REACHED';
  }
  if (status === 502 || text.includes('minimax call failed')) return 'MINIMAX IS DOWN';
  if (status === 503) return 'NO API KEY ON THE SERVER';
  return 'THE FORGE IS UNREACHABLE';
}
