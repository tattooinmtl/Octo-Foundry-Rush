/**
 * Tower data: the 7 hand-built presets plus the vocabulary the MiniMax forge
 * is allowed to draw from. Pure data - no three.js, no DOM.
 */

export type EffectId =
  | 'splash'
  | 'chain'
  | 'chill'
  | 'burn'
  | 'pierce'
  | 'homing'
  | 'beam'
  | 'shred'
  | 'stun'
  | 'pull'
  | 'emp'
  | 'mark'
  | 'ricochet'
  | 'slam'
  | 'volatile'
  | 'none';

export interface TowerSpec {
  id: string;
  kind: 'preset' | 'ai';
  presetId: string;
  name: string;
  damageType: string;
  effect: EffectId;
  damage: number;
  fireRate: number;
  range: number;
  burst: number;
  projectileShape: string;
  color: number;
  impact: string;
  sound: string;
  mechanic: string;
  price: number;
  dps: number;
}

/** Every projectile mesh shape the renderer knows how to build. */
export const PROJECTILE_SHAPES = [
  'shell', 'bolt', 'shard', 'spore', 'plume', 'pellet', 'lance',
  'orb', 'disc', 'wave', 'mine', 'drone', 'coil', 'plasma', 'lattice',
  'vortex', 'crystal', 'pulse', 'fang', 'helix', 'prism', 'needle',
  'torrent', 'snare', 'ember', 'chainmail',
] as const;

/** Effects the AI may request - each one is implemented in projectiles/effects. */
export const AI_EFFECTS: EffectId[] = [
  'splash', 'chain', 'chill', 'burn', 'pierce', 'homing', 'beam',
  'shred', 'stun', 'pull', 'emp', 'mark', 'ricochet', 'slam', 'volatile',
];

export interface PresetDef {
  presetId: string;
  name: string;
  damageType: string;
  effect: EffectId;
  damage: number;
  fireRate: number;
  range: number;
  burst: number;
  projectileShape: string;
  color: number;
  impact: string;
  sound: string;
  mechanic: string;
  blurb: string;
}

export const PRESETS: PresetDef[] = [
  {
    presetId: 'cannon',
    name: 'Iron Cannon',
    damageType: 'kinetic',
    effect: 'splash',
    damage: 26,
    fireRate: 1.15,
    range: 4.3,
    burst: 1,
    projectileShape: 'shell',
    color: 0xff8a3d,
    impact: 'Heavy blast with a shockwave ring and orange sparks',
    sound: 'Deep thump with a short metallic crack',
    mechanic: 'Lobs an explosive slug that bursts on impact',
    blurb: 'Slow, heavy, splash damage.',
  },
  {
    presetId: 'tesla',
    name: 'Tesla Coil',
    damageType: 'electric',
    effect: 'chain',
    damage: 13,
    fireRate: 2.1,
    range: 3.7,
    burst: 1,
    projectileShape: 'bolt',
    color: 0x59d8ff,
    impact: 'Arcs to nearby targets, leaving cyan crackle',
    sound: 'Sharp electric zap with rising whine',
    mechanic: 'Lightning arcs to 3 extra targets',
    blurb: 'Chains between creeps.',
  },
  {
    presetId: 'frost',
    name: 'Cryo Vent',
    damageType: 'thermal',
    effect: 'chill',
    damage: 9,
    fireRate: 1.9,
    range: 3.9,
    burst: 1,
    projectileShape: 'shard',
    color: 0x9ceaff,
    impact: 'Freezing mist burst, icy shards scatter',
    sound: 'Hollow crystalline puff',
    mechanic: 'Chills: -45% speed for 2.5s',
    blurb: 'Slows everything it touches.',
  },
  {
    presetId: 'bio',
    name: 'Spore Bloom',
    damageType: 'corrosive',
    effect: 'burn',
    damage: 6,
    fireRate: 2.2,
    range: 3.3,
    burst: 1,
    projectileShape: 'spore',
    color: 0x7dff6a,
    impact: 'Acidic spore cloud, green bubbles rise',
    sound: 'Wet bubbling pop',
    mechanic: 'Spores linger and corrode over 4s',
    blurb: 'Damage over time spores.',
  },
  {
    presetId: 'flame',
    name: 'Flame Vent',
    damageType: 'thermal',
    effect: 'burn',
    damage: 4,
    fireRate: 7,
    range: 2.9,
    burst: 1,
    projectileShape: 'plume',
    color: 0xff5a2a,
    impact: 'Rolling fireball wash, soot rises',
    sound: 'Roaring continuous burner hiss',
    mechanic: 'Sustained flame cone, burns over time',
    blurb: 'Short range, high tick rate.',
  },
  {
    presetId: 'multi',
    name: 'Scatter Gun',
    damageType: 'kinetic',
    effect: 'pierce',
    damage: 6,
    fireRate: 3,
    range: 3.6,
    burst: 3,
    projectileShape: 'pellet',
    color: 0xffd23d,
    impact: 'Yellow spark spray with metal fragments',
    sound: 'Rapid shotgun chug',
    mechanic: 'Fires 3 pellets per shot, pierces crowds',
    blurb: 'Crowd control at close range.',
  },
  {
    presetId: 'sniper',
    name: 'Rail Lance',
    damageType: 'kinetic',
    effect: 'beam',
    damage: 92,
    fireRate: 0.55,
    range: 8.2,
    burst: 1,
    projectileShape: 'lance',
    color: 0xff4d6d,
    impact: 'Red rail line that lingers, sparks at impact',
    sound: 'Long charged whine then a hard crack',
    mechanic: 'Hitscan beam that pierces every creep in the line',
    blurb: 'Long range, long reload.',
  },
];

/** Words the forge prompt uses to describe the presets it must not copy. */
export function presetFingerprints(): { name: string; damageType: string; projectileShape: string }[] {
  return PRESETS.map((p) => ({
    name: p.name,
    damageType: p.damageType,
    projectileShape: p.projectileShape,
  }));
}
