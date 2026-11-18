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
