/**
 * Terminator-2 style time-displacement spheres: a crackling plasma bubble half
 * sunk into the floor, with lightning crawling over its skin and arcs that
 * lash out and strike the ground around it. Purely cosmetic.
 */

import * as THREE from 'three';
import type { Effects } from './effects';

const SEGS = 12;
const R = 0.55; // sphere radius
const CY = 0.16; // sphere centre height (bottom is sunk into the plate)

const tA = new THREE.Vector3();
const tB = new THREE.Vector3();
const tC = new THREE.Vector3();
const tD = new THREE.Vector3();

function makeStrip(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array((SEGS + 1) * 2 * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  const idx: number[] = [];
  for (let i = 0; i < SEGS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(idx);
  return geo;
}

/** Camera-facing lightning ribbon (thick enough to read from the top-down camera). */
class Bolt {
  readonly pts: THREE.Vector3[] = [];
  readonly core: THREE.Mesh;
  readonly glow: THREE.Mesh;
  life = 0;
  maxLife = 0;
  rejitter = 0;
  active = false;
  // strike params
  a = new THREE.Vector3();
  b = new THREE.Vector3();
  d1 = new THREE.Vector3();
  d2 = new THREE.Vector3();

  constructor(parent: THREE.Object3D, color: number, private coreW: number, private glowW: number) {
    for (let i = 0; i <= SEGS; i++) this.pts.push(new THREE.Vector3());
    const mk = (c: number, op: number) =>
      new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: op,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
    this.glow = new THREE.Mesh(makeStrip(), mk(color, 0.6));
    this.core = new THREE.Mesh(makeStrip(), mk(0xf4fbff, 1));
    for (const m of [this.glow, this.core]) {
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 5;
      parent.add(m);
    }
  }

  setVisible(v: boolean): void {
    this.core.visible = v;
    this.glow.visible = v;
  }

  setFade(f: number): void {
    (this.core.material as THREE.MeshBasicMaterial).opacity = f;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.6 * f;
  }

  /** Rebuild both ribbons so they face the camera (cam is in the portal's local space). */
  build(cam: THREE.Vector3): void {
    const write = (mesh: THREE.Mesh, w: number) => {
      const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i <= SEGS; i++) {
        const p = this.pts[i];
        const prev = this.pts[Math.max(0, i - 1)];
        const next = this.pts[Math.min(SEGS, i + 1)];
        tA.subVectors(next, prev);
        tB.subVectors(cam, p);
        tC.crossVectors(tA, tB);
        if (tC.lengthSq() < 1e-10) tC.set(1, 0, 0);
        tC.normalize();
        const taper = 0.35 + 0.65 * Math.sin((Math.PI * i) / SEGS);
        const hw = w * 0.5 * taper;
        const o = i * 6;
        arr[o] = p.x + tC.x * hw;
        arr[o + 1] = p.y + tC.y * hw;
        arr[o + 2] = p.z + tC.z * hw;
        arr[o + 3] = p.x - tC.x * hw;
        arr[o + 4] = p.y - tC.y * hw;
        arr[o + 5] = p.z - tC.z * hw;
      }
      attr.needsUpdate = true;
    };
    write(this.glow, this.glowW);
    write(this.core, this.coreW);
  }

  /** Jagged line from a to b, bowed upward. */
  jag(jitter: number, bow: number): void {
    const len = this.a.distanceTo(this.b);
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const env = Math.sin(Math.PI * t);
      const p = this.pts[i].lerpVectors(this.a, this.b, t);
      p.y += bow * len * env;
      if (i > 0 && i < SEGS) {
        const kink = Math.random() < 0.15 ? 2.2 : 1;
        const j = jitter * len * env * kink;
        p.x += (Math.random() - 0.5) * j;
        p.y += (Math.random() - 0.5) * j;
        p.z += (Math.random() - 0.5) * j;
      }
    }
  }

  /** Crawling arc over the sphere's skin between d1 and d2. */
  crawl(center: THREE.Vector3, radius: number): void {
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const env = Math.sin(Math.PI * t);
      tD.lerpVectors(this.d1, this.d2, t).normalize();
      const r = radius * (1.01 + env * (0.04 + Math.random() * 0.1));
      const p = this.pts[i].copy(center).addScaledVector(tD, r);
      if (i > 0 && i < SEGS) {
        const j = 0.07 * env;
        p.x += (Math.random() - 0.5) * j;
        p.y += (Math.random() - 0.5) * j;
        p.z += (Math.random() - 0.5) * j;
      }
    }
  }
}

function randomSkinDir(out: THREE.Vector3): THREE.Vector3 {
  // Only the part of the sphere that is above the floor.
  do {
    out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  } while (out.lengthSq() > 1 || out.lengthSq() < 0.05);
  out.normalize();
  if (out.y < -0.2) out.y = -out.y;
  return out;
}

let poolTex: THREE.CanvasTexture | null = null;
function glowPoolTexture(): THREE.CanvasTexture {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}

const SPHERE_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vP = position;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPHERE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColor;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(f, 2.3);
    float bands = sin(vP.y * 34.0 + uTime * 26.0 + sin(vP.x * 18.0 + uTime * 9.0) * 2.5)
                * sin(vP.x * 29.0 - uTime * 19.0 + vP.z * 23.0);
    bands = smoothstep(0.72, 1.0, bands);
    float sparkle = step(0.982, hash(floor(vP * 26.0) + floor(uTime * 22.0)));
    vec3 col = mix(uColor, vec3(1.0), clamp(rim * 0.35 + bands * 0.45 + sparkle, 0.0, 1.0));
    float a = (0.07 + rim * 1.05 + bands * 0.4 + sparkle * 0.9) * uIntensity;
    gl_FragColor = vec4(col * a, clamp(a, 0.0, 1.0));
  }
`;

export class ElectricPortal {
  readonly group = new THREE.Group();
  private sphere: THREE.Mesh;
  private sphereMat: THREE.ShaderMaterial;
  private core: THREE.Mesh;
  private pool: THREE.Mesh;
  private light: THREE.PointLight;
  private skin: Bolt[] = [];
  private strikes: Bolt[] = [];
  private strikeTimers: number[] = [];
  private center = new THREE.Vector3(0, CY, 0);
  private camLocal = new THREE.Vector3();
  private time = Math.random() * 10;
  private pulse = 0;

  constructor(
    pos: THREE.Vector3,
    private tint: number,
    private effects: Effects,
    private onStrike: () => void,
  ) {
    this.group.position.set(pos.x, 0, pos.z);

    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uColor: { value: new THREE.Color(tint) },
      },
      vertexShader: SPHERE_VERT,
      fragmentShader: SPHERE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), this.sphereMat);
    this.sphere.position.copy(this.center);
    this.sphere.renderOrder = 4;
    this.group.add(this.sphere);

    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.26, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0xe8f6ff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.core.position.copy(this.center);
    this.group.add(this.core);

    this.pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({
        map: glowPoolTexture(),
        color: tint,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.y = 0.03;
    this.group.add(this.pool);

    this.light = new THREE.PointLight(tint, 5, 4, 2);
    this.light.position.set(0, CY + 0.5, 0);
    this.group.add(this.light);

    for (let i = 0; i < 6; i++) {
      const b = new Bolt(this.group, tint, 0.04, 0.16);
      this.respawnSkin(b);
      b.life = Math.random() * b.maxLife;
      this.skin.push(b);
    }
    for (let i = 0; i < 4; i++) {
      this.strikes.push(new Bolt(this.group, tint, 0.055, 0.22));
      this.strikeTimers.push(0.1 + Math.random() * 0.5);
    }
  }

  private respawnSkin(b: Bolt): void {
    randomSkinDir(b.d1);
    randomSkinDir(b.d2);
    b.d2.lerp(b.d1, 0.45).normalize();
    b.life = 0;
    b.maxLife = 0.05 + Math.random() * 0.14;
    b.rejitter = 0;
    b.active = true;
    b.setVisible(true);
  }

  private fireStrike(b: Bolt, loud = false): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = 0.9 + Math.random() * (loud ? 1.4 : 1.1);
    const cx = Math.cos(ang);
    const cz = Math.sin(ang);
    tA.set(cx, 0.25 + Math.random() * 0.6, cz).normalize();
    b.a.copy(this.center).addScaledVector(tA, R * 0.96);
    b.b.set(cx * dist + (Math.random() - 0.5) * 0.3, 0.02, cz * dist + (Math.random() - 0.5) * 0.3);
    b.life = 0;
    b.maxLife = 0.1 + Math.random() * 0.16;
    b.rejitter = 0;
    b.active = true;
    b.setVisible(true);
    b.jag(0.22, 0.22);

    // Scorch spark where it lands.
    const hit = b.b.clone().add(this.group.position);
    this.effects.flash(hit.clone().setY(0.06), 0xdff2ff, 0.32, 0.1);
    this.effects.burst(hit.setY(0.08), 0xa8dcff, loud ? 6 : 3, 2.4);
    this.onStrike();
  }

  /** Big flare when something passes through (creep spawns / escapes). */
  discharge(): void {
    this.pulse = 1;
    for (const b of this.strikes) this.fireStrike(b, true);
    const c = this.center.clone().add(this.group.position);
    this.effects.flash(c, 0xffffff, 1.5, 0.18);
    this.effects.shockRing(c, this.tint, 1.6, 0.35);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.pulse = Math.max(0, this.pulse - dt * 2.4);
    this.camLocal.copy(camera.position).sub(this.group.position);

    const t = this.time;
    let flicker = 0.78 + 0.22 * Math.sin(t * 53) * Math.sin(t * 31.7);
    if (Math.random() < 0.06) flicker += 0.45;
    const intensity = flicker + this.pulse * 1.6;

    this.sphereMat.uniforms.uTime.value = t;
    this.sphereMat.uniforms.uIntensity.value = intensity;
    const s = 1 + this.pulse * 0.38 + Math.sin(t * 9.3) * 0.018 + (Math.random() - 0.5) * 0.02;
    this.sphere.scale.setScalar(s);
    this.core.scale.setScalar(0.8 + Math.random() * 0.35 + this.pulse * 0.8);
    (this.core.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.3 * flicker + this.pulse * 0.4;
    (this.pool.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * flicker + this.pulse * 0.4;
    this.light.intensity = 3 + 4 * flicker + this.pulse * 10;

    for (const b of this.skin) {
      b.life += dt;
      if (b.life >= b.maxLife) {
        // brief dark gap between crawls
        if (b.active) {
          b.active = false;
          b.setVisible(false);
          b.life = 0;
          b.maxLife = Math.random() * 0.12;
        } else {
          this.respawnSkin(b);
        }
        continue;
      }
      if (!b.active) continue;
      b.rejitter -= dt;
      if (b.rejitter <= 0) {
        b.rejitter = 0.03;
        b.crawl(this.center, R * s);
      }
      b.setFade(1 - (b.life / b.maxLife) * 0.6);
      b.build(this.camLocal);
    }

    for (let i = 0; i < this.strikes.length; i++) {
      const b = this.strikes[i];
      if (b.active) {
        b.life += dt;
        if (b.life >= b.maxLife) {
          b.active = false;
          b.setVisible(false);
        } else {
          b.rejitter -= dt;
          if (b.rejitter <= 0) {
            b.rejitter = 0.035;
            b.jag(0.22, 0.22);
          }
          // flicker on/off like real arcs
          b.setFade(Math.random() < 0.2 ? 0.25 : 1 - (b.life / b.maxLife) * 0.5);
          b.build(this.camLocal);
        }
      }
      this.strikeTimers[i] -= dt;
      if (this.strikeTimers[i] <= 0) {
        this.strikeTimers[i] = 0.15 + Math.random() * 0.6;
        if (!b.active) this.fireStrike(b);
      }
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
    this.group.removeFromParent();
  }
}
