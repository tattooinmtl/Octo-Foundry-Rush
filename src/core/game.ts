/**
 * OCTO FOUNDRY - game orchestrator.
 *
 * Owns the scene, the run state, the wave director, the economy and the
 * touch input. The UI layer (ui.ts) drives it through a small public API.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  COLS,
  ROWS,
  DYNAMITE_BASE_COST,
  DYNAMITE_BASE_DAMAGE,
  DYNAMITE_DAMAGE_PER_WAVE,
  DYNAMITE_RADIUS,
  FORGE_COST,
  FORGE_LIMIT,
  PAD_RADIUS,
  ROAD_HALF_WIDTH,
  SELL_REFUND,
  START_GOLD,
  START_LIVES,
  WEAPONS,
  LASER_DURATION,
  LASER_DAMAGE_MULT,
  FREEZE_SECONDS,
  HELLFIRE_SECONDS,
  HELLFIRE_DPS_MULT,
  CREEP_TIERS,
  tierIndexOf,
  type WeaponId,
} from './config';
import { planWave, playerDps, buildSpawnList, isRoundStart, roundOf, ROUND_REFUND, type WavePlan } from './balance';
import { PRESETS, type TowerSpec } from './towerDefs';
import { generatePath, isPathCell, sampleAt, type GeneratedPath } from './path';
import { Enemy } from './enemies';
import { Effects } from './effects';
import { ProjectileSystem } from './projectiles';
import { Tower } from './towers';
import { audio } from './audio';
import { ElectricPortal } from './portals';
import { Targeter, OrbitalLaser, DeepFreeze, Hellfire, type Strike, type StrikeHooks } from './weapons';
import { concreteTexture, hazardMaterial, hazardTexture, padTexture } from './geo';
import { fingerprintOf, forgeTower, type UsedFingerprint } from './forge';
import { CORRUPT_SAVE_KEY, SAVE_KEY, parseSave, presetSpec, roadSeedFor, serializeSave, type SaveData } from './save';
import { activeApiKey, activeModel, defaultSettings, migrateSettings, providerShortName, type Settings } from './settings';

export type GameState = 'menu' | 'playing' | 'paused' | 'gameover';

/** @deprecated v1 save shape - kept for reference; see save.ts for the current format. */
export interface RunSnapshot {
  seed: number;
  gold: number;
  score: number;
  wave: number;
  lives: number;
  towers: { padId: string; presetId: string; spec?: TowerSpec; level: number }[];
}

/** localStorage that never throws (Safari private mode, quota, disabled storage). */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const DYNAMITE_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xb8342a, roughness: 0.6, metalness: 0.1 });
const DYNAMITE_BLINK_MAT = new THREE.MeshStandardMaterial({ color: 0xffd0c0, emissive: 0x662222, roughness: 0.5 });

const SETTINGS_KEY = 'octo-foundry-settings-v1';
const BEST_KEY = 'octo-foundry-best-v1';

interface Dynamite {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  fuse: number;
  damage: number;
}

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
  renderer!: THREE.WebGLRenderer;
  canvas!: HTMLCanvasElement;

  state: GameState = 'menu';
  path!: GeneratedPath;
  enemies: Enemy[] = [];
  towers: Tower[] = [];
  projectiles!: ProjectileSystem;
  effects!: Effects;

  gold = START_GOLD;
  score = 0;
  wave = 0;
  lives = START_LIVES;
  best = 0;
  speed = 1;
  nextWaveIn = 0;
  wavePlan: WavePlan | null = null;
  waveActive = false;
  spawnQueue: { at: number; tier: number }[] = [];
  /** Creep kinds already announced this run ("NEW FOE" toast). */
  private seenKinds = new Set<string>();
  /** Why the last loadRun() failed, for the UI. */
  lastLoadError = '';
  waveClock = 0;
  pendingForge: TowerSpec | null = null;
  forgedCount = 0;
  /** Gold spent on towers during the current round (25% comes back next round). */
  roundTowerSpend = 0;
  /** Special weapon waiting for a target click, if any. */
  armedWeapon: WeaponId | null = null;
  /** Seconds of cooldown left per special weapon (game time). */
  cooldowns: Record<WeaponId, number> = { dynamite: 0, laser: 0, freeze: 0, hellfire: 0 };
  selectedPadId: string | null = null;
  lastError = '';

  settings: Settings = defaultSettings();

  private pads = new Map<string, THREE.Object3D>();
  private towerByPad = new Map<string, Tower>();
  private padCells = new Map<string, { col: number; row: number }>();
  private dynamites: Dynamite[] = [];
  private strikes: Strike[] = [];
  private targeter: Targeter | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private lastTime = 0;
  private shake = 0;
  private boardGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private portals: ElectricPortal[] = [];
  private selectionRing: THREE.Mesh | null = null;
  private camBase = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private fog: THREE.Fog | null = null;
  private runSeed = 0;
  private stateBeforeForge: GameState | null = null;
  private ui: {
    updateHud: () => void;
    waveWarning: (wave: number) => void;
    waveCleared: (plan: WavePlan, bonus: number) => void;
    gameOver: () => void;
    toast: (msg: string) => void;
    openBuild: (padId: string) => void;
    openTower: (padId: string) => void;
    setForgeBusy: (busy: boolean) => void;
    showForgeResult: (spec: TowerSpec, placed: boolean, fallbackReason?: string) => void;
  } | null = null;

  constructor() {
    this.loadSettings();
    this.best = Number(store.get(BEST_KEY) || 0) || 0;
    // Autosave when the phone locks or the tab goes away mid-run.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.saveRun();
      });
      window.addEventListener('pagehide', () => this.saveRun());
    }
  }

  attachUI(ui: Game['ui']): void {
    this.ui = ui;
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.settings.quality !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer = renderer;
    renderer.setPixelRatio(this.pixelRatio());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // The side panel changes the stage width without a window resize.
    const stage = canvas.parentElement;
    if (stage && 'ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(stage);
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));

    // Environment for the chrome look.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    pmrem.dispose();

    this.scene.background = new THREE.Color(0x0d1013);
    this.fog = new THREE.Fog(0x0d1013, 22, 46);
    this.scene.fog = this.fog;

    const hemi = new THREE.HemisphereLight(0xa9c4dc, 0x2b2f34, 0.75);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff2dc, 1.5);
    dir.position.set(-6, 12, 6);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0x88bbff, 0.5);
    rim.position.set(7, 6, -8);
    this.scene.add(rim);

    this.effects = new Effects(this.scene);
    this.projectiles = new ProjectileSystem(this.scene, this.effects);
    this.targeter = new Targeter(this.scene);

    this.scene.add(this.boardGroup);
    this.buildBoard();

    this.bindInput();
    this.lastTime = performance.now();
    renderer.setAnimationLoop(() => this.frame());
  }

  private pixelRatio(): number {
    const cap = this.settings.quality === 'low' ? 1 : this.settings.quality === 'medium' ? 1.5 : 2;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  private resize(): void {
    // The canvas lives inside the stage, which excludes the console column.
    const stage = (this.canvas.parentElement as HTMLElement) ?? document.body;
    const w = Math.max(1, stage.clientWidth || window.innerWidth);
    const h = Math.max(1, stage.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  /** Frame the whole board inside the frustum, with room for the HUD bars. */
  private fitCamera(): void {
    const halfW = COLS / 2 + 0.35;
    const halfH = ROWS / 2 + 0.55;
    const tilt = 0.16; // radians from straight down
    const dir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)).normalize();
    const center = new THREE.Vector3(0, 0, 0);

    const corners: THREE.Vector3[] = [];
    for (const x of [-halfW, halfW]) {
      for (const z of [-halfH, halfH]) {
        for (const y of [0, 1.4]) corners.push(new THREE.Vector3(x, y, z));
      }
    }

    let chosen = 24;
    for (let d = 6; d < 70; d += 0.25) {
      this.camera.position.copy(center).addScaledVector(dir, d);
      this.camera.lookAt(center);
      this.camera.updateMatrixWorld(true);
      this.camera.updateProjectionMatrix();
      let ok = true;
      for (const c of corners) {
        const p = c.clone().project(this.camera);
        if (Math.abs(p.x) > 0.99 || Math.abs(p.y) > 0.97) {
          ok = false;
          break;
        }
      }
      if (ok) {
        chosen = d;
        break;
      }
    }
    this.camera.position.copy(center).addScaledVector(dir, chosen);
    this.camera.lookAt(center);
    this.camBase.copy(this.camera.position);
    this.camTarget.copy(center);
  }

  /* ---------------------------------------------------------------- */
  /* Board                                                             */
  /* ---------------------------------------------------------------- */

  private buildBoard(): void {
    this.boardGroup.clear();
    this.pathGroup.clear();
    for (const p of this.portals) p.dispose();
    this.portals = [];
    this.pads.clear();
    this.padCells.clear();
    this.boardGroup.add(this.pathGroup);

    // Industrial floor under everything.
    const floorMat = new THREE.MeshStandardMaterial({
      map: concreteTexture(),
      color: 0x6f757d,
      roughness: 0.95,
      metalness: 0.05,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(44, 52), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.06;
    this.boardGroup.add(floor);

    // Raised steel plate = the play area.
    const plateMat = new THREE.MeshStandardMaterial({
      map: concreteTexture(),
      color: 0x878e97,
      roughness: 0.86,
      metalness: 0.08,
    });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(COLS + 0.5, 0.18, ROWS + 0.5), plateMat);
    plate.position.y = -0.09;
    this.boardGroup.add(plate);

    // Hazard curb around the plate.
    const curbMat = hazardMaterial([14, 22]);
    for (const [w, d, x, z] of [
      [COLS + 0.5, 0.28, 0, -(ROWS + 0.5) / 2],
      [COLS + 0.5, 0.28, 0, (ROWS + 0.5) / 2],
      [0.28, ROWS + 0.5, -(COLS + 0.5) / 2, 0],
      [0.28, ROWS + 0.5, (COLS + 0.5) / 2, 0],
    ] as const) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), curbMat);
      curb.position.set(x, 0.02, z);
      this.boardGroup.add(curb);
    }

    // Grid guides.
    const guideMat = new THREE.MeshBasicMaterial({ color: 0x2f353c, transparent: true, opacity: 0.5 });
    for (let c = 0; c <= COLS; c++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.02, ROWS), guideMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(c - COLS / 2, 0.005, 0);
      this.boardGroup.add(line);
    }
    for (let r = 0; r <= ROWS; r++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(COLS, 0.02), guideMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.005, r - ROWS / 2);
      this.boardGroup.add(line);
    }
  }

  private buildPathMeshes(path: GeneratedPath): void {
    const roadMat = new THREE.MeshStandardMaterial({
      map: concreteTexture(),
      color: 0x4c525a,
      roughness: 0.92,
      metalness: 0.06,
      side: THREE.DoubleSide,
    });
    const edgeMat = hazardMaterial([1, 40]);

    const n = path.samples.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const edgePos: number[] = [];
    const edgeUv: number[] = [];
    const edgeIdx: number[] = [];

    for (let i = 0; i < n; i++) {
      const s = path.samples[i];
      const right = new THREE.Vector3(s.tangent.z, 0, -s.tangent.x).normalize();
      const l = s.pos.clone().addScaledVector(right, ROAD_HALF_WIDTH);
      const r = s.pos.clone().addScaledVector(right, -ROAD_HALF_WIDTH);
      positions.push(l.x, 0, l.z, r.x, 0, r.z);
      const v = s.dist / 2;
      uvs.push(0, v, 1, v);
      if (i < n - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }

      // Two hazard stripes hugging the road edges.
      for (const side of [1, -1]) {
        const off = (ROAD_HALF_WIDTH - 0.055) * side;
        const c = s.pos.clone().addScaledVector(right, off);
        edgePos.push(c.x, 0.012, c.z, c.x, 0.012, c.z);
        edgeUv.push(s.dist * 0.5, 0, s.dist * 0.5, 0.02);
        if (i < n - 1) {
          const a = i * 4 + side * 2;
          edgeIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, roadMat);
    road.position.y = 0.015;
    this.pathGroup.add(road);

    // Hazard edges as thin ribbons.
    for (const side of [0, 1]) {
      const g = new THREE.BufferGeometry();
      const p: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = path.samples[i];
        const right = new THREE.Vector3(s.tangent.z, 0, -s.tangent.x).normalize();
        const off = (ROAD_HALF_WIDTH - 0.055) * (side === 0 ? 1 : -1);
        const inner = s.pos.clone().addScaledVector(right, off);
        const outer = s.pos.clone().addScaledVector(right, off * 1.16);
        p.push(inner.x, 0, inner.z, outer.x, 0, outer.z);
        uv.push(s.dist * 0.6, 0, s.dist * 0.6, 1);
        if (i < n - 1) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const ribbon = new THREE.Mesh(g, edgeMat);
      ribbon.position.y = 0.022;
      this.pathGroup.add(ribbon);
    }

    this.buildPortals(path);
  }

  /** Entry portal (creeps arrive here) and exit portal (creeps escape here): T2-style electric spheres. */
  private buildPortals(path: GeneratedPath): void {
    const zap = () => {
      if (this.state === 'playing') audio.zap();
    };
    const entry = sampleAt(path, 0.12);
    const exit = sampleAt(path, Math.max(0.2, path.length - 0.12));
    for (const [s, tint] of [
      [entry, 0x3d9bff],
      [exit, 0x7a6bff],
    ] as const) {
      const portal = new ElectricPortal(s.pos, tint, this.effects, zap);
      this.pathGroup.add(portal.group);
      this.portals.push(portal);
    }
  }

  /**
   * Diagnostic mode: ?probe=1 paints each board layer a flat colour and dumps
   * material/light facts into the DOM so a headless screenshot can confirm
   * what is actually being rendered.
   */
  private probe(): void {
    if (!new URLSearchParams(location.search).has('probe')) return;
    const facts: string[] = [];
    this.boardGroup.children.forEach((child) => {
      const c = child as THREE.Mesh;
      if (!c.geometry || !(c as THREE.Mesh).material) return;
      const mat = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
      const img = mat.map?.image as HTMLCanvasElement | undefined;
      let px = '-';
      if (img && img.getContext) {
        try {
          const d = img.getContext('2d')!.getImageData(8, 8, 1, 1).data;
          px = `${d[0]},${d[1]},${d[2]},${d[3]}`;
        } catch {
          px = 'unreadable';
        }
      }
      facts.push(
        `${c.geometry.type}|col=${mat.color ? '#' + mat.color.getHexString() : '-'}|map=${!!mat.map}|px=${px}|img=${
          img ? `${img.width}x${img.height}` : '-'
        }|rep=${mat.map ? mat.map.repeat.x + 'x' + mat.map.repeat.y : '-'}|y=${c.position.y.toFixed(2)}`,
      );
      // Same colour, no map: if this renders correctly the map is the problem.
      (c as THREE.Mesh).material = new THREE.MeshStandardMaterial({
        color: mat.color ? mat.color.getHex() : 0xffffff,
        roughness: 0.8,
        metalness: 0.05,
      });
    });
    const lights: string[] = [];
    this.scene.children.forEach((c) => {
      if ((c as THREE.DirectionalLight).isDirectionalLight) {
        const l = c as THREE.DirectionalLight;
        lights.push(`dir ${l.intensity} @${l.position.x},${l.position.y},${l.position.z}`);
      } else if ((c as THREE.HemisphereLight).isHemisphereLight) {
        const l = c as THREE.HemisphereLight;
        lights.push(`hemi ${l.intensity}`);
      }
    });
    const el = document.getElementById('probe-out') ?? document.createElement('div');
    el.id = 'probe-out';
    el.style.cssText =
      'position:fixed;left:4px;top:4px;z-index:9999;max-width:96vw;font:10px/1.35 monospace;color:#7CFFB2;background:rgba(0,0,0,.78);padding:6px;border-radius:6px;white-space:pre-wrap;pointer-events:none';
    el.textContent = `PROBE cam=${this.camera.position.length().toFixed(1)} env=${!!this.scene.environment} fog=${
      this.scene.fog ? (this.scene.fog as THREE.Fog).near : '-'
    } :: ${lights.join(' | ')}\n${facts.join('\n')}`;
    document.body.appendChild(el);
  }

  private buildPads(path: GeneratedPath): void {
    // Every free cell is a build socket, drawn as one instanced mesh so a
    // hundred of them cost a single draw call.
    const geo = new THREE.PlaneGeometry(0.88, 0.88);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      map: padTexture(),
      transparent: true,
      roughness: 0.72,
      metalness: 0.3,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, path.pads.length));
    const m = new THREE.Matrix4();
    path.pads.forEach((pad, i) => {
      m.makeTranslation(pad.pos.x, 0.02, pad.pos.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 1;
    this.pathGroup.add(mesh);

    // Selection marker that follows the tapped slot.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(PAD_RADIUS * 0.92, PAD_RADIUS * 1.18, 4),
      new THREE.MeshBasicMaterial({
        color: 0xf5c518,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = Math.PI / 4;
    ring.position.y = 0.06;
    ring.visible = false;
    ring.renderOrder = 2;
    this.pathGroup.add(ring);
    this.selectionRing = ring;

    for (const pad of path.pads) {
      this.padCells.set(pad.id, { col: pad.col, row: pad.row });
    }
  }

  /** Move the selection marker onto a build socket. */
  private selectPad(padId: string | null): void {
    this.selectedPadId = padId;
    if (!this.selectionRing) return;
    if (!padId) {
      this.selectionRing.visible = false;
      return;
    }
    const pad = this.path.pads.find((p) => p.id === padId);
    if (!pad) {
      this.selectionRing.visible = false;
      return;
    }
    this.selectionRing.position.set(pad.pos.x, 0.06, pad.pos.z);
    this.selectionRing.visible = true;
  }

  /* ---------------------------------------------------------------- */
  /* Run lifecycle                                                     */
  /* ---------------------------------------------------------------- */

  newRun(seed = Math.floor(Math.random() * 1e9)): void {
    this.clearBoard();
    this.runSeed = seed >>> 0;
    this.path = generatePath(this.runSeed);
    this.buildPathMeshes(this.path);
    this.buildPads(this.path);

    this.gold = START_GOLD;
    this.score = 0;
    this.wave = 0;
    this.lives = START_LIVES;
    this.speed = 1;
    this.pendingForge = null;
    this.forgedCount = 0;
    this.roundTowerSpend = 0;
    this.armedWeapon = null;
    this.targeter?.hide();
    this.waveActive = false;
    this.nextWaveIn = 8;
    this.wavePlan = null;
    this.spawnQueue = [];
    this.waveClock = 0;
    this.seenKinds.clear();

    this.state = 'playing';
    this.nextWaveIn = 6;
    this.ui?.updateHud();
    this.probe();
  }

  restart(): void {
    this.newRun();
  }

  private clearBoard(): void {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies = [];
    for (const t of this.towers) this.scene.remove(t.visual.group);
    this.towers = [];
    this.towerByPad.clear();
    this.projectiles?.clear();
    for (const d of this.dynamites) this.scene.remove(d.mesh);
    this.dynamites = [];
    for (const st of this.strikes) st.dispose();
    this.strikes = [];
    this.cooldowns = { dynamite: 0, laser: 0, freeze: 0, hellfire: 0 };
    this.boardGroup.clear();
    this.buildBoard();
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'playing';
  }

  quitToMenu(): void {
    this.state = 'menu';
  }

  setSpeed(s: number): void {
    this.speed = s;
  }

  /* ---------------------------------------------------------------- */
  /* Economy + towers                                                  */
  /* ---------------------------------------------------------------- */

  get dynamiteCost(): number {
    return this.weaponCost('dynamite');
  }

  weaponCost(id: WeaponId): number {
    const w = WEAPONS.find((x) => x.id === id)!;
    return w.baseCost + this.wave * w.costPerWave;
  }

  /** 0 = ready, 1 = just fired. */
  cooldownFraction(id: WeaponId): number {
    const w = WEAPONS.find((x) => x.id === id)!;
    return w.cooldown > 0 ? Math.max(0, Math.min(1, this.cooldowns[id] / w.cooldown)) : 0;
  }

  /** Damage of one dynamite blast this wave - every special scales off it. */
  get dynamiteDamage(): number {
    return DYNAMITE_BASE_DAMAGE + DYNAMITE_DAMAGE_PER_WAVE * Math.max(0, this.wave - 1);
  }

  get playerDps(): number {
    return playerDps(this.towers.map((t) => ({ spec: t.spec, level: t.level })));
  }

  get targetDps(): number {
    return this.wavePlan?.targetDps ?? 0;
  }

  canAfford(cost: number): boolean {
    return this.gold >= cost;
  }

  buildPreset(presetId: string, padId: string): boolean {
    const preset = PRESETS.find((p) => p.presetId === presetId);
    if (!preset) return false;
    const dps = preset.damage * preset.fireRate * preset.burst;
    const spec: TowerSpec = {
      id: `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      kind: 'preset',
      presetId: preset.presetId,
      name: preset.name,
      damageType: preset.damageType,
      effect: preset.effect,
      damage: preset.damage,
      fireRate: preset.fireRate,
      range: preset.range,
      burst: preset.burst,
      projectileShape: preset.projectileShape,
      color: preset.color,
      impact: preset.impact,
      sound: preset.sound,
      mechanic: preset.mechanic,
      price: Math.max(60, Math.round((dps * 10) / 5) * 5),
      dps,
    };
    return this.placeTower(spec, padId);
  }

  placeTower(spec: TowerSpec, padId: string, prepaid = false): boolean {
    if (this.towerByPad.has(padId)) return false;
    if (!prepaid && this.gold < spec.price) {
      this.lastError = 'Not enough gold.';
      audio.ui('error');
      this.ui?.toast('NOT ENOUGH GOLD');
      return false;
    }
    const pad = this.path.pads.find((p) => p.id === padId);
    if (!pad) return false;

    if (!prepaid) {
      this.gold -= spec.price;
      this.roundTowerSpend += spec.price;
    }
    const tower = new Tower(this.scene, spec, pad.pos.clone().setY(0.06), padId);
    this.towers.push(tower);
    this.towerByPad.set(padId, tower);
    this.effects.shockRing(pad.pos, 0xffcc33, 0.8, 0.4);
    audio.gold();
    this.ui?.updateHud();
    return true;
  }

  upgradeTower(padId: string): boolean {
    const tower = this.towerByPad.get(padId);
    if (!tower || tower.level >= 3) return false;
    const cost = tower.upgradeCost;
    if (this.gold < cost) {
      audio.ui('error');
      this.ui?.toast('NOT ENOUGH GOLD');
      return false;
    }
    this.gold -= cost;
    this.roundTowerSpend += cost;
    tower.upgrade();
    audio.gold();
    this.effects.shockRing(tower.position, 0x8de0ff, 0.9, 0.4);
    this.ui?.updateHud();
    return true;
  }

  sellTower(padId: string): boolean {
    const tower = this.towerByPad.get(padId);
    if (!tower) return false;
    this.gold += tower.sellValue;
    this.scene.remove(tower.visual.group);
    this.towers = this.towers.filter((t) => t !== tower);
    this.towerByPad.delete(padId);
    audio.gold();
    this.ui?.updateHud();
    return true;
  }

  /** Arm (or disarm) a special weapon; the next board click fires it. */
  armWeapon(id: WeaponId): void {
    if (this.armedWeapon === id) {
      this.cancelWeapon();
      audio.ui('back');
      return;
    }
    if (this.cooldowns[id] > 0) {
      audio.ui('error');
      this.ui?.toast(`RECHARGING · ${Math.ceil(this.cooldowns[id])}s`);
      return;
    }
    if (this.gold < this.weaponCost(id)) {
      audio.ui('error');
      this.ui?.toast('NOT ENOUGH GOLD');
      return;
    }
    const def = WEAPONS.find((w) => w.id === id)!;
    this.armedWeapon = id;
    this.targeter?.show(def.radius, def.color);
    audio.arm();
    this.ui?.toast(`${def.name.toUpperCase()} ARMED · CLICK THE BOARD · RIGHT-CLICK TO CANCEL`);
    this.ui?.updateHud();
  }

  cancelWeapon(): void {
    this.armedWeapon = null;
    this.targeter?.hide();
    this.ui?.updateHud();
  }

  /** Back-compat for the old dynamite button. */
  armDynamite(): void {
    this.armWeapon('dynamite');
  }

  private fireWeapon(id: WeaponId, pos: THREE.Vector3): void {
    const cost = this.weaponCost(id);
    if (this.gold < cost) {
      audio.ui('error');
      this.ui?.toast('NOT ENOUGH GOLD');
      this.cancelWeapon();
      return;
    }
    const def = WEAPONS.find((w) => w.id === id)!;
    const hooks = this.strikeHooks(id);
    if (id === 'dynamite') {
      this.dropDynamite(pos);
    } else {
      this.gold -= cost;
      if (id === 'laser') {
        this.strikes.push(new OrbitalLaser(this.scene, this.effects, pos, def.radius, hooks));
        audio.orbitalLaser(LASER_DURATION);
      } else if (id === 'freeze') {
        this.strikes.push(new DeepFreeze(this.scene, this.effects, pos, def.radius, hooks));
        audio.deepFreeze();
      } else {
        this.strikes.push(new Hellfire(this.scene, this.effects, pos, def.radius, hooks));
        audio.hellfire(0.45, HELLFIRE_SECONDS);
      }
    }
    this.cooldowns[id] = def.cooldown;
    this.armedWeapon = null;
    this.targeter?.hide();
    this.ui?.updateHud();
  }

  /** Damage / status rules for each special weapon. */
  private strikeHooks(id: WeaponId): StrikeHooks {
    const dmg = this.dynamiteDamage;
    const inZone = (center: THREE.Vector3, radius: number) =>
      this.enemies.filter((e) => {
        if (!e.alive) return false;
        const dx = e.position.x - center.x;
        const dz = e.position.z - center.z;
        return dx * dx + dz * dz <= radius * radius;
      });
    const shake = (a: number) => {
      this.shake = Math.min(1.2, this.shake + a);
    };
    if (id === 'laser') {
      const dps = (dmg * LASER_DAMAGE_MULT) / LASER_DURATION;
      return {
        shake,
        tick: (c, r, dt) => {
          for (const e of inZone(c, r)) e.takeDamage(dps * dt, 'none', { ignoreArmor: true });
        },
      };
    }
    if (id === 'freeze') {
      return {
        shake,
        tick: () => {},
        impact: (c, r) => {
          for (const e of inZone(c, r)) {
            e.freeze(FREEZE_SECONDS);
            e.takeDamage(dmg * 0.15, 'none');
          }
        },
      };
    }
    // hellfire
    const dps = dmg * HELLFIRE_DPS_MULT;
    return {
      shake,
      impact: (c, r) => {
        for (const e of inZone(c, r)) e.takeDamage(dmg * 0.6, 'none');
      },
      tick: (c, r, dt) => {
        for (const e of inZone(c, r)) {
          e.takeDamage(dps * dt, 'none', { ignoreArmor: true });
          e.ignite(dps * 0.45, 2);
        }
      },
    };
  }

  callWaveNow(): void {
    if (this.waveActive || this.nextWaveIn <= 0) return;
    const bonus = Math.round(this.nextWaveIn * 3);
    this.gold += bonus;
    this.nextWaveIn = 0.05;
    this.ui?.toast(`EARLY CALL +${bonus} GOLD`);
    this.ui?.updateHud();
  }

  /* ---------------------------------------------------------------- */
  /* AI forge                                                          */
  /* ---------------------------------------------------------------- */

  private usedFingerprints(): UsedFingerprint[] {
    const out: UsedFingerprint[] = PRESETS.map((p) => ({
      name: p.name,
      damageType: p.damageType,
      projectileShape: p.projectileShape,
      color: `#${p.color.toString(16).padStart(6, '0')}`,
    }));
    for (const t of this.towers) out.push(fingerprintOf(t.spec));
    if (this.pendingForge) out.push(fingerprintOf(this.pendingForge));
    return out;
  }

  get canForge(): boolean {
    return this.forgedCount < FORGE_LIMIT && this.gold >= FORGE_COST;
  }

  /**
   * The forge panel pauses the run while the player writes their brief, so the
   * board cannot move under them while they decide.
   */
  setForgeOpen(open: boolean): void {
    if (open) {
      if (this.state === 'playing') {
        this.stateBeforeForge = 'playing';
        this.state = 'paused';
      }
      return;
    }
    if (this.stateBeforeForge === 'playing' && this.state === 'paused') {
      this.state = 'playing';
    }
    this.stateBeforeForge = null;
  }

  async forgeNewTower(padId: string, brief = ''): Promise<void> {
    if (!this.canForge) {
      audio.ui('error');
      this.ui?.toast(this.forgedCount >= FORGE_LIMIT ? 'FORGE LIMIT REACHED' : 'NOT ENOUGH GOLD');
      return;
    }
    // The fee IS the tower's price: the player pays once and the device is
    // deployed immediately - no second payment, no tower stuck in a bay.
    this.gold -= FORGE_COST;
    this.forgedCount++;
    this.ui?.setForgeBusy(true);
    audio.forgeStart();

    const runAtStart = this.runSeed;
    let result: Awaited<ReturnType<typeof forgeTower>>;
    try {
      result = await forgeTower({
        used: this.usedFingerprints(),
        apiKey: activeApiKey(this.settings) || undefined,
        model: activeModel(this.settings) || undefined,
        provider: this.settings.provider,
        providerName: providerShortName(this.settings),
        custom: this.settings.custom,
        brief: brief.trim().slice(0, 240),
      });
    } catch {
      // Only an abort lands here - give the fee back.
      this.gold += FORGE_COST;
      this.forgedCount = Math.max(0, this.forgedCount - 1);
      this.ui?.setForgeBusy(false);
      this.ui?.updateHud();
      return;
    } finally {
      this.ui?.setForgeBusy(false);
    }
    // The run was quit or restarted while the forge was thinking: drop it.
    if (this.runSeed !== runAtStart || this.state === 'menu' || this.state === 'gameover') return;
    const { spec, source, reason } = result;
    audio.forgeDone();

    const placed = this.placeTower(spec, padId, true);
    if (!placed) {
      // No pad free - hold it, but refund the fee so the player is not paid twice.
      this.gold += FORGE_COST;
      this.pendingForge = spec;
      this.ui?.toast('NO FREE PAD - TOWER HELD IN THE BAY');
    }
    this.ui?.showForgeResult(spec, placed, source === 'local' ? reason ?? undefined : undefined);
    this.ui?.updateHud();
    if (source === 'local') this.ui?.toast(`${reason ?? 'FORGE OFFLINE'} - USED LOCAL FORGE`);
  }

  /* ---------------------------------------------------------------- */
  /* Waves                                                             */
  /* ---------------------------------------------------------------- */

  private startWave(): void {
    this.wave += 1;

    // A new round resets the board: new layout, towers cleared and refunded,
    // starting gold restored. The layout only changes here, never mid-round.
    if (isRoundStart(this.wave) && this.wave > 1) this.beginRound();

    const plan = planWave(this.wave, this.path.length);
    this.wavePlan = plan;
    this.waveActive = true;
    this.waveClock = 0;

    this.spawnQueue = buildSpawnList(plan);
    this.announceNewKinds(this.spawnQueue.map((s) => s.tier));

    this.ui?.waveWarning(this.wave);
    audio.klaxon();
    this.ui?.updateHud();
  }

  /** Toast the first appearance of each creep kind so the player learns the roster. */
  private announceNewKinds(tiers: number[]): void {
    const fresh: string[] = [];
    for (const i of tiers) {
      const t = CREEP_TIERS[i];
      if (!t || this.seenKinds.has(t.id)) continue;
      this.seenKinds.add(t.id);
      // The first three are the classic roster - no need to announce them.
      if (i >= 3) fresh.push(`${t.label.toUpperCase()}: ${t.blurb}`);
    }
    if (fresh.length) this.ui?.toast(`NEW FOE · ${fresh.join(' · ')}`);
  }

  /**
   * Start a new round: the board is wiped, the towers of the previous round
   * are sold back at 25% of what they cost, the starting purse is restored
   * and a fresh layout is dealt.
   */
  private beginRound(): void {
    const refund = Math.round(this.roundTowerSpend * ROUND_REFUND);

    for (const tower of this.towers) this.scene.remove(tower.visual.group);
    this.towers = [];
    this.towerByPad.clear();

    this.gold = START_GOLD + refund;
    this.lives = START_LIVES;
    this.roundTowerSpend = 0;

    this.rebuildMap(roadSeedFor(this.runSeed, this.wave));

    this.ui?.toast(`ROUND ${roundOf(this.wave)} · BOARD RESET · +${refund}G REFUND`);
    audio.waveClear();
  }

  /**
   * Swap in a new road for the next round and carry the existing towers over:
   * each tower moves to the closest free pad on the new path.
   */
  private rebuildMap(seed: number): void {
    this.pathGroup.clear();
    this.pads.clear();
    this.padCells.clear();
    for (const p of this.portals) p.dispose();
    this.portals = [];

    this.path = generatePath(seed);
    this.buildPathMeshes(this.path);
    this.buildPads(this.path);

    const taken = new Set<string>();
    for (const tower of this.towers) {
      let best: { id: string; pos: THREE.Vector3 } | null = null;
      let bestDist = Infinity;
      for (const pad of this.path.pads) {
        if (taken.has(pad.id)) continue;
        const d = pad.pos.distanceToSquared(tower.position);
        if (d < bestDist) {
          bestDist = d;
          best = { id: pad.id, pos: pad.pos };
        }
      }
      if (!best) continue;
      taken.add(best.id);
      this.towerByPad.delete(tower.padId);
      tower.moveTo(best.id, best.pos);
      this.towerByPad.set(best.id, tower);
    }
  }

  private spawnCreep(tierIndex: number): Enemy | null {
    const plan = this.wavePlan;
    if (!plan) return null;
    const enemy = new Enemy(
      this.scene,
      this.path,
      plan.hpPerCreep,
      plan.armor,
      plan.speed,
      tierIndex,
      Math.random(),
      {
        onDeath: (e) => this.onCreepDeath(e),
        onLeak: (e) => this.onCreepLeak(e),
        onVolatile: (e) => this.onVolatile(e),
        onShieldBreak: (e) => this.onShieldBreak(e),
      },
    );
    this.enemies.push(enemy);
    this.portals[0]?.discharge();
    audio.portalSpawn();
    return enemy;
  }

  private onShieldBreak(e: Enemy): void {
    const at = e.position.clone().setY(0.4 + (e.flying ? 0.8 * e.tier.scale : 0));
    this.effects.burst(at, 0x8fe8ff, 14, 3.4);
    this.effects.shockRing(e.position, 0x8fe8ff, 0.9 * e.tier.scale, 0.35);
    audio.impact('chain');
  }

  private onCreepDeath(e: Enemy): void {
    const plan = this.wavePlan;
    const gold = Math.max(1, Math.round((plan?.killGold ?? 3) * e.tier.goldMult));
    this.gold += gold;
    this.score += Math.round(12 + this.wave * 2 + e.tier.hpMult * 6);
    this.effects.coins(e.position, e.tier.boss ? 12 : e.tier.id === 'tank' ? 6 : 3);
    this.effects.burst(e.position.clone().setY(0.3), e.tier.color, 12, 3.2);
    audio.death();
    audio.gold();
    this.enemies = this.enemies.filter((x) => x !== e);
    e.dispose(this.scene);
    this.ui?.updateHud();
  }

  private onCreepLeak(e: Enemy): void {
    this.lives -= e.tier.leakCost;
    this.score = Math.max(0, this.score - 25);
    this.effects.burst(e.position.clone().setY(0.4), 0xff3b30, 16, 3.6);
    this.portals[1]?.discharge();
    audio.portalExit();
    audio.explosion();
    this.enemies = this.enemies.filter((x) => x !== e);
    e.dispose(this.scene);
    if (this.lives <= 0) this.endRun();
    this.ui?.updateHud();
  }

  private onVolatile(e: Enemy): void {
    this.effects.explosion(e.position.clone().setY(0.3), 0xff8a3d, 1.3);
    audio.explosion();
    this.shake = Math.min(1, this.shake + 0.4);
    for (const other of this.enemies) {
      if (!other.alive || other === e) continue;
      if (other.position.distanceTo(e.position) < 1.8) {
        other.takeDamage(45, 'none');
      }
    }
  }

  private endRun(): void {
    this.state = 'gameover';
    // A lost run cannot be resumed.
    this.clearSave();
    this.saveBest();
    audio.gameOver();
    this.ui?.gameOver();
  }

  private saveBest(): void {
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem(BEST_KEY, String(this.best));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Dynamite                                                         */
  /* ---------------------------------------------------------------- */

  private dropDynamite(pos: THREE.Vector3): void {
    if (this.gold < this.dynamiteCost) {
      audio.ui('error');
      this.ui?.toast('NOT ENOUGH GOLD');
      return;
    }
    this.gold -= this.dynamiteCost;

    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.34, 10), DYNAMITE_BODY_MAT);
    group.add(body);
    for (let i = 0; i < 4; i++) {
      const stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6),
        new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: 0.9 }),
      );
      stick.rotation.z = Math.PI / 2;
      stick.rotation.y = (i * Math.PI) / 2;
      stick.position.y = 0.02;
      group.add(stick);
    }
    const fuse = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.014, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1 }),
    );
    fuse.position.y = 0.2;
    group.add(fuse);
    group.position.copy(pos).setY(0.2);
    this.scene.add(group);

    this.dynamites.push({
      mesh: group,
      pos: pos.clone(),
      fuse: 0.8,
      damage: DYNAMITE_BASE_DAMAGE + DYNAMITE_DAMAGE_PER_WAVE * Math.max(0, this.wave - 1),
    });
    audio.ui('click');
    this.ui?.updateHud();
  }

  private updateDynamites(dt: number): void {
    for (let i = this.dynamites.length - 1; i >= 0; i--) {
      const d = this.dynamites[i];
      d.fuse -= dt;
      // Audit fix: this used to allocate a new material every frame and never blink back.
      const blink = Math.sin(d.fuse * 28) > 0;
      (d.mesh.children[0] as THREE.Mesh).material = blink ? DYNAMITE_BLINK_MAT : DYNAMITE_BODY_MAT;
      if (d.fuse <= 0) {
        this.effects.explosion(d.pos.clone().setY(0.3), 0xffa13d, 1.6);
        audio.explosion();
        this.shake = Math.min(1.2, this.shake + 0.8);
        for (const e of this.enemies) {
          // A charge on the road cannot reach a creep flying over it.
          if (!e.alive || e.flying) continue;
          const dist = e.position.distanceTo(d.pos);
          if (dist < DYNAMITE_RADIUS) {
            // A charge must kill what it touches: the rim only chips away 35%.
            const falloff = 1 - 0.35 * (dist / DYNAMITE_RADIUS);
            e.takeDamage(d.damage * falloff, 'none');
          }
        }
        this.scene.remove(d.mesh);
        this.dynamites.splice(i, 1);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                            */
  /* ---------------------------------------------------------------- */

  /** Board point under a pointer event, or null when off the plate. */
  private boardHit(ev: PointerEvent): { hit: THREE.Vector3; col: number; row: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    const col = Math.round(hit.x + (COLS - 1) / 2);
    const row = Math.round(hit.z + (ROWS - 1) / 2);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return { hit, col, row };
  }

  private bindInput(): void {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.armedWeapon) this.cancelWeapon();
    });

    // The reticle follows the pointer while a weapon is armed.
    el.addEventListener('pointermove', (ev) => {
      if (!this.armedWeapon || !this.targeter) return;
      const b = this.boardHit(ev);
      if (!b) {
        this.targeter.setValid(false);
        return;
      }
      this.targeter.moveTo(b.hit.x, b.hit.z);
      this.targeter.setValid(this.armedWeapon !== 'dynamite' || isPathCell(this.path, b.col, b.row));
    });

    el.addEventListener('pointerdown', (ev) => {
      // While paused the board still accepts strikes, so they can be
      // pre-placed before the wave restarts.
      if (this.state !== 'playing' && !this.armedWeapon) return;

      if (this.armedWeapon && ev.button === 2) {
        this.cancelWeapon();
        audio.ui('back');
        return;
      }
      const b = this.boardHit(ev);
      if (!b) return;
      const { hit, col, row } = b;

      if (this.armedWeapon) {
        this.targeter?.moveTo(hit.x, hit.z);
        if (this.armedWeapon === 'dynamite' && !isPathCell(this.path, col, row)) {
          this.ui?.toast('DYNAMITE MUST GO ON THE ROAD');
          audio.ui('error');
          return;
        }
        this.fireWeapon(this.armedWeapon, new THREE.Vector3(hit.x, 0, hit.z));
        return;
      }

      const padId = this.padIdAt(col, row);
      if (padId) {
        this.selectPad(padId);
        if (this.towerByPad.has(padId)) this.ui?.openTower(padId);
        else this.ui?.openBuild(padId);
      } else {
        // Tapped the road itself.
        this.selectPad(null);
        this.ui?.openBuild('__none__');
      }
    });
  }

  /** Every cell that is not part of the road is a build socket. */
  private padIdAt(col: number, row: number): string | null {
    if (isPathCell(this.path, col, row)) return null;
    return `pad-${col}-${row}`;
  }

  /* ---------------------------------------------------------------- */
  /* Save / load                                                      */
  /* ---------------------------------------------------------------- */

  /** Can the current run be saved right now? */
  get canSave(): boolean {
    return (this.state === 'playing' || this.state === 'paused') && !!this.path;
  }

  /** Snapshot of the run in the current save format. */
  snapshotRun(): Omit<SaveData, 'version'> {
    return {
      savedAt: Date.now(),
      runSeed: this.runSeed,
      pathSeed: this.path.seed,
      gold: this.gold,
      score: this.score,
      wave: this.wave,
      lives: this.lives,
      roundTowerSpend: this.roundTowerSpend,
      forgedCount: this.forgedCount,
      cooldowns: { ...this.cooldowns },
      towers: this.towers.map((t) => ({
        padId: t.padId,
        presetId: t.spec.presetId,
        spec: t.spec.kind === 'ai' ? t.spec : undefined,
        level: t.level,
      })),
      pendingForge: this.pendingForge,
      waveActive: this.waveActive,
      waveClock: this.waveClock,
      spawnQueue: this.spawnQueue.map((q) => ({ at: q.at, kind: CREEP_TIERS[q.tier]?.id ?? 'grunt' })),
      enemies: this.enemies.filter((e) => e.alive).map((e) => e.snapshot()),
      seenKinds: [...this.seenKinds],
    };
  }

  /**
   * Save the run. Works while playing AND while paused (the pause menu's
   * MAIN MENU button pauses first - the old guard silently skipped that save).
   */
  saveRun(): boolean {
    if (!this.canSave) return false;
    return store.set(SAVE_KEY, serializeSave(this.snapshotRun()));
  }

  hasSave(): boolean {
    return !!store.get(SAVE_KEY);
  }

  /** When the stored save was written (0 for v1 saves or none). */
  saveInfo(): { wave: number; savedAt: number } | null {
    const parsed = parseSave(store.get(SAVE_KEY));
    return parsed.ok ? { wave: parsed.data.wave, savedAt: parsed.data.savedAt } : null;
  }

  /**
   * Restore the saved run. The save is fully validated BEFORE the current
   * board is touched, so a corrupt save can never leave a half-built run.
   * A corrupt save is parked under CORRUPT_SAVE_KEY instead of being lost.
   */
  loadRun(): boolean {
    this.lastLoadError = '';
    const raw = store.get(SAVE_KEY);
    const parsed = parseSave(raw);
    if (!parsed.ok) {
      this.lastLoadError = parsed.error;
      if (raw && parsed.error !== 'no save found') {
        store.set(CORRUPT_SAVE_KEY, raw);
        store.remove(SAVE_KEY);
      }
      return false;
    }
    const snap = parsed.data;

    this.clearBoard();
    this.runSeed = snap.runSeed;
    this.path = generatePath(snap.pathSeed);
    this.buildPathMeshes(this.path);
    this.buildPads(this.path);
    this.gold = snap.gold;
    this.score = snap.score;
    this.wave = snap.wave;
    this.lives = snap.lives;
    this.roundTowerSpend = snap.roundTowerSpend;
    this.forgedCount = snap.forgedCount;
    this.cooldowns = { ...snap.cooldowns };
    this.pendingForge = snap.pendingForge;
    this.seenKinds = new Set(snap.seenKinds);
    this.speed = 1;
    this.armedWeapon = null;
    this.targeter?.hide();
    this.selectPad(null);

    for (const t of snap.towers) {
      const spec = t.spec ?? presetSpec(t.presetId);
      if (!spec) continue;
      const pad = this.path.pads.find((p) => p.id === t.padId);
      if (!pad || this.towerByPad.has(t.padId)) continue;
      const tower = new Tower(this.scene, spec, pad.pos.clone().setY(0.06), t.padId);
      tower.level = Math.min(3, Math.max(1, t.level));
      this.towers.push(tower);
      this.towerByPad.set(t.padId, tower);
    }

    if (snap.waveActive) {
      // Resume mid-wave: same plan, live creeps where they were, rest of the queue.
      this.wavePlan = planWave(snap.wave, this.path.length);
      this.waveActive = true;
      this.waveClock = snap.waveClock;
      this.spawnQueue = snap.spawnQueue.map((q) => ({ at: q.at, tier: Math.max(0, tierIndexOf(q.kind)) }));
      for (const es of snap.enemies) {
        const e = this.spawnCreep(Math.max(0, tierIndexOf(es.kind)));
        e?.restore(es, this.path);
      }
      this.nextWaveIn = 0;
    } else {
      this.waveActive = false;
      this.spawnQueue = [];
      this.waveClock = 0;
      this.nextWaveIn = 6;
      this.wavePlan = snap.wave > 0 ? planWave(snap.wave + 1, this.path.length) : null;
    }

    this.state = 'playing';
    this.ui?.updateHud();
    return true;
  }

  clearSave(): void {
    store.remove(SAVE_KEY);
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                         */
  /* ---------------------------------------------------------------- */

  saveSettings(): void {
    store.set(SETTINGS_KEY, JSON.stringify({ ...this.settings, version: 2 }));
  }

  private loadSettings(): void {
    let raw: unknown = null;
    try {
      raw = JSON.parse(store.get(SETTINGS_KEY) || 'null');
    } catch {
      raw = null;
    }
    this.settings = migrateSettings(raw);
    audio.setMaster(this.settings.master);
    audio.setSfx(this.settings.sfx);
    audio.setMuted(this.settings.muted);
  }

  applySettings(): void {
    audio.setMaster(this.settings.master);
    audio.setSfx(this.settings.sfx);
    audio.setMuted(this.settings.muted);
    this.saveSettings();
    if (this.renderer) {
      this.renderer.setPixelRatio(this.pixelRatio());
      this.resize();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                            */
  /* ---------------------------------------------------------------- */

  private frame(): void {
    const now = performance.now();
    const raw = Math.min((now - this.lastTime) / 1000, 0.05) || 0.016;
    this.lastTime = now;
    const dt = this.state === 'playing' ? raw * this.speed : 0;

    if (this.state === 'playing') {
      this.update(dt);
    } else {
      // Keep the board alive (idle turret sweep) while paused.
      this.effects?.update(raw);
    }

    // Camera shake.
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - raw * 2.2);
      const s = this.shake * 0.22;
      this.camera.position.set(
        this.camBase.x + (Math.random() - 0.5) * s,
        this.camBase.y + (Math.random() - 0.5) * s,
        this.camBase.z + (Math.random() - 0.5) * s,
      );
    } else {
      this.camera.position.lerp(this.camBase, 0.2);
    }

    // Electric portals stay alive even while paused; the buzz only plays in-game.
    for (const p of this.portals) p.update(raw * (this.state === 'playing' ? this.speed : 0.6), this.camera);
    audio.setPortalHum(this.state === 'playing' && this.portals.length > 0);
    this.targeter?.update(raw);

    this.renderer.render(this.scene, this.camera);
  }

  private update(dt: number): void {
    const ctx = {
      enemies: this.enemies,
      projectiles: this.projectiles,
      effects: this.effects,
      audio,
    };

    for (const t of this.towers) t.update(dt, ctx);
    for (const e of this.enemies) e.update(dt, this.path);
    this.projectiles.update(dt, ctx);
    this.effects.update(dt);
    this.updateDynamites(dt);
    for (const k of Object.keys(this.cooldowns) as WeaponId[]) {
      if (this.cooldowns[k] > 0) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const st = this.strikes[i];
      st.update(dt);
      if (st.done) {
        st.dispose();
        this.strikes.splice(i, 1);
      }
    }
    this.updateWaves(dt);
  }

  private updateWaves(dt: number): void {
    if (this.waveActive) {
      this.waveClock += dt;
      while (this.spawnQueue.length && this.spawnQueue[0].at <= this.waveClock) {
        const s = this.spawnQueue.shift();
        if (s) this.spawnCreep(s.tier);
      }
      if (this.spawnQueue.length === 0 && this.enemies.length === 0) {
        this.waveActive = false;
        const plan = this.wavePlan;
        if (plan) {
          this.gold += plan.waveBonus;
          this.score += plan.wave * 40;
          audio.waveClear();
          this.ui?.waveCleared(plan, plan.waveBonus);
          this.nextWaveIn = 12;
          // Checkpoint between waves.
          this.saveRun();
        }
        this.ui?.updateHud();
      }
    } else if (this.state === 'playing') {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0) this.startWave();
    }
  }
}

export const game = new Game();
export { hazardTexture };
