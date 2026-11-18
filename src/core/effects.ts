/**
 * Pooled impact / explosion effects. Everything is procedural geometry - no
 * textures beyond a couple of tiny canvas gradients.
 */

import * as THREE from 'three';

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  from: number;
  to: number;
  vertical: boolean;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  spin: THREE.Vector3;
}

export class Effects {
  private rings: Ring[] = [];
  private particles: Particle[] = [];
  private beams: { mesh: THREE.Mesh; life: number; maxLife: number }[] = [];
  private bolts: { line: THREE.Line; life: number; maxLife: number }[] = [];
  private scene: THREE.Scene;
  private ringGeo: THREE.RingGeometry;
  private boxGeo: THREE.BoxGeometry;
  private sparkGeo: THREE.SphereGeometry;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 32);
    this.boxGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
    this.sparkGeo = new THREE.SphereGeometry(0.05, 6, 5);
  }

  private spawnRing(pos: THREE.Vector3, color: number, from: number, to: number, life: number, vertical = false): void {
    if (this.rings.length > 60) {
      const old = this.rings.shift();
      if (old) this.scene.remove(old.mesh);
    }
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.position.copy(pos);
    mesh.position.y = vertical ? pos.y : 0.06;
    if (!vertical) mesh.rotation.x = -Math.PI / 2;
    else mesh.lookAt(pos.x, pos.y, pos.z + 1);
    mesh.scale.setScalar(from);
    this.scene.add(mesh);
    this.rings.push({ mesh, life: 0, maxLife: life, from, to, vertical });
  }

  private spawnParticles(
    pos: THREE.Vector3,
    color: number,
    count: number,
    speed: number,
    life: number,
    size: number,
    gravity = -3.2,
  ): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length > 900) break;
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.boxGeo, mat);
      mesh.scale.setScalar(size * (0.5 + Math.random()));
      mesh.position.copy(pos);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.15, Math.random() - 0.5).normalize();
      const vel = dir.multiplyScalar(speed * (0.5 + Math.random()));
      vel.y += gravity * 0.25;
      this.scene.add(mesh);
      this.particles.push({
        mesh,
        vel,
        life: 0,
        maxLife: life * (0.6 + Math.random() * 0.7),
        spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      });
    }
  }

  /** Expanding shock ring on the ground. */
  shockRing(pos: THREE.Vector3, color: number, maxRadius = 1.4, life = 0.45): void {
    this.spawnRing(new THREE.Vector3(pos.x, 0, pos.z), color, 0.12, maxRadius, life);
  }

  /** Bright spherical flash. */
  flash(pos: THREE.Vector3, color: number, size = 0.8, life = 0.25): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.sparkGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);
    this.particles.push({
      mesh,
      vel: new THREE.Vector3(0, 0.4, 0),
      life: 0,
      maxLife: life,
      spin: new THREE.Vector3(),
    });
  }

  /** Directional impact spray. */
  burst(pos: THREE.Vector3, color: number, count = 10, speed = 3.2): void {
    this.spawnParticles(pos, color, count, speed, 0.5, 1);
  }

  /** Warm explosion: ring + embers + light flash. */
  explosion(pos: THREE.Vector3, color: number, scale = 1): void {
    this.shockRing(pos, color, 1.7 * scale, 0.42);
    this.spawnParticles(pos, color, 26, 4.4 * scale, 0.7, 1.5);
    this.flash(pos, 0xffffff, 1.1 * scale, 0.18);
  }

  /** Gold coins spraying out of a dead creep. */
  coins(pos: THREE.Vector3, count = 4): void {
    const geo = new THREE.CylinderGeometry(0.075, 0.075, 0.02, 10);
    for (let i = 0; i < count; i++) {
      if (this.particles.length > 900) break;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.9, roughness: 0.25 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.position.y += 0.25;
      const vel = new THREE.Vector3((Math.random() - 0.5) * 2.4, 2.2 + Math.random() * 1.4, (Math.random() - 0.5) * 2.4);
      this.scene.add(mesh);
      this.particles.push({
        mesh,
        vel,
        life: 0,
        maxLife: 0.8,
        spin: new THREE.Vector3(6 + Math.random() * 6, 6 + Math.random() * 6, 0),
      });
    }
  }

  /** Straight beam between two points. */
  beam(a: THREE.Vector3, b: THREE.Vector3, color: number, life = 0.18, radius = 0.035): void {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return;
    const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
    geo.translate(0, len / 2, 0);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.scene.add(mesh);
    this.beams.push({ mesh, life: 0, maxLife: life });
  }

  /** Jagged lightning polyline between two points. */
  lightning(a: THREE.Vector3, b: THREE.Vector3, color: number, life = 0.16, segments = 6): void {
    const points: THREE.Vector3[] = [];
    const dir = b.clone().sub(a);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = a.clone().addScaledVector(dir, t);
      if (i > 0 && i < segments) {
        const jitter = 0.16 * Math.sin(Math.PI * t);
        p.x += (Math.random() - 0.5) * jitter;
        p.y += (Math.random() - 0.5) * jitter;
        p.z += (Math.random() - 0.5) * jitter;
      }
      points.push(p);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.bolts.push({ line, life: 0, maxLife: life });
  }

  /** Cold mist puff. */
  mist(pos: THREE.Vector3, color: number): void {
    this.spawnParticles(pos, color, 12, 1.5, 0.9, 2.2, -0.4);
  }

  /** Acidic spore cloud. */
  spores(pos: THREE.Vector3, color: number): void {
    this.spawnParticles(pos, color, 14, 1.2, 1.1, 1.6, 0.4);
  }

  update(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      const t = Math.min(1, r.life / r.maxLife);
      const s = r.from + (r.to - r.from) * (1 - Math.pow(1 - t, 3));
      r.mesh.scale.setScalar(s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      if (t >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      const t = p.life / p.maxLife;
      p.vel.y += -3.2 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      if (p.mesh.position.y < 0.05) {
        p.mesh.position.y = 0.05;
        p.vel.y *= -0.35;
        p.vel.x *= 0.7;
        p.vel.z *= 0.7;
      }
      const mat = p.mesh.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = Math.max(0, 1 - t * t);
      if (t >= 1) {
        this.scene.remove(p.mesh);
        mat.dispose();
        this.particles.splice(i, 1);
      }
    }

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life += dt;
      const t = b.life / b.maxLife;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
      b.mesh.scale.x = b.mesh.scale.y = b.mesh.scale.z = 1 - t * 0.6;
      if (t >= 1) {
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        b.mesh.geometry.dispose();
        this.beams.splice(i, 1);
      }
    }

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life += dt;
      const t = b.life / b.maxLife;
      (b.line.material as THREE.LineBasicMaterial).opacity = 1 - t;
      if (t >= 1) {
        this.scene.remove(b.line);
        (b.line.material as THREE.Material).dispose();
        b.line.geometry.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }
}
