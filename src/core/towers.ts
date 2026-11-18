/**
 * Towers: aiming, firing, and the per-effect fire behaviour.
 */

import * as THREE from 'three';
import type { Enemy } from './enemies';
import type { ProjectileSystem } from './projectiles';
import type { Effects } from './effects';
import type { AudioEngine } from './audio';
import { buildTowerVisual, type TowerVisual } from './geo';
import type { TowerSpec } from './towerDefs';

export interface TowerCtx {
  enemies: Enemy[];
  projectiles: ProjectileSystem;
  effects: Effects;
  audio: AudioEngine;
}

const LEVEL_MULT = [1, 1, 1.75, 2.7];

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Tower {
  readonly spec: TowerSpec;
  readonly visual: TowerVisual;
  padId: string;
  level = 1;
  cooldown = 0;
  private angle = 0;
  private muzzleWorld = new THREE.Vector3();
  private idleSpin = 0;
  private fireFlash = 0;

  constructor(scene: THREE.Scene, spec: TowerSpec, position: THREE.Vector3, padId: string) {
    this.spec = spec;
    this.padId = padId;
    this.visual = buildTowerVisual(spec);
    this.visual.group.position.copy(position);
    scene.add(this.visual.group);
  }

  /** Re-seat the tower on a new pad (the road changed under it). */
  moveTo(padId: string, position: THREE.Vector3): void {
    this.padId = padId;
    this.visual.group.position.copy(position).setY(0.06);
  }

  get position(): THREE.Vector3 {
    return this.visual.group.position;
  }

  get damage(): number {
    return this.spec.damage * LEVEL_MULT[this.level];
  }

  get dps(): number {
    return this.spec.dps * LEVEL_MULT[this.level];
  }

  get upgradeCost(): number {
    return Math.round((this.spec.price * 0.62 * this.level) / 5) * 5;
  }

  get sellValue(): number {
    let spent = this.spec.price;
    for (let l = 2; l <= this.level; l++) spent += Math.round((this.spec.price * 0.62 * (l - 1)) / 5) * 5;
    return Math.round(spent * 0.7);
  }

  upgrade(): void {
    if (this.level < 3) this.level++;
  }

  update(dt: number, ctx: TowerCtx): void {
    this.cooldown -= dt;
    this.idleSpin += dt * 0.6;
    this.fireFlash = Math.max(0, this.fireFlash - dt * 5);

    const target = this.findTarget(ctx.enemies);

    if (target) {
      const dx = target.position.x - this.position.x;
      const dz = target.position.z - this.position.z;
      const want = Math.atan2(dx, dz);
      this.angle = lerpAngle(this.angle, want, Math.min(1, dt * 9));
      this.visual.turret.rotation.y = this.angle;

      if (this.cooldown <= 0) {
        this.fire(ctx, target);
        this.cooldown = 1 / Math.max(0.05, this.spec.fireRate);
        this.fireFlash = 1;
      }
    } else {
      // Idle sweep so an idle tower still looks alive.
      this.visual.turret.rotation.y = this.angle + Math.sin(this.idleSpin) * 0.5;
    }

    // Muzzle glow pulse.
    this.visual.accent.emissiveIntensity = 1.3 + this.fireFlash * 3.2;
  }

  private findTarget(enemies: Enemy[]): Enemy | null {
    let best: Enemy | null = null;
    let bestProgress = -Infinity;
    const r2 = this.spec.range * this.spec.range;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - this.position.x;
      const dz = e.position.z - this.position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (e.progress > bestProgress) {
        bestProgress = e.progress;
        best = e;
      }
    }
    return best;
  }

  private fire(ctx: TowerCtx, target: Enemy): void {
    this.visual.muzzle.getWorldPosition(this.muzzleWorld);
    const origin = this.muzzleWorld.clone();
    const effect = this.spec.effect;
    const shape = this.spec.projectileShape;

    // --- Continuous flame cone -------------------------------------------
    if (shape === 'plume') {
      const dir = new THREE.Vector3(
        Math.sin(this.angle),
        0,
        Math.cos(this.angle),
      );
      let touched = 0;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const to = e.position.clone().sub(this.position);
        to.y = 0;
        const dist = to.length();
        if (dist > this.spec.range) continue;
        to.normalize();
        if (to.dot(dir) < 0.78) continue;
        e.takeDamage(this.damage, 'burn');
        touched++;
      }
      ctx.effects.burst(origin.clone().addScaledVector(dir, 0.5), this.spec.color, 3, 1.6);
      ctx.audio.fire('plume');
      return;
    }

    // --- Hitscan rail beam ----------------------------------------------
    if (effect === 'beam') {
      const dir = new THREE.Vector3(Math.sin(this.angle), 0, Math.cos(this.angle));
      const end = origin.clone().addScaledVector(dir, this.spec.range);
      ctx.effects.beam(origin, end, this.spec.color, 0.22, 0.05);
      ctx.effects.beam(origin, end, 0xffffff, 0.12, 0.016);
      ctx.effects.flash(target.position.clone().setY(0.35), this.spec.color, 0.7, 0.2);
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const rel = e.position.clone().sub(origin);
        const along = rel.dot(dir);
        if (along < 0 || along > this.spec.range) continue;
        const perp = rel.clone().addScaledVector(dir, -along).length();
        if (perp < 0.45) e.takeDamage(this.damage, 'none');
      }
      ctx.audio.fire('lance');
      ctx.audio.impact('splash');
      return;
    }

    // --- Chain lightning --------------------------------------------------
    if (effect === 'chain') {
      let from = origin.clone();
      let current: Enemy | null = target;
      const hitIds = new Set<Enemy>();
      let jumps = 3;
      while (current && jumps >= 0) {
        const to = current.position.clone().setY(0.42);
        ctx.effects.lightning(from, to, this.spec.color, 0.18, 7);
        current.takeDamage(this.damage, 'chain');
        hitIds.add(current);
        const next = ctx.enemies
          .filter((e) => e.alive && !hitIds.has(e) && e.position.distanceTo(current!.position) < 4.4)
          .sort((a, b) => a.position.distanceTo(current!.position) - b.position.distanceTo(current!.position))[0];
        from = to;
        current = next ?? null;
        jumps--;
      }
      ctx.audio.fire('bolt');
      ctx.audio.impact('chain');
      return;
    }

    // --- Standard projectiles --------------------------------------------
    const aim = target.position.clone();
    // Lead the target so shots do not trail behind it.
    const roughFlight = origin.distanceTo(aim) / 14;
    aim.addScaledVector(target.heading, target.currentSpeed * roughFlight * 0.9);

    const burst = Math.max(1, this.spec.burst);
    for (let i = 0; i < burst; i++) {
      const spread = burst > 1 ? (i - (burst - 1) / 2) * 0.11 : 0;
      const behaviour =
        effect === 'homing' ? 'homing' : effect === 'ricochet' ? 'ricochet' : effect === 'pierce' ? 'pierce' : undefined;
      ctx.projectiles.spawn(this.spec, origin, target, { damage: this.damage, behaviour, spread, aim });
    }
    ctx.audio.fire(shape);
  }
}
