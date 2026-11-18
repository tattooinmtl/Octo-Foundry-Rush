/**
 * Octopus roster + wave generation checks (runs in Node, three.js has no DOM needs here).
 * Run: node --import ./scripts/register-ts.mjs scripts/enemy-test.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Enemy, GooglyPupil, leapState, LEAP_AIR_FRACTION } from '../src/core/enemies.ts';
import { CREEP_TIERS, tierIndexOf } from '../src/core/config.ts';
import { buildSpawnList, pickTier, planWave, slotHpWeight, tierPresence } from '../src/core/balance.ts';
import { canHitFlying, PRESETS } from '../src/core/towerDefs.ts';
import { generatePath } from '../src/core/path.ts';

const path = generatePath(12345);
const scene = new THREE.Scene();
const events: string[] = [];
const cb = {
  onDeath: () => events.push('death'),
  onLeak: () => events.push('leak'),
  onVolatile: () => events.push('volatile'),
  onShieldBreak: () => events.push('shield'),
};
const make = (id: string, hp = 100, speed = 1) => new Enemy(scene, path, hp, 0, speed, tierIndexOf(id), 0.5, cb);
let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('enemies');

test('roster has the new octopus kinds', () => {
  for (const id of ['leaper', 'flyer', 'shielded', 'swarm', 'skyguard', 'boss']) assert.ok(tierIndexOf(id) >= 0, id);
  // Old saves stored indices 0..2 - keep them stable.
  assert.deepEqual(CREEP_TIERS.slice(0, 3).map((t) => t.id), ['grunt', 'runner', 'tank']);
  const hopper = CREEP_TIERS[tierIndexOf('leaper')];
  assert.notEqual(hopper.color, CREEP_TIERS[0].color, 'hopper has its own colour');
  assert.notEqual(hopper.scale, 1, 'hopper has its own size');
});

test('shield soaks damage before HP and pops once', () => {
  events.length = 0;
  const e = make('shielded', 100);
  assert.equal(e.maxShield, Math.round(e.maxHp * 0.6));
  const hp0 = e.hp;
  e.takeDamage(10, 'chill');
  assert.equal(e.hp, hp0, 'HP untouched while shield holds');
  assert.equal(e.slowFactor, 1, 'status blocked by shield');
  e.takeDamage(1000, 'none');
  assert.equal(e.shield, 0);
  assert.ok(e.hp < hp0, 'overflow reaches HP');
  assert.equal(events.filter((x) => x === 'shield').length, 1);
});

test('EMP and shred crack shields twice as fast', () => {
  const a = make('shielded');
  const b = make('shielded');
  a.takeDamage(10, 'none');
  b.takeDamage(10, 'emp');
  assert.equal(a.maxShield - a.shield, 10);
  assert.equal(b.maxShield - b.shield, 20);
});

test('burn damage drains the shield first', () => {
  const e = make('shielded');
  e.ignite(30, 2);
  const hp0 = e.hp;
  e.update(0.5, path);
  assert.ok(e.shield < e.maxShield);
  assert.equal(e.hp, hp0);
});

test('hopper moves in leaps: still while crouched, same average speed', () => {
  const st = leapState(LEAP_AIR_FRACTION + 0.1);
  assert.equal(st.airborne, false);
  assert.equal(st.speedFactor, 0);
  const air = leapState(LEAP_AIR_FRACTION / 2);
  assert.ok(air.airborne && air.height > 0.4);
  const hop = make('leaper', 100, 1);
  const walk = make('grunt', 100, 1);
  let stillFrames = 0;
  let last = hop.distance;
  for (let i = 0; i < 600; i++) {
    hop.update(1 / 60, path);
    walk.update(1 / 60, path);
    if (hop.distance === last) stillFrames++;
    last = hop.distance;
  }
  assert.ok(stillFrames > 150, `hopper should pause between leaps (${stillFrames} still frames)`);
  const ratio = hop.distance / (walk.distance * (hop.tier.speedMult / walk.tier.speedMult));
  assert.ok(ratio > 0.85 && ratio < 1.15, `average leap speed ~= base speed (ratio ${ratio.toFixed(2)})`);
});

test('flyers fly and ground-only towers cannot hit them', () => {
  const f = make('flyer');
  assert.equal(f.flying, true);
  assert.equal(make('skyguard').flying, true);
  assert.ok(make('skyguard').maxShield > 0, 'sky warden is flying AND shielded');
  const flame = PRESETS.find((p) => p.presetId === 'flame')!;
  assert.equal(canHitFlying(flame), false, 'flame vent is ground only');
  for (const p of PRESETS.filter((x) => x.presetId !== 'flame')) assert.equal(canHitFlying(p), true, p.name);
  assert.equal(canHitFlying({ projectileShape: 'mine', effect: 'splash' }), false);
  assert.equal(canHitFlying({ projectileShape: 'orb', effect: 'slam' }), false);
});

test('flyer hit position stays on the road (altitude is visual only)', () => {
  const f = make('flyer');
  f.update(0.2, path);
  assert.ok(Math.abs(f.position.y) < 0.2, `group y ${f.position.y}`);
});

test('googly pupils jiggle but stay inside the eye', () => {
  const p = new GooglyPupil();
  p.kick(5, 5);
  let moved = false;
  for (let i = 0; i < 300; i++) {
    p.step(1 / 60, Math.sin(i) * 40, Math.cos(i * 0.7) * 40);
    assert.ok(Math.hypot(p.x, p.y) <= 0.034 + 1e-9);
    if (Math.abs(p.x) > 0.005) moved = true;
  }
  assert.ok(moved);
});

test('snapshot / restore round-trips a damaged shielded creep', () => {
  const e = make('skyguard', 200);
  e.update(1, path);
  e.takeDamage(30, 'none');
  const snap = e.snapshot();
  const r = make('skyguard', 1);
  r.restore(snap, path);
  assert.equal(r.hp, e.hp);
  assert.equal(r.shield, e.shield);
  assert.equal(r.maxHp, e.maxHp);
  assert.ok(Math.abs(r.distance - e.distance) < 1e-9);
});

console.log('waves');

test('new kinds only appear from their first wave', () => {
  for (let w = 1; w <= 30; w++) {
    for (let k = 0; k < 400; k++) {
      const t = CREEP_TIERS[pickTier(k / 400, w)];
      assert.ok(w >= t.minWave, `${t.id} on wave ${w}`);
      assert.ok(!t.boss, 'boss never comes from the random pick');
    }
  }
  assert.equal(tierPresence(tierIndexOf('flyer'), 3), 0);
  assert.ok(tierPresence(tierIndexOf('flyer'), 6) === 1);
});

test('average HP per wave slot stays close to the original roster (balance)', () => {
  // Original: 62% grunt (1.0), 20% runner (0.62), 18% tank (1.85) -> 1.077.
  const original = 0.62 * 1 + 0.2 * 0.62 + 0.18 * 1.85;
  for (const w of [8, 12, 20, 40]) {
    let total = 0;
    let weight = 0;
    CREEP_TIERS.forEach((t, i) => {
      const wt = t.weight * tierPresence(i, w);
      total += wt * slotHpWeight(i);
      weight += wt;
    });
    const avg = total / weight;
    assert.ok(Math.abs(avg - original) / original < 0.12, `wave ${w}: avg slot HP ${avg.toFixed(3)} vs ${original.toFixed(3)}`);
  }
});

test('swarm slots spawn fry in threes; round finale brings a Kraken', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const w10 = buildSpawnList(planWave(10, 38), rand);
  assert.equal(w10.filter((s) => CREEP_TIERS[s.tier].boss).length, 1, 'one boss on wave 10');
  const w9 = buildSpawnList(planWave(9, 38), rand);
  assert.equal(w9.filter((s) => CREEP_TIERS[s.tier].boss).length, 0, 'no boss on wave 9');
  const lots = buildSpawnList({ ...planWave(25, 38), count: 400 }, rand);
  const fry = lots.filter((s) => CREEP_TIERS[s.tier].id === 'swarm').length;
  assert.ok(fry > 0 && fry % 3 === 0, `fry come in threes (${fry})`);
  for (let i = 1; i < lots.length; i++) assert.ok(lots[i].at >= lots[i - 1].at, 'sorted by time');
  const kinds = new Set(lots.map((s) => CREEP_TIERS[s.tier].id));
  for (const id of ['leaper', 'flyer', 'shielded', 'swarm', 'skyguard']) assert.ok(kinds.has(id), `${id} appears by wave 25`);
});

console.log(`\n${passed} enemy/wave tests passed`);
