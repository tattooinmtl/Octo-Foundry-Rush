/**
 * Creeps: a sphere-bodied octopus with four legs on an unsynchronised gait.
 *
 * Every creep gets its own gait signature (leg frequency multipliers, phase
 * offsets, stride length, lift height and a gait pattern) so they look like
 * the same species but never move in lockstep.
 */

import * as THREE from 'three';
import { CREEP_TIERS, type CreepTier } from './config';
import { sampleAt, type GeneratedPath } from './path';

const BODY_GEO = new THREE.IcosahedronGeometry(0.26, 1);
const EYE_GEO = new THREE.SphereGeometry(0.055, 8, 6);
const LEG_GEO = new THREE.CylinderGeometry(0.028, 0.05, 1, 6);
const LEG_TIP_GEO = new THREE.SphereGeometry(0.045, 7, 6);
const ICE_GEO = new THREE.IcosahedronGeometry(0.42, 0);
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

type GaitPattern = 'diagonal' | 'wave' | 'gallop' | 'scatter';

const GAIT_PATTERNS: Record<GaitPattern, number[]> = {
  diagonal: [0, 0.5, 0.5, 0],
  wave: [0, 0.25, 0.5, 0.75],
  gallop: [0, 0.08, 0.55, 0.63],
  scatter: [0, 0.31, 0.66, 0.12],
};

export interface EnemyCallbacks {
  onDeath: (e: Enemy) => void;
  onLeak: (e: Enemy) => void;
  /** Called when a volatile creep detonates. */
  onVolatile: (e: Enemy) => void;
}

export class Enemy {
  readonly group = new THREE.Group();
  readonly tier: CreepTier;

  hp: number;
  maxHp: number;
  armor: number;
  baseSpeed: number;
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
  private body: THREE.Mesh;
  private tangent = new THREE.Vector3(1, 0, 0);
  private eyes: THREE.Mesh[] = [];
  private legs: { upper: THREE.Mesh; lower: THREE.Mesh; tip: THREE.Mesh }[] = [];
  private gaitFreq = 1;
  private gaitPhase: number[] = [0, 0, 0, 0];
  private legFreqMult: number[] = [1, 1, 1, 1];
  private stride = 0.24;
  private lift = 0.08;
  private scale: number;
  private bodyMat: THREE.MeshStandardMaterial;

  constructor(
    scene: THREE.Scene,
    path: GeneratedPath,
    hp: number,
    armor: number,
    speed: number,
    tierIndex: number,
    rand: number,
    private cb: EnemyCallbacks,
  ) {
    this.tier = CREEP_TIERS[tierIndex];
    this.maxHp = Math.round(hp * this.tier.hpMult);
    this.hp = this.maxHp;
    this.armor = armor + this.tier.armor;
    this.baseSpeed = speed * this.tier.speedMult;
    this.scale = this.tier.scale;

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
    this.group.add(this.body);

    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0xffe27a,
      emissive: 0xffb300,
      emissiveIntensity: 1.4,
      roughness: 0.3,
    });
    for (let i = 0; i < 2; i++) {
      const e = new THREE.Mesh(EYE_GEO, eyeMat);
      e.position.set(i === 0 ? -0.11 : 0.11, 0.12, 0.2);
      this.group.add(e);
      this.eyes.push(e);
    }

    for (let i = 0; i < 4; i++) {
      const upper = new THREE.Mesh(LEG_GEO, this.bodyMat);
      const lower = new THREE.Mesh(LEG_GEO, this.bodyMat);
      const tip = new THREE.Mesh(LEG_TIP_GEO, this.bodyMat);
      this.group.add(upper, lower, tip);
      this.legs.push({ upper, lower, tip });
    }

    this.group.scale.setScalar(this.scale);
    scene.add(this.group);

    const start = sampleAt(path, 0);
    this.group.position.copy(start.pos);
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Direction of travel along the road (used to lead moving targets). */
  get heading(): THREE.Vector3 {
    return this.tangent;
  }

  /** Current ground speed, slowed or stunned. */
  get currentSpeed(): number {
    return this.baseSpeed * this.slowFactor * (this.stunUntil > this.time ? 0 : 1);
  }

  get progress(): number {
    return this.distance;
  }

  /** Apply damage with armour, slow, burn and mark rules. Returns damage dealt. */
  takeDamage(raw: number, effect: string, opts: { ignoreArmor?: boolean; from?: string } = {}): number {
    if (!this.alive) return 0;
    let amount = raw;
    const marked = this.markUntil > this.time;
    if (marked) amount *= 1.25;
    const shred = this.shredUntil > this.time;
    const armor = Math.max(0, (shred ? 0 : this.armor) - (opts.ignoreArmor ? 999 : 0));
    if (armor > 0) amount = Math.max(amount * 0.2, amount - armor);
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

    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      if (this.volatile) this.cb.onVolatile(this);
      this.cb.onDeath(this);
    }
    return amount;
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
      this.group.add(this.ice);
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

    // Damage over time.
    if (this.burnUntil > this.time && this.burnDps > 0) {
      this.hp -= this.burnDps * dt;
      if (this.hp <= 0) {
        this.hp = 0;
        this.alive = false;
        if (this.volatile) this.cb.onVolatile(this);
        this.cb.onDeath(this);
        return;
      }
    }
    if (this.slowUntil <= this.time) this.slowFactor = 1;
    if (this.markUntil <= this.time) this.markUntil = 0;

    const stunned = this.stunUntil > this.time;
    const speed = this.baseSpeed * this.slowFactor * (stunned ? 0 : 1);
    this.distance += speed * dt;
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

    // Orientation + body bob (all local - the group carries the scale).
    const bob = Math.sin(this.time * this.gaitFreq * Math.PI * 2 * 2) * 0.018;
    this.body.position.y = 0.3 + bob;
    this.body.rotation.y = Math.atan2(s.tangent.x, s.tangent.z);
    for (const e of this.eyes) e.position.y = 0.12 + bob;

    if (!this.frozen) this.animateLegs(s.tangent, dt);
  }

  private animateLegs(tangent: THREE.Vector3, dt: number): void {
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    // Bone lengths live in the group's local space (the group carries scale).
    const l1 = 0.2;
    const l2 = 0.22;

    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const front = i < 2 ? 1 : -1;

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

      const hip = new THREE.Vector3(0, 0.24, 0)
        .addScaledVector(right, side * 0.12)
        .addScaledVector(tangent, front * 0.07);

      const foot = new THREE.Vector3(0, 0.02 + lift, 0)
        .addScaledVector(right, side * 0.26)
        .addScaledVector(tangent, along);

      // Two-bone IK in local space.
      const dir = foot.clone().sub(hip);
      let d = dir.length();
      const maxLen = (l1 + l2) * 0.98;
      if (d > maxLen) {
        dir.multiplyScalar(maxLen / d);
        d = maxLen;
      }
      if (d < 1e-4) d = 1e-4;
      dir.normalize();
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      const perp = up
        .clone()
        .sub(dir.clone().multiplyScalar(up.dot(dir)))
        .normalize()
        .addScaledVector(right, side * 0.35)
        .normalize();
      const knee = hip.clone().addScaledVector(dir, a).addScaledVector(perp, h);

      const leg = this.legs[i];
      alignBetween(leg.upper, hip, knee);
      alignBetween(leg.lower, knee, foot);
      leg.tip.position.copy(foot);
    }
    void dt;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.bodyMat.dispose();
    for (const e of this.eyes) (e.material as THREE.Material).dispose();
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
