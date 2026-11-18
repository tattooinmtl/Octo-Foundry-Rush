/**
 * Creeps: sphere-bodied octopuses with four IK legs on an unsynchronised gait,
 * big googly eyes whose pupils jiggle on a spring, and per-kind movement:
 *
 *   walk - the classic scuttle.
 *   leap - the Hopper crouches, then springs down the road like a frog.
 *   fly  - Gliders and Sky Wardens hover over the road on flapping wings,
 *          tentacles dangling. Ground-only towers cannot reach them.
 *
 * Some kinds carry a shield bubble that soaks damage before HP.
 *
 * Every creep gets its own gait signature (leg frequency multipliers, phase
 * offsets, stride length, lift height and a gait pattern) so they look like
 * the same species but never move in lockstep.
 *
 * Hit tests use the group's ground position, so altitude is purely visual
 * (the rig is lifted inside the group) and every distance check stays 2D-safe.
 */

import * as THREE from 'three';
import { CREEP_TIERS, type CreepTier } from './config';
import { sampleAt, type GeneratedPath } from './path';

const BODY_GEO = new THREE.IcosahedronGeometry(0.26, 1);
const SCLERA_GEO = new THREE.SphereGeometry(0.085, 14, 10);
const PUPIL_GEO = new THREE.SphereGeometry(0.048, 10, 8);
const LEG_GEO = new THREE.CylinderGeometry(0.028, 0.05, 1, 6);
const LEG_TIP_GEO = new THREE.SphereGeometry(0.045, 7, 6);
const ICE_GEO = new THREE.IcosahedronGeometry(0.42, 0);
const SHIELD_GEO = new THREE.SphereGeometry(0.46, 22, 16);
const SHADOW_GEO = new THREE.CircleGeometry(0.26, 18).rotateX(-Math.PI / 2);
const WING_GEO = makeWingGeometry();

const SCLERA_MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0, emissive: 0x222222 });
const PUPIL_MAT = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.15, metalness: 0.1 });
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
const ICE_MAT = new THREE.MeshStandardMaterial({
  color: 0xbfeaff,
  emissive: 0x3aa8ff,
  emissiveIntensity: 0.55,
  metalness: 0.1,
  roughness: 0.08,
  transparent: true,
  opacity: 0.62,
  depthWrite: false,
});

/** Bat/fin wing lying flat in the XZ plane, root at the origin, tip along +X. */
function makeWingGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.05);
  s.quadraticCurveTo(0.22, 0.2, 0.46, 0.12);
  s.lineTo(0.38, 0.02);
  s.lineTo(0.42, -0.06);
  s.lineTo(0.3, -0.04);
  s.lineTo(0.28, -0.12);
  s.lineTo(0.16, -0.06);
  s.quadraticCurveTo(0.06, -0.1, 0, -0.06);
  s.closePath();
  const g = new THREE.ShapeGeometry(s, 6);
  g.rotateX(-Math.PI / 2);
  return g;
}

type GaitPattern = 'diagonal' | 'wave' | 'gallop' | 'scatter';

const GAIT_PATTERNS: Record<GaitPattern, number[]> = {
  diagonal: [0, 0.5, 0.5, 0],
  wave: [0, 0.25, 0.5, 0.75],
  gallop: [0, 0.08, 0.55, 0.63],
  scatter: [0, 0.31, 0.66, 0.12],
};

/** Hopper timing: a full crouch+leap cycle and the share of it spent in the air. */
export const LEAP_PERIOD = 0.95;
export const LEAP_AIR_FRACTION = 0.5;
export const LEAP_HEIGHT = 0.55;
/** Flyers hover this high (local units, before scale). */
export const FLY_ALTITUDE = 0.8;

/**
 * Where a leaper is in its hop. `phase` is in cycles (any real number).
 * Ground speed is 0 while crouched and 1/airFraction while airborne, so the
 * average speed over a cycle equals the creep's base speed.
 */
export function leapState(phase: number, airFraction = LEAP_AIR_FRACTION): { airborne: boolean; u: number; speedFactor: number; height: number } {
  const p = ((phase % 1) + 1) % 1;
  if (p < airFraction) {
    const u = p / airFraction;
    return { airborne: true, u, speedFactor: 1 / airFraction, height: LEAP_HEIGHT * Math.sin(Math.PI * u) };
  }
  return { airborne: false, u: (p - airFraction) / (1 - airFraction), speedFactor: 0, height: 0 };
}

/**
 * Spring-damped pupil inside a googly eye. Kicks come from the body's motion
 * (hops, bobbing, turning) so the pupils rattle around like the real thing.
 */
export class GooglyPupil {
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  private readonly maxOffset: number;
  private readonly stiffness: number;
  private readonly damping: number;
  constructor(maxOffset = 0.034, stiffness = 70, damping = 3.2) {
    this.maxOffset = maxOffset;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  kick(ix: number, iy: number): void {
    this.vx += ix;
    this.vy += iy;
  }

  /** Advance the spring. `ax/ay` is the body's acceleration in eye space. */
  step(dt: number, ax = 0, ay = 0): void {
    const h = Math.min(dt, 1 / 30);
    // Gravity pulls the pupil down a little; the body's acceleration throws it the other way.
    const fx = -this.stiffness * this.x - this.damping * this.vx - ax;
    const fy = -this.stiffness * this.y - this.damping * this.vy - ay - 1.2;
    this.vx += fx * h;
    this.vy += fy * h;
    this.x += this.vx * h;
    this.y += this.vy * h;
    const r = Math.hypot(this.x, this.y);
    if (r > this.maxOffset) {
      // Bounce off the rim of the eye.
      const nx = this.x / r;
      const ny = this.y / r;
      this.x = nx * this.maxOffset;
      this.y = ny * this.maxOffset;
      const vn = this.vx * nx + this.vy * ny;
      if (vn > 0) {
        this.vx -= 1.6 * vn * nx;
        this.vy -= 1.6 * vn * ny;
      }
    }
  }
}

export interface EnemyCallbacks {
  onDeath: (e: Enemy) => void;
  onLeak: (e: Enemy) => void;
  /** Called when a volatile creep detonates. */
  onVolatile: (e: Enemy) => void;
  /** Called once when a shield bubble pops. */
  onShieldBreak?: (e: Enemy) => void;
}

/** What a save file keeps about a live creep. */
export interface EnemySnapshot {
  kind: string;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  armor: number;
  baseSpeed: number;
  distance: number;
  volatile: boolean;
}

export class Enemy {
  readonly group = new THREE.Group();
  readonly tier: CreepTier;
  readonly tierIndex: number;
  readonly flying: boolean;
  readonly leaper: boolean;

  hp: number;
  maxHp: number;
  armor: number;
  baseSpeed: number;
  shield: number;
  maxShield: number;
  distance = 0;
  alive = true;
  leaked = false;

  slowUntil = 0;
  slowFactor = 1;
  burnUntil = 0;
  burnDps = 0;
  stunUntil = 0;
  markUntil = 0;
  shredUntil = 0;
  volatile = false;
  pullTarget = 0;
  freezeUntil = 0;
  private ice: THREE.Mesh | null = null;

  private time = 0;
  private rig = new THREE.Group();
  private body: THREE.Mesh;
  private tangent = new THREE.Vector3(1, 0, 0);
  private eyes: { sclera: THREE.Mesh; pupil: THREE.Mesh; spring: GooglyPupil }[] = [];
  private legs: { upper: THREE.Mesh; lower: THREE.Mesh; tip: THREE.Mesh }[] = [];
  private wings: THREE.Group[] = [];
  private shieldMesh: THREE.Mesh | null = null;
  private shieldMat: THREE.MeshStandardMaterial | null = null;
  private shieldFlash = 0;
  private shadow: THREE.Mesh | null = null;
  private gaitFreq = 1;
  private gaitPhase: number[] = [0, 0, 0, 0];
  private legFreqMult: number[] = [1, 1, 1, 1];
  private stride = 0.24;
  private lift = 0.08;
  private scale: number;
  private bodyMat: THREE.MeshStandardMaterial;
  private wingMat: THREE.MeshStandardMaterial | null = null;
  private hopPhase: number;
  private hopPeriod: number;
  private wasAirborne = false;
  private flapFreq = 5;
  private altitude = 0;
  private lastAltitude = 0;
  private lastVy = 0;
  private lastHeading = 0;
  private rand: number;
  private cb: EnemyCallbacks;

  constructor(
    scene: THREE.Scene,
    path: GeneratedPath,
    hp: number,
    armor: number,
    speed: number,
    tierIndex: number,
    rand: number,
    cb: EnemyCallbacks,
  ) {
    this.cb = cb;
    this.tierIndex = CREEP_TIERS[tierIndex] ? tierIndex : 0;
    this.tier = CREEP_TIERS[this.tierIndex];
    this.rand = rand;
    this.flying = this.tier.movement === 'fly';
    this.leaper = this.tier.movement === 'leap';
    this.maxHp = Math.max(1, Math.round(hp * this.tier.hpMult));
    this.hp = this.maxHp;
    this.maxShield = Math.round(this.maxHp * this.tier.shield);
    this.shield = this.maxShield;
    this.armor = armor + this.tier.armor;
    this.baseSpeed = speed * this.tier.speedMult;
    this.scale = this.tier.scale;
    this.hopPeriod = LEAP_PERIOD * (0.9 + rand * 0.2);
    // Start part-way into the crouch so a pack of Hoppers does not jump in sync.
    this.hopPhase = LEAP_AIR_FRACTION + rand * (1 - LEAP_AIR_FRACTION);
    this.flapFreq = 4.2 + rand * 1.8;

    // Gait signature.
    const patterns = Object.keys(GAIT_PATTERNS) as GaitPattern[];
    const pattern = patterns[Math.floor(rand * patterns.length) % patterns.length];
    const base = GAIT_PATTERNS[pattern];
    this.gaitPhase = base.map((p) => p + (rand - 0.5) * 0.16);
    this.legFreqMult = [0, 1, 2, 3].map(() => 0.86 + rand * 0.3);
    // Faster ground speed means faster legs, so the gait never looks like a
    // moonwalk.
    this.gaitFreq = (1.5 + rand * 0.7) * (0.55 + speed * 0.55);
    this.stride = (0.19 + rand * 0.12) * (0.85 + speed * 0.25);
    this.lift = 0.05 + rand * 0.07;

    this.bodyMat = new THREE.MeshStandardMaterial({
      color: this.tier.color,
      roughness: 0.42,
      metalness: 0.12,
      emissive: new THREE.Color(this.tier.color).multiplyScalar(0.12),
    });
    this.body = new THREE.Mesh(BODY_GEO, this.bodyMat);
    this.body.scale.set(1, 0.86, 1.05);
    this.body.position.y = 0.3;
    this.rig.add(this.body);
    this.group.add(this.rig);

    // Googly eyes: white sclera, black pupil on a spring.
    for (let i = 0; i < 2; i++) {
      const sclera = new THREE.Mesh(SCLERA_GEO, SCLERA_MAT);
      sclera.position.set(i === 0 ? -0.105 : 0.105, 0.4, 0.2);
      // Slight outward tilt so each eye looks a bit sideways, like a real googly eye.
      sclera.rotation.y = i === 0 ? -0.25 : 0.25;
      const pupil = new THREE.Mesh(PUPIL_GEO, PUPIL_MAT);
      pupil.scale.set(1, 1, 0.45);
      sclera.add(pupil);
      this.rig.add(sclera);
      const spring = new GooglyPupil();
      spring.kick((rand - 0.5) * 0.6, (0.5 - rand) * 0.6);
      this.eyes.push({ sclera, pupil, spring });
      this.placePupil(this.eyes[i]);
    }

    for (let i = 0; i < 4; i++) {
      const upper = new THREE.Mesh(LEG_GEO, this.bodyMat);
      const lower = new THREE.Mesh(LEG_GEO, this.bodyMat);
      const tip = new THREE.Mesh(LEG_TIP_GEO, this.bodyMat);
      this.group.add(upper, lower, tip);
      this.legs.push({ upper, lower, tip });
    }

    if (this.flying) this.buildWings();
    if (this.maxShield > 0) this.buildShield();
    if (this.flying || this.leaper) {
      this.shadow = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT);
      this.shadow.position.y = 0.025;
      this.group.add(this.shadow);
    }

    this.group.scale.setScalar(this.scale);
    scene.add(this.group);

    const start = sampleAt(path, 0);
    this.group.position.copy(start.pos);
    this.tangent.copy(start.tangent);
    this.lastHeading = Math.atan2(start.tangent.x, start.tangent.z);
    this.rig.rotation.y = this.lastHeading;
    this.altitude = this.flying ? FLY_ALTITUDE : 0;
    this.lastAltitude = this.altitude;
    this.rig.position.y = this.altitude;
  }

  private buildWings(): void {
    this.wingMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.tier.color).lerp(new THREE.Color(0xffffff), 0.35),
      emissive: new THREE.Color(this.tier.color).multiplyScalar(0.18),
      roughness: 0.5,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
    });
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.17, 0.4, -0.04);
      const wing = new THREE.Mesh(WING_GEO, this.wingMat);
      wing.scale.x = side;
      pivot.add(wing);
      this.rig.add(pivot);
      this.wings.push(pivot);
    }
  }

  private buildShield(): void {
    this.shieldMat = new THREE.MeshStandardMaterial({
      color: 0x8fe8ff,
      emissive: 0x3ab8ff,
      emissiveIntensity: 0.7,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    this.shieldMesh = new THREE.Mesh(SHIELD_GEO, this.shieldMat);
    this.shieldMesh.position.y = 0.32;
    this.rig.add(this.shieldMesh);
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Direction of travel along the road (used to lead moving targets). */
  get heading(): THREE.Vector3 {
    return this.tangent;
  }

  /** Current ground speed, slowed or stunned (instantaneous for Hoppers). */
  get currentSpeed(): number {
    const stunned = this.stunUntil > this.time;
    if (stunned) return 0;
    const hop = this.leaper ? leapState(this.hopPhase).speedFactor : 1;
    return this.baseSpeed * this.slowFactor * hop;
  }

  get progress(): number {
    return this.distance;
  }

  /** True while a Hopper is in the air (purely cosmetic for targeting). */
  get airborne(): boolean {
    return this.flying || (this.leaper && leapState(this.hopPhase).airborne);
  }

  get shieldFraction(): number {
    return this.maxShield > 0 ? this.shield / this.maxShield : 0;
  }

  /**
   * Route damage through the shield first. EMP and shred hit shields twice as
   * hard. Returns what is left over for the body.
   */
  private absorb(amount: number, effect: string): number {
    if (this.shield <= 0 || amount <= 0) return amount;
    const mult = effect === 'emp' || effect === 'shred' ? 2 : 1;
    const absorbed = Math.min(this.shield, amount * mult);
    this.shield -= absorbed;
    this.shieldFlash = 1;
    if (this.shield <= 1e-6) {
      this.shield = 0;
      if (this.shieldMesh) this.shieldMesh.visible = false;
      this.cb.onShieldBreak?.(this);
    }
    return amount - absorbed / mult;
  }

  private die(): void {
    this.hp = 0;
    this.alive = false;
    if (this.volatile) this.cb.onVolatile(this);
    this.cb.onDeath(this);
  }

  /** Apply damage with shield, armour, slow, burn and mark rules. Returns damage dealt. */
  takeDamage(raw: number, effect: string, opts: { ignoreArmor?: boolean; from?: string } = {}): number {
    if (!this.alive || !(raw > 0)) return 0;
    let amount = raw;
    const marked = this.markUntil > this.time;
    if (marked) amount *= 1.25;

    const shieldBefore = this.shield;
    amount = this.absorb(amount, effect);
    const shieldDealt = shieldBefore - this.shield;
    // A shield that is still up after the hit blocks status effects too.
    if (this.shield > 0) return shieldDealt;

    const shred = this.shredUntil > this.time;
    const armor = opts.ignoreArmor ? 0 : Math.max(0, shred ? 0 : this.armor);
    if (armor > 0 && amount > 0) amount = Math.max(amount * 0.2, amount - armor);
    this.hp -= amount;

    if (effect === 'chill') {
      this.slowFactor = 0.55;
      this.slowUntil = this.time + 2.5;
    } else if (effect === 'stun' || effect === 'emp' || effect === 'slam') {
      this.stunUntil = this.time + (effect === 'stun' ? 0.7 : 0.45);
    } else if (effect === 'shred') {
      this.shredUntil = this.time + 4;
    } else if (effect === 'mark') {
      this.markUntil = this.time + 5;
    } else if (effect === 'volatile') {
      this.volatile = true;
    } else if (effect === 'burn') {
      this.burnUntil = Math.max(this.burnUntil, this.time + 3);
      this.burnDps = Math.max(this.burnDps, raw * 0.35);
    }

    if (this.hp <= 0) this.die();
    return shieldDealt + amount;
  }

  /** Encase in ice: no movement for `seconds`, then a lingering chill. */
  freeze(seconds: number): void {
    if (!this.alive) return;
    this.freezeUntil = Math.max(this.freezeUntil, this.time + seconds);
    this.stunUntil = Math.max(this.stunUntil, this.freezeUntil);
    this.slowFactor = 0.5;
    this.slowUntil = this.freezeUntil + 2.5;
    if (!this.ice) {
      this.ice = new THREE.Mesh(ICE_GEO, ICE_MAT);
      this.ice.position.y = 0.3;
      this.ice.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.ice.scale.set(1.05, 0.95, 1.1);
      this.rig.add(this.ice);
    }
    this.ice.visible = true;
  }

  get frozen(): boolean {
    return this.freezeUntil > this.time;
  }

  /** Set on fire: damage over time for `seconds`. */
  ignite(dps: number, seconds: number): void {
    if (!this.alive) return;
    this.burnUntil = Math.max(this.burnUntil, this.time + seconds);
    this.burnDps = Math.max(this.burnDps, dps);
  }

  update(dt: number, path: GeneratedPath): void {
    if (!this.alive) return;
    this.time += dt;
    if (this.ice && this.ice.visible && this.freezeUntil <= this.time) this.ice.visible = false;

    // Damage over time (the shield soaks it first).
    if (this.burnUntil > this.time && this.burnDps > 0) {
      const left = this.absorb(this.burnDps * dt, 'burn');
      this.hp -= left;
      if (this.hp <= 0) {
        this.die();
        return;
      }
    }
    if (this.slowUntil <= this.time) this.slowFactor = 1;
    if (this.markUntil <= this.time) this.markUntil = 0;

    const stunned = this.stunUntil > this.time;
    const pace = this.slowFactor * (stunned ? 0 : 1);
    let hop = { airborne: false, u: 0, speedFactor: 1, height: 0 };
    if (this.leaper) {
      this.hopPhase += (dt * pace) / this.hopPeriod;
      hop = leapState(this.hopPhase);
    }
    this.distance += this.baseSpeed * pace * hop.speedFactor * dt;
    if (this.pullTarget > 0) {
      this.distance = Math.max(0, this.distance - this.pullTarget * dt);
      this.pullTarget = Math.max(0, this.pullTarget - dt * 1.6);
    }

    if (this.distance >= path.length) {
      this.alive = false;
      this.leaked = true;
      this.cb.onLeak(this);
      return;
    }

    const s = sampleAt(path, this.distance);
    this.group.position.copy(s.pos);
    this.tangent.copy(s.tangent);

    // Orientation + body motion (all local - the group carries the scale).
    const heading = Math.atan2(s.tangent.x, s.tangent.z);
    let turn = heading - this.lastHeading;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    this.lastHeading = heading;
    this.rig.rotation.y = heading;

    let alt = 0;
    if (this.flying) {
      alt = FLY_ALTITUDE + Math.sin(this.time * this.flapFreq) * 0.06;
      const flap = Math.sin(this.time * this.flapFreq * 2 * Math.PI * 0.5);
      this.wings.forEach((w, i) => {
        w.rotation.z = (i === 0 ? -1 : 1) * (0.15 + flap * 0.65);
      });
    } else if (this.leaper) {
      alt = hop.height;
      // Squash while crouched, stretch on take-off.
      const squash = hop.airborne ? 1 + 0.18 * Math.sin(Math.PI * hop.u) : 1 - 0.16 * Math.sin(Math.PI * hop.u);
      this.body.scale.set(1 / Math.sqrt(squash), 0.86 * squash, 1.05 / Math.sqrt(squash));
      if (hop.airborne !== this.wasAirborne) {
        // Take-off flicks the pupils down, landing rattles them up.
        for (const e of this.eyes) e.spring.kick((Math.random() - 0.5) * 1.2, hop.airborne ? -1.4 : 1.8);
        this.wasAirborne = hop.airborne;
      }
    } else {
      alt = Math.sin(this.time * this.gaitFreq * Math.PI * 2 * 2) * 0.018;
    }
    this.rig.position.y = alt;

    // Googly pupils react to vertical acceleration and turning.
    const h = Math.max(dt, 1e-4);
    const vy = (alt - this.lastAltitude) / h;
    const ay = (vy - this.lastVy) / h;
    this.lastAltitude = alt;
    this.lastVy = vy;
    const ax = (turn / h) * this.baseSpeed * 0.6;
    for (const e of this.eyes) {
      e.spring.step(dt, ax * 0.02, ay * 0.004);
      this.placePupil(e);
    }

    if (this.shieldMesh && this.shieldMat && this.shield > 0) {
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 4);
      const frac = this.shieldFraction;
      this.shieldMat.opacity = 0.12 + 0.24 * frac + 0.35 * this.shieldFlash;
      this.shieldMat.emissiveIntensity = 0.5 + 1.4 * this.shieldFlash;
      const pulse = 1 + Math.sin(this.time * 3.1 + this.rand * 6) * 0.025;
      this.shieldMesh.scale.setScalar(pulse * (0.92 + 0.08 * frac));
      this.shieldMesh.rotation.y += dt * 0.6;
    }

    if (this.shadow) {
      const k = 1 - Math.min(0.5, alt * 0.45);
      this.shadow.scale.setScalar(k);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.32;
    }

    if (!this.frozen) this.animateLegs(s.tangent, alt, hop);
  }

  private placePupil(e: { pupil: THREE.Mesh; spring: GooglyPupil }): void {
    const r = 0.062;
    const x = e.spring.x;
    const y = e.spring.y;
    const z = Math.sqrt(Math.max(0, r * r - x * x - y * y));
    e.pupil.position.set(x, y, z);
  }

  private animateLegs(tangent: THREE.Vector3, alt: number, hop: { airborne: boolean; u: number }): void {
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    // Bone lengths live in the group's local space (the group carries scale).
    const l1 = 0.2;
    const l2 = 0.22;

    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const front = i < 2 ? 1 : -1;

      const hip = new THREE.Vector3(0, 0.24 + alt, 0)
        .addScaledVector(right, side * 0.12)
        .addScaledVector(tangent, front * 0.07);

      let foot: THREE.Vector3;
      if (this.flying) {
        // Tentacles dangle and sway under a flyer.
        const sway = Math.sin(this.time * 3 + i * 1.7) * 0.06;
        foot = new THREE.Vector3(0, alt - 0.12, 0)
          .addScaledVector(right, side * 0.17)
          .addScaledVector(tangent, front * 0.04 - 0.08 + sway);
      } else if (this.leaper && hop.airborne) {
        // Legs trail behind mid-leap, then reach forward to land.
        const reach = -0.18 + 0.32 * hop.u;
        foot = new THREE.Vector3(0, alt + 0.06, 0)
          .addScaledVector(right, side * 0.2)
          .addScaledVector(tangent, reach + front * 0.04);
      } else if (this.leaper) {
        // Crouched: feet planted wide, ready to spring.
        foot = new THREE.Vector3(0, 0.02, 0)
          .addScaledVector(right, side * 0.3)
          .addScaledVector(tangent, front * 0.12);
      } else {
        const p = (this.time * this.gaitFreq * this.legFreqMult[i] + this.gaitPhase[i]) % 1;
        const stance = 0.6;
        let along: number;
        let lift = 0;
        if (p < stance) {
          const t = p / stance;
          along = this.stride * (0.5 - t);
        } else {
          const t = (p - stance) / (1 - stance);
          along = this.stride * (-0.5 + t);
          lift = this.lift * Math.sin(t * Math.PI);
        }
        foot = new THREE.Vector3(0, 0.02 + lift, 0)
          .addScaledVector(right, side * 0.26)
          .addScaledVector(tangent, along);
      }

      // Two-bone IK in local space.
      const dir = foot.clone().sub(hip);
      let d = dir.length();
      const maxLen = (l1 + l2) * 0.98;
      if (d > maxLen) {
        dir.multiplyScalar(maxLen / d);
        d = maxLen;
        foot = hip.clone().add(dir);
      }
      if (d < 1e-4) d = 1e-4;
      dir.normalize();
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      const perp = up
        .clone()
        .sub(dir.clone().multiplyScalar(up.dot(dir)))
        .normalize()
        .addScaledVector(right, side * 0.35)
        .normalize();
      const knee = hip.clone().addScaledVector(dir, a).addScaledVector(perp, hh);

      const leg = this.legs[i];
      alignBetween(leg.upper, hip, knee);
      alignBetween(leg.lower, knee, foot);
      leg.tip.position.copy(foot);
    }
  }

  /** Save-file view of this creep. */
  snapshot(): EnemySnapshot {
    return {
      kind: this.tier.id,
      hp: this.hp,
      maxHp: this.maxHp,
      shield: this.shield,
      maxShield: this.maxShield,
      armor: this.armor,
      baseSpeed: this.baseSpeed,
      distance: this.distance,
      volatile: this.volatile,
    };
  }

  /** Put a loaded creep back where it was. Values are assumed validated. */
  restore(s: EnemySnapshot, path: GeneratedPath): void {
    this.maxHp = s.maxHp;
    this.hp = Math.min(s.hp, s.maxHp);
    this.maxShield = s.maxShield;
    this.shield = Math.min(s.shield, s.maxShield);
    if (this.shieldMesh) this.shieldMesh.visible = this.shield > 0;
    this.armor = s.armor;
    this.baseSpeed = s.baseSpeed;
    this.distance = Math.min(s.distance, Math.max(0, path.length - 0.01));
    this.volatile = s.volatile;
    const p = sampleAt(path, this.distance);
    this.group.position.copy(p.pos);
    this.tangent.copy(p.tangent);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.bodyMat.dispose();
    this.wingMat?.dispose();
    this.shieldMat?.dispose();
  }
}

/** Place a cylinder-style mesh so it spans from a to b. */
export function alignBetween(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  mesh.scale.set(1, Math.max(len, 1e-4), 1);
}
