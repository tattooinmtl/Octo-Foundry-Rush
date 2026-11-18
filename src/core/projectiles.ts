/**
 * Projectiles. Every tower shoots a mesh built from its projectile style, and
 * each damage effect gets its own impact behaviour.
 */

import * as THREE from 'three';
import { alignBetween, type Enemy } from './enemies';
import { makeProjectileMesh } from './geo';
import type { Effects } from './effects';
import type { AudioEngine } from './audio';
import { canHitFlying, type TowerSpec } from './towerDefs';

export interface ProjectileCtx {
  enemies: Enemy[];
  effects: Effects;
  audio: AudioEngine;
}

type Behaviour = 'straight' | 'homing' | 'arc' | 'pierce' | 'ricochet';

export class Projectile {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  damage: number;
  effect: string;
  color: number;
  behaviour: Behaviour;
  target: Enemy | null = null;
  life = 0;
  travelled = 0;
  totalDist = 12;
  arcHeight = 0;
  originY = 0;
  pierceLeft = 0;
  ricochetLeft = 0;
  dead = false;
  /** Ground-only rounds (mines, slams) pass under flying creeps. */
  groundOnly = false;
  /** Creeps this round already hit (a piercing/ricochet round must not re-hit them). */
  readonly hitSet = new Set<Enemy>();

  constructor(
    mesh: THREE.Object3D,
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    spec: TowerSpec,
    behaviour: Behaviour,
    damage: number,
  ) {
    this.mesh = mesh;
    this.pos = pos.clone();
    this.dir = dir.clone().normalize();
    this.speed = behaviour === 'arc' ? 7 : behaviour === 'pierce' ? 22 : 14;
    this.damage = damage;
    this.effect = spec.effect;
    this.color = spec.color;
    this.behaviour = behaviour;
    this.originY = pos.y;
    this.arcHeight = behaviour === 'arc' ? 0.9 : 0;
    this.groundOnly = !canHitFlying(spec);
    // Audit fix: these were never initialised, so piercing rounds stopped at
    // the first creep and ricochets could bounce forever.
    this.pierceLeft = behaviour === 'pierce' || spec.effect === 'pierce' ? 3 : 0;
    this.ricochetLeft = spec.effect === 'ricochet' ? 3 : 0;
  }
}

export class ProjectileSystem {
  private list: Projectile[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, private effects: Effects) {
    this.scene = scene;
  }

  get count(): number {
    return this.list.length;
  }

  spawn(
    spec: TowerSpec,
    origin: THREE.Vector3,
    target: Enemy | null,
    opts: { damage?: number; behaviour?: Behaviour; spread?: number; aim?: THREE.Vector3 } = {},
  ): void {
    const mesh = makeProjectileMesh(spec.projectileShape, spec.color);
    const behaviour =
      opts.behaviour ??
      (spec.projectileShape === 'shell'
        ? 'arc'
        : spec.effect === 'homing' || spec.projectileShape === 'spore' || spec.projectileShape === 'drone'
          ? 'homing'
          : spec.effect === 'pierce' || spec.projectileShape === 'lance'
            ? 'pierce'
            : spec.effect === 'ricochet'
              ? 'ricochet'
              : 'straight');

    let dir = new THREE.Vector3(0, 0, 1);
    const aimPoint = opts.aim ?? (target ? target.position.clone() : null);
    if (aimPoint) {
      const lead = aimPoint.clone().sub(origin).normalize();
      if (opts.spread) {
        lead.applyAxisAngle(new THREE.Vector3(0, 1, 0), opts.spread);
      }
      dir = lead;
    }    const p = new Projectile(mesh, origin, dir, spec, behaviour, opts.damage ?? spec.damage);
    p.target = target;
    if (behaviour === 'homing' && target) p.speed = 9.5;
    // A lobbed shell must come back down on its target, so the arc is sized
    // from the real flight distance.
    if (behaviour === 'arc' && aimPoint) {
      const flight = origin.distanceTo(aimPoint);
      p.totalDist = Math.max(0.5, flight);
      p.arcHeight = Math.min(0.85, flight * 0.14);
    }
    mesh.position.copy(p.pos);
    this.scene.add(mesh);
    this.list.push(p);
  }

  update(dt: number, ctx: ProjectileCtx): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life += dt;

      if (p.behaviour === 'homing' && p.target && p.target.alive) {
        const want = p.target.position.clone().sub(p.pos).normalize();
        p.dir.lerp(want, Math.min(1, dt * 5)).normalize();
      }

      const step = p.speed * dt;
      p.pos.addScaledVector(p.dir, step);
      p.travelled += step;

      if (p.behaviour === 'arc') {
        const t = Math.min(1, p.travelled / p.totalDist);
        p.pos.y = p.originY + p.arcHeight * Math.sin(t * Math.PI);
      }

      p.mesh.position.copy(p.pos);
      const spin = p.mesh.userData.spin as THREE.Object3D | undefined;
      if (spin) {
        spin.rotation.z += dt * 6;
        spin.rotation.x += dt * 3;
      }
      if (p.behaviour === 'arc') p.mesh.rotation.z = 0;

      // Collision is measured on the ground plane: a lobbed shell passes OVER a
      // creep's body height, so a 3D distance test would let it slip through.
      let hit: Enemy | null = null;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        if (p.groundOnly && e.flying) continue;
        if (p.hitSet.has(e)) continue;
        const dx = e.position.x - p.pos.x;
        const dz = e.position.z - p.pos.z;
        if (dx * dx + dz * dz < 0.38 * 0.38) {
          hit = e;
          break;
        }
      }

      if (hit) {
        this.impact(p, hit, ctx);
      } else if (p.life > 3.2 || p.travelled > 16) {
        this.fizzle(p, ctx);
      }
    }
  }

  private fizzle(p: Projectile, ctx: ProjectileCtx): void {
    this.effects.burst(p.pos, p.color, 3, 1.1);
    this.remove(p);
  }

  private remove(p: Projectile): void {
    this.scene.remove(p.mesh);
    this.list = this.list.filter((x) => x !== p);
  }

  private impact(p: Projectile, hit: Enemy, rawCtx: ProjectileCtx): void {
    const { effects, audio } = rawCtx;
    // Ground-only blasts cannot reach anything flying overhead.
    const ctx = p.groundOnly ? { ...rawCtx, enemies: rawCtx.enemies.filter((e) => !e.flying) } : rawCtx;
    p.hitSet.add(hit);

    switch (p.effect) {
      case 'splash': {
        effects.explosion(p.pos, p.color, 0.8);
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          const d = e.position.distanceTo(p.pos);
          if (d < 1.25) {
            const falloff = 1 - d / 1.25;
            e.takeDamage(p.damage * (0.45 + 0.55 * falloff), 'splash');
          }
        }
        audio.impact('splash');
        break;
      }
      case 'burn': {
        effects.burst(p.pos, p.color, 8, 2.2);
        for (const e of ctx.enemies) {
          if (e.alive && e.position.distanceTo(p.pos) < 0.85) {
            e.takeDamage(p.damage, 'burn');
          }
        }
        audio.impact('burn');
        break;
      }
      case 'chill': {
        effects.mist(p.pos, p.color);
        for (const e of ctx.enemies) {
          if (e.alive && e.position.distanceTo(p.pos) < 1.0) {
            e.takeDamage(p.damage, 'chill');
          }
        }
        audio.impact('chill');
        break;
      }
      case 'pull': {
        effects.shockRing(p.pos, p.color, 1.5, 0.5);
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          const d = e.position.distanceTo(p.pos);
          if (d < 2.2) {
            e.takeDamage(p.damage, 'pull');
            e.pullTarget = Math.min(1.6, d);
          }
        }
        audio.impact('splash');
        break;
      }
      case 'volatile': {
        effects.explosion(p.pos, p.color, 0.9);
        for (const e of ctx.enemies) {
          if (e.alive && e.position.distanceTo(p.pos) < 1.5) {
            e.takeDamage(p.damage * 1.4, 'volatile');
          }
        }
        audio.impact('splash');
        break;
      }
      case 'ricochet': {
        hit.takeDamage(p.damage, p.effect);
        effects.burst(p.pos, p.color, 5, 2.4);
        audio.impact('splash');
        // Bounce to a new target.
        p.ricochetLeft -= 1;
        const next = ctx.enemies
          .filter((e) => e.alive && e !== hit && !p.hitSet.has(e) && e.position.distanceTo(p.pos) < 5)
          .sort((a, b) => a.position.distanceTo(p.pos) - b.position.distanceTo(p.pos))[0];
        if (next && p.ricochetLeft > 0) {
          p.dir.copy(next.position.clone().sub(p.pos).normalize());
          p.travelled = 0;
          p.life = 0;
          return;
        }
        break;
      }
      case 'pierce': {
        hit.takeDamage(p.damage, p.effect);
        effects.burst(p.pos, p.color, 4, 2.6);
        audio.impact('splash');
        p.pierceLeft -= 1;
        if (p.pierceLeft > 0) {
          // Keep going through the crowd.
          p.life = 0;
          p.travelled = 0;
          const ahead = ctx.enemies
            .filter((e) => e.alive && e !== hit && e.position.distanceTo(p.pos) < 0.7)
            .sort((a, b) => a.progress - b.progress)[0];
          if (ahead) {
            p.dir.copy(ahead.position.clone().sub(p.pos).normalize());
          }
          return;
        }
        break;
      }
      case 'shred':
      case 'mark':
      case 'stun':
      case 'emp':
      case 'none':
      default: {
        hit.takeDamage(p.damage, p.effect);
        effects.burst(p.pos, p.color, 6, 2.4);
        audio.impact('default');
        break;
      }
    }

    this.remove(p);
  }

  /** Straight visual beam helper used by hitscan towers. */
  static drawBeam(effects: Effects, a: THREE.Vector3, b: THREE.Vector3, color: number): void {
    effects.beam(a, b, color, 0.22, 0.045);
    effects.beam(a, b, 0xffffff, 0.14, 0.014);
    const dir = b.clone().sub(a).normalize();
    alignBetween(new THREE.Object3D(), a, b);
    void dir;
  }

  clear(): void {
    for (const p of this.list) this.scene.remove(p.mesh);
    this.list = [];
  }
}
