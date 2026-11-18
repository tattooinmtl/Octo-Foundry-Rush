/**
 * Special weapons: the dashed targeting reticle, the Orbital Laser, the Deep
 * Freeze zone and the Hellfire strike. Purely visual + timing - the game
 * applies the damage through the callbacks each weapon fires.
 */

import * as THREE from 'three';
import type { Effects } from './effects';
import { LASER_DURATION, FREEZE_SECONDS, HELLFIRE_SECONDS } from './config';

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                         */
/* ------------------------------------------------------------------ */

const NOISE_GLSL = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise3(p);
      p = p * 2.02 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v;
  }
`;

/** Red -> purple -> green plasma palette for the laser. */
const PLASMA_GLSL = /* glsl */ `
  vec3 plasma(float w) {
    vec3 RED = vec3(1.0, 0.07, 0.16);
    vec3 PUR = vec3(0.62, 0.1, 1.0);
    vec3 GRN = vec3(0.18, 1.0, 0.48);
    vec3 c = mix(RED, PUR, smoothstep(0.32, 0.55, w));
    c = mix(c, GRN, smoothstep(0.6, 0.78, w));
    return c;
  }
`;

/** Black -> red -> orange -> yellow fire palette. */
const FIRE_GLSL = /* glsl */ `
  vec3 fire(float w) {
    vec3 c = mix(vec3(0.12, 0.0, 0.0), vec3(0.9, 0.08, 0.0), smoothstep(0.1, 0.4, w));
    c = mix(c, vec3(1.0, 0.45, 0.02), smoothstep(0.4, 0.65, w));
    c = mix(c, vec3(1.0, 0.92, 0.45), smoothstep(0.7, 0.95, w));
    return c;
  }
`;

const SIDE_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vP = position;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

function additive(extra: Partial<THREE.ShaderMaterialParameters>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    ...extra,
  });
}

/** Direction the orbital strikes come in from (tilted so the top-down camera sees a streak). */
const SKY_DIR = new THREE.Vector3(-0.32, 1, -0.5).normalize();
const SKY_LEN = 18;

/* ------------------------------------------------------------------ */
/* Targeting reticle                                                   */
/* ------------------------------------------------------------------ */

export class Targeter {
  readonly group = new THREE.Group();
  private ring: THREE.LineLoop;
  private inner: THREE.LineLoop;
  private fill: THREE.Mesh;
  private cross: THREE.LineSegments;
  private dashMat: THREE.LineDashedMaterial;
  private innerMat: THREE.LineDashedMaterial;
  private fillMat: THREE.MeshBasicMaterial;
  private crossMat: THREE.LineBasicMaterial;
  private time = 0;
  private baseColor = new THREE.Color();
  private valid = true;

  constructor(scene: THREE.Scene) {
    const circle = (n: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      return new THREE.BufferGeometry().setFromPoints(pts);
    };
    this.dashMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.12,
      gapSize: 0.08,
      transparent: true,
      opacity: 1,
      depthTest: false,
      fog: false,
    });
    this.innerMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.05,
      gapSize: 0.07,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      fog: false,
    });
    this.ring = new THREE.LineLoop(circle(96), this.dashMat);
    this.inner = new THREE.LineLoop(circle(64), this.innerMat);
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48), this.fillMat);
    this.fill.rotation.x = -Math.PI / 2;
    this.crossMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, fog: false });
    const c = 0.18;
    this.cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-c, 0, 0), new THREE.Vector3(-c * 0.35, 0, 0),
        new THREE.Vector3(c * 0.35, 0, 0), new THREE.Vector3(c, 0, 0),
        new THREE.Vector3(0, 0, -c), new THREE.Vector3(0, 0, -c * 0.35),
        new THREE.Vector3(0, 0, c * 0.35), new THREE.Vector3(0, 0, c),
      ]),
      this.crossMat,
    );
    for (const o of [this.fill, this.ring, this.inner, this.cross]) {
      o.renderOrder = 20;
      this.group.add(o);
    }
    this.group.position.y = 0.08;
    this.group.visible = false;
    scene.add(this.group);
  }

  show(radius: number, color: number): void {
    this.baseColor.setHex(color);
    this.ring.scale.setScalar(radius);
    this.ring.computeLineDistances();
    this.inner.scale.setScalar(radius * 0.62);
    this.inner.computeLineDistances();
    this.fill.scale.setScalar(radius);
    // Dash size is in local units, so scale it back to world size.
    this.dashMat.dashSize = 0.16 / radius;
    this.dashMat.gapSize = 0.1 / radius;
    this.innerMat.dashSize = 0.06 / (radius * 0.62);
    this.innerMat.gapSize = 0.09 / (radius * 0.62);
    this.applyColor();
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  moveTo(x: number, z: number): void {
    this.group.position.x = x;
    this.group.position.z = z;
  }

  setValid(v: boolean): void {
    if (v === this.valid) return;
    this.valid = v;
    this.applyColor();
  }

  private applyColor(): void {
    const c = this.valid ? this.baseColor : new THREE.Color(0xff2a2a);
    this.dashMat.color.copy(c);
    this.innerMat.color.copy(c);
    this.fillMat.color.copy(c);
    this.crossMat.color.copy(c);
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    this.ring.rotation.y += dt * 0.6;
    this.inner.rotation.y -= dt * 1.1;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    this.fillMat.opacity = 0.08 + 0.1 * pulse;
    this.dashMat.opacity = 0.75 + 0.25 * pulse;
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */

export interface StrikeHooks {
  /** Damage/status tick for everything inside the zone. */
  tick: (center: THREE.Vector3, radius: number, dt: number) => void;
  /** One-shot at the moment of impact. */
  impact?: (center: THREE.Vector3, radius: number) => void;
  shake: (amount: number) => void;
}

export abstract class Strike {
  readonly group = new THREE.Group();
  protected time = 0;
  done = false;

  constructor(
    protected scene: THREE.Scene,
    protected effects: Effects,
    protected center: THREE.Vector3,
    protected radius: number,
    protected hooks: StrikeHooks,
  ) {
    this.group.position.set(center.x, 0, center.z);
    scene.add(this.group);
  }

  abstract update(dt: number): void;

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.group.removeFromParent();
  }

  protected randomInZone(scale = 1): THREE.Vector3 {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * this.radius * scale;
    return new THREE.Vector3(this.center.x + Math.cos(a) * r, 0, this.center.z + Math.sin(a) * r);
  }
}

/* ------------------------------------------------------------------ */
/* Orbital Laser                                                       */
/* ------------------------------------------------------------------ */

const BEAM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uCore;
  uniform float uScale;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  ${NOISE_GLSL}
  ${PLASMA_GLSL}
  void main() {
    vec3 q = vec3(vP.x * uScale, vP.y * 0.85 - uTime * 7.0, vP.z * uScale);
    float w = fbm3(q + vec3(0.0, 0.0, uTime * 0.7) + 1.6 * fbm3(q * 1.35 + vec3(uTime * 1.3)));
    float facing = abs(dot(normalize(vN), normalize(vV)));
    vec3 col = plasma(w) * (0.55 + 1.6 * w);
    col += vec3(1.0, 0.92, 1.0) * pow(facing, 7.0) * uCore;
    float a = (0.3 + 0.9 * w) * pow(facing, 1.3) * uAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

const DISC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LASER_DISC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  varying vec2 vUv;
  ${NOISE_GLSL}
  ${PLASMA_GLSL}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    // swirl the fluid around the impact point
    vec2 sw = vec2(cos(ang + r * 3.0 - uTime * 3.0), sin(ang + r * 3.0 - uTime * 3.0)) * r;
    float w = fbm3(vec3(sw * 3.2, uTime * 1.4) + fbm3(vec3(p * 4.0, uTime * 2.0)));
    float ripple = 0.5 + 0.5 * sin(r * 26.0 - uTime * 16.0);
    float mask = smoothstep(1.0, 0.15, r);
    vec3 col = plasma(w + ripple * 0.15) * (0.7 + 1.4 * w) + vec3(1.0) * smoothstep(0.28, 0.0, r) * 1.5;
    float a = mask * (0.25 + 0.75 * w + 0.35 * ripple * mask) * uAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

export class OrbitalLaser extends Strike {
  private layers: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; r: number }[] = [];
  private core: THREE.Mesh;
  private disc: THREE.Mesh;
  private discMat: THREE.ShaderMaterial;
  private light: THREE.PointLight;
  private beamRoot = new THREE.Group();
  private sparkTimer = 0;
  private ringTimer = 0;
  private boltTimer = 0;
  private readonly total = LASER_DURATION + 0.4;

  constructor(scene: THREE.Scene, effects: Effects, center: THREE.Vector3, radius: number, hooks: StrikeHooks) {
    super(scene, effects, center, radius, hooks);

    // The beam column: base at the target, running up into the sky.
    this.beamRoot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), SKY_DIR);
    this.group.add(this.beamRoot);
    for (const [r, alpha, core, scale] of [
      [0.95, 0.42, 0, 1.6],
      [0.5, 1.0, 1.2, 3.2],
    ] as const) {
      const geo = new THREE.CylinderGeometry(r, r * 0.8, SKY_LEN, 40, 30, true);
      geo.translate(0, SKY_LEN / 2, 0);
      const mat = additive({
        uniforms: { uTime: { value: 0 }, uAlpha: { value: alpha }, uCore: { value: core }, uScale: { value: scale } },
        vertexShader: SIDE_VERT,
        fragmentShader: BEAM_FRAG,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      this.beamRoot.add(mesh);
      this.layers.push({ mesh, mat, r: alpha });
    }
    const coreGeo = new THREE.CylinderGeometry(0.11, 0.08, SKY_LEN, 12, 1, true);
    coreGeo.translate(0, SKY_LEN / 2, 0);
    this.core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: 0xfff2ff, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.core.frustumCulled = false;
    this.core.renderOrder = 9;
    this.beamRoot.add(this.core);

    this.discMat = additive({ uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } }, vertexShader: DISC_VERT, fragmentShader: LASER_DISC_FRAG });
    this.disc = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.6, radius * 2.6), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.05;
    this.disc.renderOrder = 7;
    this.group.add(this.disc);

    this.light = new THREE.PointLight(0xff2a6a, 0, 7, 1.6);
    this.light.position.y = 0.8;
    this.group.add(this.light);

    this.beamRoot.scale.set(0.05, 1, 0.05);
    effects.flash(center.clone().setY(0.4), 0xffffff, 1.8, 0.25);
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    if (t >= this.total) {
      this.done = true;
      return;
    }
    // Width envelope: snap open, wobble, collapse.
    let w: number;
    if (t < 0.18) w = t / 0.18;
    else if (t < LASER_DURATION) w = 1 + 0.08 * Math.sin(t * 37) + 0.05 * Math.sin(t * 13);
    else w = Math.max(0, 1 - (t - LASER_DURATION) / 0.4);
    this.beamRoot.scale.set(Math.max(0.02, w), 1, Math.max(0.02, w));

    for (const l of this.layers) l.mat.uniforms.uTime.value = t;
    this.discMat.uniforms.uTime.value = t;
    this.discMat.uniforms.uAlpha.value = Math.min(1, t * 5) * (t > LASER_DURATION ? w : 1);
    (this.core.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.3 * Math.random();
    const hue = (Math.sin(t * 5) + 1) / 2;
    this.light.color.setRGB(1 - hue * 0.5, 0.1 + hue * 0.5, 0.5 + hue * 0.4);
    this.light.intensity = (14 + Math.random() * 10) * w;

    if (t < LASER_DURATION) {
      this.hooks.tick(this.center, this.radius, dt);
      this.hooks.shake(dt * 1.6);

      const palette = [0xff2a4a, 0xb04dff, 0x4dff8a, 0xffffff];
      this.sparkTimer -= dt;
      if (this.sparkTimer <= 0) {
        this.sparkTimer = 0.045;
        const p = this.randomInZone(0.5).setY(0.12);
        this.effects.burst(p, palette[Math.floor(Math.random() * palette.length)], 4, 4.6);
      }
      this.ringTimer -= dt;
      if (this.ringTimer <= 0) {
        this.ringTimer = 0.32;
        this.effects.shockRing(this.center, palette[Math.floor(Math.random() * 3)], this.radius * 1.5, 0.45);
      }
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) {
        this.boltTimer = 0.07;
        const a = this.center.clone().setY(0.15);
        const b = this.randomInZone(1.3).setY(0.05);
        this.effects.lightning(a, b, palette[Math.floor(Math.random() * 3)], 0.12, 7);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Deep Freeze                                                         */
/* ------------------------------------------------------------------ */

const FROST_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uGrow;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float edge = uGrow + 0.12 * (noise3(vec3(p * 6.0, 1.0)) - 0.5);
    float inside = smoothstep(edge, edge - 0.08, r);
    // Crystalline cracks: thin ridges of noise.
    float n = fbm3(vec3(p * 7.0, 3.0));
    float cracks = smoothstep(0.03, 0.0, abs(n - 0.5));
    float n2 = fbm3(vec3(p * 15.0, 7.0));
    float fine = smoothstep(0.02, 0.0, abs(n2 - 0.5));
    float rim = smoothstep(0.1, 0.0, abs(r - edge + 0.04)) * step(r, edge + 0.05);
    float shimmer = 0.5 + 0.5 * sin(uTime * 3.0 + n * 20.0);
    vec3 col = vec3(0.1, 0.5, 1.0) * 0.9 + vec3(0.55, 0.9, 1.0) * (cracks * 1.1 + fine * 0.5) * (0.7 + 0.3 * shimmer) + vec3(0.5, 0.85, 1.0) * rim;
    float a = (inside * (0.42 + cracks * 0.5 + fine * 0.25) + rim * 0.8) * uAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

const SPIKE_GEO = new THREE.ConeGeometry(0.09, 0.62, 5, 1);
SPIKE_GEO.translate(0, 0.31, 0);

export class DeepFreeze extends Strike {
  private discMat: THREE.ShaderMaterial;
  private spikes: { mesh: THREE.Mesh; delay: number; h: number }[] = [];
  private spikeMat: THREE.MeshStandardMaterial;
  private light: THREE.PointLight;
  private readonly total = FREEZE_SECONDS + 0.9;

  constructor(scene: THREE.Scene, effects: Effects, center: THREE.Vector3, radius: number, hooks: StrikeHooks) {
    super(scene, effects, center, radius, hooks);

    this.discMat = additive({
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uGrow: { value: 0 } },
      vertexShader: DISC_VERT,
      fragmentShader: FROST_FRAG,
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.2, radius * 2.2), this.discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.045;
    disc.renderOrder = 7;
    this.group.add(disc);

    this.spikeMat = new THREE.MeshStandardMaterial({
      color: 0xcff2ff,
      emissive: 0x2a8cff,
      emissiveIntensity: 0.6,
      metalness: 0.2,
      roughness: 0.05,
      transparent: true,
      opacity: 0.85,
      flatShading: true,
    });
    const count = Math.round(16 * radius);
    for (let i = 0; i < count; i++) {
      const p = this.randomInZone(0.95);
      const m = new THREE.Mesh(SPIKE_GEO, this.spikeMat);
      m.position.set(p.x - center.x, 0, p.z - center.z);
      // lean outward from the centre
      const out = Math.atan2(m.position.x, m.position.z);
      m.rotation.set(0.25 + Math.random() * 0.35, out, 0, 'YXZ');
      m.scale.setScalar(0.001);
      this.group.add(m);
      const dist = Math.hypot(m.position.x, m.position.z) / radius;
      this.spikes.push({ mesh: m, delay: dist * 0.22, h: 0.6 + Math.random() * 0.9 });
    }

    this.light = new THREE.PointLight(0x7fdcff, 18, 6, 1.6);
    this.light.position.y = 1;
    this.group.add(this.light);

    const c = center.clone().setY(0.3);
    effects.flash(c, 0xe8fbff, 2.4, 0.3);
    effects.shockRing(center, 0x9fe8ff, radius * 1.25, 0.5);
    effects.shockRing(center, 0xffffff, radius * 0.8, 0.35);
    for (let i = 0; i < 6; i++) effects.mist(this.randomInZone(0.8).setY(0.2), 0xbfeaff);
    effects.burst(c, 0xdff6ff, 30, 5.5);
    hooks.impact?.(center, radius);
    hooks.shake(0.5);
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    if (t >= this.total) {
      this.done = true;
      return;
    }
    const grow = Math.min(1, t / 0.3);
    const fade = t > FREEZE_SECONDS ? 1 - (t - FREEZE_SECONDS) / 0.9 : 1;
    this.discMat.uniforms.uTime.value = t;
    this.discMat.uniforms.uGrow.value = grow;
    this.discMat.uniforms.uAlpha.value = fade;
    this.light.intensity = 18 * Math.max(0, 1 - t / 0.6) + 3 * fade;
    this.spikeMat.opacity = 0.85 * fade;

    for (const s of this.spikes) {
      const k = Math.min(1, Math.max(0, (t - s.delay) / 0.14));
      const ease = 1 - Math.pow(1 - k, 3);
      const sink = t > FREEZE_SECONDS ? fade : 1;
      s.mesh.scale.set(ease, ease * s.h * sink, ease);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hellfire                                                            */
/* ------------------------------------------------------------------ */

const FIRE_DISC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  varying vec2 vUv;
  ${NOISE_GLSL}
  ${FIRE_GLSL}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    // flames rush outward from the centre
    vec3 q = vec3(cos(ang) * 2.0, sin(ang) * 2.0, r * 4.0 - uTime * 2.6);
    float w = fbm3(q + fbm3(vec3(p * 5.0, uTime * 1.7)));
    float mask = smoothstep(1.0, 0.55, r + (w - 0.5) * 0.35);
    float heat = clamp(w * 1.25 + (1.0 - r) * 0.45, 0.0, 1.0);
    vec3 col = fire(heat * 0.92) * (0.5 + 0.75 * heat);
    float a = mask * (0.3 + 0.45 * heat) * uAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uSeed;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  varying vec2 vUv;
  ${NOISE_GLSL}
  ${FIRE_GLSL}
  void main() {
    float h = vUv.y; // 0 at base, 1 at tip
    float w = fbm3(vec3(vP.x * 6.0 + uSeed, vP.y * 3.0 - uTime * 5.0, vP.z * 6.0));
    float heat = clamp((1.0 - h) * 0.9 + w * 0.6 - 0.15, 0.0, 1.0);
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float a = 0.7 * heat * smoothstep(1.0, 0.6, h + (w - 0.5) * 0.5) * (0.4 + 0.6 * facing) * uAlpha;
    vec3 col = fire(heat * 0.9) * (0.6 + 0.7 * heat);
    gl_FragColor = vec4(col * a, a);
  }
`;

const METEOR_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  ${NOISE_GLSL}
  ${FIRE_GLSL}
  void main() {
    float w = fbm3(vP * 7.0 + vec3(0.0, uTime * 6.0, 0.0));
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float heat = clamp(w * 0.8 + facing * 0.6, 0.0, 1.0);
    vec3 col = fire(heat) * (1.0 + 1.6 * heat);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const FLAME_GEO = new THREE.ConeGeometry(0.2, 1, 10, 6, true);
FLAME_GEO.translate(0, 0.5, 0);

interface Ember {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
}

export class Hellfire extends Strike {
  private phase: 'falling' | 'burning' = 'falling';
  private meteor: THREE.Mesh;
  private meteorMat: THREE.ShaderMaterial;
  private trail: THREE.Mesh;
  private trailMat: THREE.ShaderMaterial;
  private discMat: THREE.ShaderMaterial;
  private disc: THREE.Mesh;
  private flames: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; base: number; phase: number }[] = [];
  private embers: Ember[] = [];
  private emberGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  private emberMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  private light: THREE.PointLight;
  private burnTime = 0;
  private emberTimer = 0;
  private readonly fallTime = 0.45;

  constructor(scene: THREE.Scene, effects: Effects, center: THREE.Vector3, radius: number, hooks: StrikeHooks) {
    super(scene, effects, center, radius, hooks);

    this.meteorMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: SIDE_VERT, fragmentShader: METEOR_FRAG });
    this.meteor = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 2), this.meteorMat);
    this.group.add(this.meteor);

    const trailGeo = new THREE.CylinderGeometry(0.34, 0.02, 6, 16, 12, true);
    trailGeo.translate(0, 3, 0);
    this.trailMat = additive({
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uSeed: { value: 3 } },
      vertexShader: SIDE_VERT,
      fragmentShader: FLAME_FRAG.replace('float h = vUv.y;', 'float h = vUv.y * 0.9;'),
    });
    this.trail = new THREE.Mesh(trailGeo, this.trailMat);
    this.trail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), SKY_DIR);
    this.trail.frustumCulled = false;
    this.meteor.add(this.trail);

    this.discMat = additive({ uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } }, vertexShader: DISC_VERT, fragmentShader: FIRE_DISC_FRAG });
    this.disc = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.3, radius * 2.3), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.05;
    this.disc.renderOrder = 7;
    this.disc.visible = false;
    this.group.add(this.disc);

    const count = Math.round(9 * radius);
    for (let i = 0; i < count; i++) {
      const p = this.randomInZone(0.85);
      const mat = additive({
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uSeed: { value: Math.random() * 50 } },
        vertexShader: SIDE_VERT,
        fragmentShader: FLAME_FRAG,
      });
      const mesh = new THREE.Mesh(FLAME_GEO, mat);
      mesh.position.set(p.x - center.x, 0.02, p.z - center.z);
      mesh.renderOrder = 8;
      mesh.visible = false;
      this.group.add(mesh);
      this.flames.push({ mesh, mat, base: 0.5 + Math.random() * 0.8, phase: Math.random() * 10 });
    }

    this.light = new THREE.PointLight(0xff6a1a, 0, 7, 1.5);
    this.light.position.y = 0.9;
    this.group.add(this.light);
    this.placeMeteor(0);
  }

  private placeMeteor(k: number): void {
    const d = (1 - k) * SKY_LEN * 0.8;
    this.meteor.position.copy(SKY_DIR).multiplyScalar(d).setY(0.3 + SKY_DIR.y * d);
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.meteorMat.uniforms.uTime.value = t;
    this.trailMat.uniforms.uTime.value = t;

    if (this.phase === 'falling') {
      const k = Math.min(1, t / this.fallTime);
      this.placeMeteor(k * k);
      this.light.intensity = 6 * k;
      if (k >= 1) this.erupt();
      return;
    }

    this.burnTime += dt;
    const b = this.burnTime;
    const end = HELLFIRE_SECONDS;
    const fade = b > end ? Math.max(0, 1 - (b - end) / 0.6) : 1;
    const ignite = Math.min(1, b / 0.18);
    this.discMat.uniforms.uTime.value = t;
    this.discMat.uniforms.uAlpha.value = ignite * fade;
    this.light.intensity = (10 + Math.random() * 8) * fade;
    for (const f of this.flames) {
      f.mat.uniforms.uTime.value = t;
      f.mat.uniforms.uAlpha.value = ignite * fade;
      const flick = f.base * (0.75 + 0.35 * Math.sin(t * 11 + f.phase) + 0.15 * Math.random());
      f.mesh.scale.set(1 + 0.15 * Math.sin(t * 7 + f.phase), flick * ignite * (0.4 + 0.6 * fade), 1);
    }

    if (b < end) {
      this.hooks.tick(this.center, this.radius, dt);
      this.emberTimer -= dt;
      if (this.emberTimer <= 0) {
        this.emberTimer = 0.03;
        this.spawnEmber();
      }
    }
    this.updateEmbers(dt);

    if (b >= end + 0.6 && this.embers.length === 0) this.done = true;
  }

  private erupt(): void {
    this.phase = 'burning';
    this.meteor.visible = false;
    this.disc.visible = true;
    for (const f of this.flames) f.mesh.visible = true;
    const c = this.center.clone().setY(0.3);
    this.effects.explosion(c, 0xff6a1a, 1.9);
    this.effects.flash(c, 0xfff0c0, 2.6, 0.25);
    this.effects.shockRing(this.center, 0xff3a0a, this.radius * 1.4, 0.5);
    this.effects.burst(c, 0xffb040, 34, 6);
    this.hooks.impact?.(this.center, this.radius);
    this.hooks.shake(1.1);
  }

  private spawnEmber(): void {
    if (this.embers.length > 140) return;
    const p = this.randomInZone(0.9);
    const mesh = new THREE.Mesh(this.emberGeo, this.emberMat.clone());
    (mesh.material as THREE.MeshBasicMaterial).color.setHSL(0.03 + Math.random() * 0.08, 1, 0.55);
    mesh.position.set(p.x - this.center.x, 0.1, p.z - this.center.z);
    this.group.add(mesh);
    this.embers.push({
      mesh,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.6),
      life: 0,
      max: 0.7 + Math.random() * 0.8,
    });
  }

  private updateEmbers(dt: number): void {
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life += dt;
      e.vel.x += (Math.random() - 0.5) * dt * 3;
      e.vel.z += (Math.random() - 0.5) * dt * 3;
      e.mesh.position.addScaledVector(e.vel, dt);
      e.mesh.rotation.x += dt * 8;
      e.mesh.rotation.y += dt * 6;
      const k = e.life / e.max;
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      if (k >= 1) {
        (e.mesh.material as THREE.Material).dispose();
        e.mesh.removeFromParent();
        this.embers.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const e of this.embers) (e.mesh.material as THREE.Material).dispose();
    this.embers = [];
    super.dispose();
  }
}
