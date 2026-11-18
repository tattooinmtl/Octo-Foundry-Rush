/**
 * Procedural geometry + materials: hazard-striped industrial surfaces, chrome,
 * concrete, and the mesh factory that turns an AI-written projectile style
 * into something you can actually see on screen.
 */

import * as THREE from 'three';
import { COLORS } from './config';
import type { TowerSpec } from './towerDefs';

function canvasTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w = 128,
  h = 128,
  repeat: [number, number] = [1, 1],
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let hazardTex: THREE.CanvasTexture | null = null;
export function hazardTexture(): THREE.CanvasTexture {
  if (hazardTex) return hazardTex;
  hazardTex = canvasTexture(
    (ctx, w, h) => {
      ctx.fillStyle = '#ffd21e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1a1a1a';
      ctx.save();
      ctx.translate(-h, 0);
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 32, 0);
        ctx.lineTo(i * 32 + 18, 0);
        ctx.lineTo(i * 32 + 18 + h, h);
        ctx.lineTo(i * 32 + h, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = '#000';
      for (let i = 0; i < 120; i++) {
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    },
    128,
    128,
    [1, 1],
  );
  return hazardTex;
}

let concreteTex: THREE.CanvasTexture | null = null;
export function concreteTexture(): THREE.CanvasTexture {
  if (concreteTex) return concreteTex;
  concreteTex = canvasTexture(
    (ctx, w, h) => {
      // Light base: the material colour multiplies this, so it must stay bright.
      ctx.fillStyle = '#c3c9d1';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 3200; i++) {
        const v = 150 + Math.random() * 105;
        ctx.fillStyle = `rgba(${v},${v + 3},${v + 8},0.55)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      // Scuffs and panel seams.
      ctx.strokeStyle = 'rgba(70,76,84,0.55)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo((i * w) / 2, 0);
        ctx.lineTo((i * w) / 2, h);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(70,76,84,0.35)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 26; i++) {
        ctx.beginPath();
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.random() * 26 - 13, y + Math.random() * 26 - 13);
        ctx.stroke();
      }
    },
    256,
    256,
    [5, 9],
  );
  return concreteTex;
}

let padTex: THREE.CanvasTexture | null = null;
/** A recessed build socket: dark plate, thin warning outline, corner brackets. */
export function padTexture(): THREE.CanvasTexture {
  if (padTex) return padTex;
  padTex = canvasTexture(
    (ctx, w, h) => {
      const inset = 6;
      ctx.clearRect(0, 0, w, h);
      // Recessed plate.
      ctx.fillStyle = 'rgba(26,30,36,0.55)';
      ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
      ctx.strokeStyle = 'rgba(245,197,24,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(inset + 1, inset + 1, w - inset * 2 - 2, h - inset * 2 - 2);
      // Corner brackets.
      ctx.strokeStyle = 'rgba(245,197,24,0.95)';
      ctx.lineWidth = 5;
      const arm = 26;
      const corners: [number, number, number, number][] = [
        [inset, inset, 1, 1],
        [w - inset, inset, -1, 1],
        [inset, h - inset, 1, -1],
        [w - inset, h - inset, -1, -1],
      ];
      for (const [x, y, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(x + sx * arm, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * arm);
        ctx.stroke();
      }
    },
    128,
    128,
    [1, 1],
  );
  return padTex;
}

export function chromeMaterial(color = COLORS.chrome, rough = 0.18): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.95, roughness: rough });
}

export function darkSteelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: COLORS.darkSteel, metalness: 0.85, roughness: 0.42 });
}

export function hazardMaterial(repeat: [number, number] = [1, 1]): THREE.MeshStandardMaterial {
  const tex = hazardTexture().clone();
  tex.needsUpdate = true;
  tex.repeat.set(repeat[0], repeat[1]);
  return new THREE.MeshStandardMaterial({ map: tex, metalness: 0.55, roughness: 0.45 });
}

export function emissiveMaterial(color: number, intensity = 1.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    metalness: 0.2,
    roughness: 0.35,
  });
}

/* ------------------------------------------------------------------ */
/* Projectile meshes                                                   */
/* ------------------------------------------------------------------ */

const ORB_SHAPES = ['orb', 'plasma', 'vortex', 'pulse', 'disc', 'wave', 'helix', 'prism'];
const SHARD_SHAPES = ['shard', 'crystal', 'fang', 'needle', 'ember'];
const COIL_SHAPES = ['coil', 'chainmail', 'bolt', 'snare'];
const ROD_SHAPES = ['lance', 'pellet', 'shell'];
const DRONE_SHAPES = ['mine', 'drone'];
const FLOW_SHAPES = ['plume', 'torrent', 'spore', 'lattice'];

const FAMILIES = ['orb', 'shard', 'coil', 'drone', 'flow', 'rod'] as const;
export type ShapeFamily = (typeof FAMILIES)[number];

/**
 * The AI may invent a silhouette name the renderer has never seen. Map any
 * unknown name onto one of the build families by hash, so a brand new name
 * still produces a distinct-looking projectile and turret.
 */
export function shapeFamily(shape: string): ShapeFamily {
  const s = (shape || '').toLowerCase();
  if (ORB_SHAPES.includes(s)) return 'orb';
  if (SHARD_SHAPES.includes(s)) return 'shard';
  if (COIL_SHAPES.includes(s)) return 'coil';
  if (ROD_SHAPES.includes(s)) return 'rod';
  if (DRONE_SHAPES.includes(s)) return 'drone';
  if (FLOW_SHAPES.includes(s)) return 'flow';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return FAMILIES[Math.abs(h) % FAMILIES.length];
}

/** Build the visible projectile for a given style + colour. */
export function makeProjectileMesh(shape: string, color: number): THREE.Object3D {
  const mat = emissiveMaterial(color, 2.2);
  const group = new THREE.Group();
  const fam = shapeFamily(shape);

  if (shape === 'shell') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.19, 10), mat);
    body.rotation.x = Math.PI / 2;
    group.add(body);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 10), mat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.14;
    group.add(tip);
  } else if (shape === 'bolt') {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 0.26, 6), mat);
    b.rotation.x = Math.PI / 2;
    group.add(b);
  } else if (shape === 'pellet') {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), mat);
    group.add(p);
  } else if (shape === 'lance') {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.6, 6), mat);
    l.rotation.x = Math.PI / 2;
    group.add(l);
  } else if (fam === 'orb') {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), mat);
    group.add(core);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.016, 6, 18), mat);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    group.userData.spin = ring;
  } else if (fam === 'shard') {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), mat);
    s.scale.set(0.6, 1.5, 0.6);
    group.add(s);
  } else if (fam === 'coil') {
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.09 - i * 0.02, 0.018, 6, 14), mat);
      t.rotation.y = (i * Math.PI) / 3;
      t.position.z = i * 0.05 - 0.05;
      group.add(t);
    }
  } else if (fam === 'drone') {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), mat);
    group.add(d);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.02), mat);
    group.add(arm);
    group.userData.spin = arm;
  } else {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.22, 8), mat);
    f.rotation.x = Math.PI / 2;
    group.add(f);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat);
    glow.position.z = 0.09;
    group.add(glow);
  }

  return group;
}

/* ------------------------------------------------------------------ */
/* Tower meshes                                                        */
/* ------------------------------------------------------------------ */

export interface TowerVisual {
  group: THREE.Group;
  turret: THREE.Group;
  muzzle: THREE.Object3D;
  accent: THREE.MeshStandardMaterial;
}

/** Build the tower body + turret for a spec (preset or AI-forged). */
export function buildTowerVisual(spec: TowerSpec): TowerVisual {
  const group = new THREE.Group();
  const steel = darkSteelMaterial();
  const chrome = chromeMaterial();

  // ---- Shared base (every tower) ---------------------------------------
  // Heavier base plate with more segments so it reads as solid metal.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.14, 24), steel);
  base.position.y = 0.07;
  group.add(base);

  const baseRing = new THREE.Mesh(new THREE.TorusGeometry(0.305, 0.02, 8, 32), chrome);
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = 0.14;
  group.add(baseRing);

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.09, 16), chrome);
  collar.position.y = 0.165;
  group.add(collar);

  const collarBand = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.014, 6, 24), hazardMaterial([4, 1]));
  collarBand.rotation.x = Math.PI / 2;
  collarBand.position.y = 0.165;
  group.add(collarBand);

  const turret = new THREE.Group();
  turret.position.y = 0.21;
  group.add(turret);

  const accent = emissiveMaterial(spec.color, 1.5);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0.35);
  turret.add(muzzle);

  const barrel = (len: number, rad: number, x = 0, y = 0): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 16), steel);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, len / 2);
    turret.add(m);
    return m;
  };

  switch (spec.presetId) {
    case 'cannon': {
      // Thick barrel with a muzzle brake and a rear ammo drum.
      barrel(0.5, 0.09);
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16), chrome);
      brake.rotation.x = Math.PI / 2;
      brake.position.z = 0.53;
      turret.add(brake);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.22, 16), steel);
      drum.rotation.z = Math.PI / 2;
      drum.position.z = -0.14;
      turret.add(drum);
      const drumRing = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 8, 24), chrome);
      drumRing.rotation.z = Math.PI / 2;
      drumRing.position.z = -0.26;
      turret.add(drumRing);
      muzzle.position.z = 0.56;
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), accent);
      core.position.set(0, 0.12, 0.02);
      turret.add(core);
      break;
    }
    case 'tesla': {
      // Tall central coil with capacitor rings and side banks.
      const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.36, 16), chrome);
      coil.position.y = 0.16;
      turret.add(coil);
      for (let i = 0; i < 5; i++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(0.12 - i * 0.014, 0.018, 8, 24), accent);
        r.rotation.x = Math.PI / 2;
        r.position.y = 0.07 + i * 0.065;
        turret.add(r);
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), accent);
      tip.position.y = 0.4;
      turret.add(tip);
      // Side capacitor banks.
      for (const side of [-1, 1]) {
        const bank = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.14), steel);
        bank.position.set(side * 0.17, 0.12, 0);
        bank.rotation.z = side * 0.25;
        turret.add(bank);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), accent);
        cap.position.set(side * 0.17, 0.24, 0);
        turret.add(cap);
      }
      muzzle.position.set(0, 0.4, 0);
      break;
    }
    case 'frost': {
      // Cryo nozzle with cooling fins and a central crystal cluster.
      const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.32, 16), chrome);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.z = 0.16;
      turret.add(nozzle);
      for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.16), chrome);
        fin.rotation.x = Math.PI / 2;
        fin.rotation.z = (i / 4) * Math.PI * 2;
        fin.position.z = 0.08;
        turret.add(fin);
      }
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), accent);
      crystal.scale.set(0.6, 1.9, 0.6);
      crystal.position.set(0, 0.16, -0.04);
      turret.add(crystal);
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), accent);
      shard.position.set(0.1, 0.06, -0.06);
      turret.add(shard);
      const shard2 = shard.clone();
      shard2.position.set(-0.1, 0.06, -0.06);
      turret.add(shard2);
      muzzle.position.set(0, 0.16, 0.34);
      break;
    }
    case 'bio': {
      // Central spore sac with pods on articulated stalks.
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16), accent);
      bulb.position.y = 0.15;
      turret.add(bulb);
      const sacRing = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.016, 8, 24), chrome);
      sacRing.rotation.x = Math.PI / 2;
      sacRing.position.y = 0.15;
      turret.add(sacRing);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const pod = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), accent);
        pod.position.set(Math.cos(a) * 0.18, 0.09, Math.sin(a) * 0.18);
        turret.add(pod);
        const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 10), chrome);
        stalk.position.set(Math.cos(a) * 0.11, 0.1, Math.sin(a) * 0.11);
        stalk.rotation.z = Math.cos(a) * 0.5;
        stalk.rotation.x = -Math.sin(a) * 0.5;
        turret.add(stalk);
        const node = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), accent);
        node.position.set(Math.cos(a) * 0.11, 0.0, Math.sin(a) * 0.11);
        turret.add(node);
      }
      muzzle.position.set(0, 0.15, 0.16);
      break;
    }
    case 'flame': {
      // Dual flame nozzles with fuel tanks and an igniter assembly.
      barrel(0.32, 0.07, -0.08);
      barrel(0.32, 0.07, 0.08);
      for (const side of [-1, 1]) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.18, 16), steel);
        tank.rotation.z = Math.PI / 2;
        tank.position.set(side * 0.14, 0.06, -0.12);
        turret.add(tank);
        const valve = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), chrome);
        valve.position.set(side * 0.14, 0.06, -0.22);
        turret.add(valve);
      }
      const igniter = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), accent);
      igniter.position.set(0, 0.12, -0.06);
      turret.add(igniter);
      const vent = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 10), accent);
      vent.rotation.x = Math.PI / 2;
      vent.position.set(0, 0.12, 0.28);
      turret.add(vent);
      muzzle.position.set(0, 0.12, 0.34);
      break;
    }
    case 'multi': {
      // Three-barrel rotary drum with an ammo belt feed.
      barrel(0.4, 0.045, -0.1);
      barrel(0.4, 0.045, 0);
      barrel(0.4, 0.045, 0.1);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 20), chrome);
      drum.rotation.z = Math.PI / 2;
      drum.position.z = 0.06;
      turret.add(drum);
      const drumCap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 20), chrome);
      drumCap.rotation.z = Math.PI / 2;
      drumCap.position.z = 0.13;
      turret.add(drumCap);
      // Ammo belt on the side.
      const belt = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.26, 0.16), steel);
      belt.position.set(0.19, 0.08, 0);
      belt.rotation.z = 0.3;
      turret.add(belt);
      for (let i = 0; i < 5; i++) {
        const round_ = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), chrome);
        round_.position.set(0.19, 0.08 + i * 0.05, 0);
        turret.add(round_);
      }
      muzzle.position.set(0, 0, 0.42);
      break;
    }
    case 'sniper': {
      // Long rail barrel with scope, capacitor bank and bipod legs.
      barrel(0.8, 0.032, -0.05);
      barrel(0.8, 0.032, 0.05);
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 16), chrome);
      shroud.rotation.x = Math.PI / 2;
      shroud.position.set(0, 0.06, 0.42);
      turret.add(shroud);
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.26, 16), chrome);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.14, 0.1);
      turret.add(scope);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), accent);
      lens.position.set(0, 0.14, 0.24);
      turret.add(lens);
      const capBank = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.1), steel);
      capBank.position.set(0, 0.04, -0.16);
      turret.add(capBank);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), accent);
      cap.position.set(0, 0.12, -0.16);
      turret.add(cap);
      // Bipod legs.
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 8), steel);
        leg.position.set(side * 0.07, 0.02, -0.06);
        leg.rotation.x = side * 0.3;
        turret.add(leg);
        const foot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), chrome);
        foot.position.set(side * 0.07, -0.18, -0.2);
        turret.add(foot);
      }
      muzzle.position.set(0, 0, 0.82);
      break;
    }
    default: {
      // AI-forged tower: derive the silhouette from the projectile style.
      const fam = shapeFamily(spec.projectileShape);
      if (fam === 'orb') {
        const cradle = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.025, 10, 32), chrome);
        cradle.rotation.x = Math.PI / 2;
        turret.add(cradle);
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 2), accent);
        core.position.y = 0.15;
        turret.add(core);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.014, 8, 24), accent);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.15;
        turret.add(ring);
        const node = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), accent);
        node.position.set(0.14, 0.15, 0);
        turret.add(node);
        const node2 = node.clone();
        node2.position.set(-0.14, 0.15, 0);
        turret.add(node2);
        muzzle.position.set(0, 0.15, 0.18);
      } else if (fam === 'shard') {
        const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.2, 16), chrome);
        socket.position.y = 0.1;
        turret.add(socket);
        const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), accent);
        shard.scale.set(0.6, 2, 0.6);
        shard.position.y = 0.28;
        turret.add(shard);
        const shard2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), accent);
        shard2.scale.set(0.4, 1.1, 0.4);
        shard2.position.set(0.09, 0.14, 0.06);
        turret.add(shard2);
        const shard3 = shard2.clone();
        shard3.position.set(-0.09, 0.14, 0.06);
        turret.add(shard3);
        muzzle.position.set(0, 0.28, 0.14);
      } else if (fam === 'coil') {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.34, 16), chrome);
        post.position.y = 0.16;
        turret.add(post);
        for (let i = 0; i < 4; i++) {
          const r = new THREE.Mesh(new THREE.TorusGeometry(0.12 - i * 0.018, 0.018, 8, 24), accent);
          r.rotation.x = Math.PI / 2;
          r.position.y = 0.06 + i * 0.08;
          turret.add(r);
        }
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), accent);
        cap.position.y = 0.38;
        turret.add(cap);
        muzzle.position.set(0, 0.38, 0);
      } else if (fam === 'rod') {
        barrel(0.58, 0.045);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.14, 16), accent);
        tip.rotation.x = Math.PI / 2;
        tip.position.z = 0.62;
        turret.add(tip);
        const collar2 = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 8, 24), chrome);
        collar2.rotation.x = Math.PI / 2;
        collar2.position.z = 0.3;
        turret.add(collar2);
        muzzle.position.set(0, 0, 0.66);
      } else if (fam === 'drone') {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.36, 12), chrome);
        mast.position.y = 0.17;
        turret.add(mast);
        const drone = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), accent);
        drone.position.y = 0.4;
        turret.add(drone);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.014, 8, 24), accent);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.4;
        turret.add(ring);
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.18), steel);
        fin.rotation.x = Math.PI / 2;
        fin.position.z = 0.34;
        turret.add(fin);
        muzzle.position.set(0, 0.4, 0.12);
      } else {
        barrel(0.34, 0.07);
        const vent = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), accent);
        vent.position.set(0, 0.1, 0.3);
        turret.add(vent);
        const grille = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.06), chrome);
        grille.position.set(0, 0.1, 0.36);
        turret.add(grille);
        muzzle.position.set(0, 0.1, 0.36);
      }
    }
  }

  return { group, turret, muzzle, accent };
}
