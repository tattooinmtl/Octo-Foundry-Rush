/**
 * Procedural path generation.
 *
 * The map is a grid corridor carved by a self-avoiding random walk with a
 * "non-touching" rule (a new cell may not touch any earlier cell except the
 * one it came from), which keeps the road from overlapping itself. Corners are
 * then rounded so creeps walk a smooth curve instead of snapping at cell
 * boundaries. A fresh seed per run means the map is never the same twice.
 */

import * as THREE from 'three';
import { COLS, ROWS, cellToWorld } from './config';

export interface PathSample {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  dist: number;
}

export interface Pad {
  id: string;
  col: number;
  row: number;
  pos: THREE.Vector3;
  /** Distance along the path of the closest path point (used for AI targetting). */
  nearDist: number;
}

export interface GeneratedPath {
  seed: number;
  cells: { col: number; row: number }[];
  cellKeys: Set<string>;
  points: THREE.Vector3[];
  samples: PathSample[];
  length: number;
  pads: Pad[];
}

const DIRS: { dc: number; dr: number }[] = [
  { dc: 1, dr: 0 },
  { dc: 0, dr: 1 },
  { dc: -1, dr: 0 },
  { dc: 0, dr: -1 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(c: number, r: number): string {
  return `${c},${r}`;
}

interface WalkResult {
  cells: { col: number; row: number }[];
  turns: number;
  ok: boolean;
}

/** How many times the road zig-zags across the board. */
export const ZIGZAGS = 5;

/**
 * Carve a corridor from the TOP edge to the BOTTOM edge that zig-zags across
 * the board exactly ZIGZAGS times. Each horizontal sweep is separated from
 * the next by two clear rows, so the road never touches itself, and the drops
 * between sweeps happen at the column where the previous sweep ended.
 */
function serpentine(seed: number): { col: number; row: number }[] {
  const rand = mulberry32(seed);
  const cells: { col: number; row: number }[] = [];
  const push = (c: number, r: number) => {
    const last = cells[cells.length - 1];
    if (last && last.col === c && last.row === r) return;
    cells.push({ col: c, row: r });
  };

  const step = Math.max(2, Math.floor((ROWS - 1) / ZIGZAGS)); // rows between sweeps
  let col = 1 + Math.floor(rand() * (COLS - 2));
  let row = 0;
  push(col, row);
  let dir = rand() < 0.5 ? 1 : -1;

  for (let i = 0; i < ZIGZAGS; i++) {
    const sweepRow = Math.min(i * step, ROWS - 1);
    // Drop down to this sweep at the column the last sweep finished on.
    while (row < sweepRow) {
      row++;
      push(col, row);
    }
    // How far to sweep this time - varies per seed so no two maps match.
    const len = 3 + Math.floor(rand() * (COLS - 3));
    let target = col + dir * len;
    if (target < 0 || target > COLS - 1) {
      dir = -dir;
      target = col + dir * len;
    }
    target = Math.max(0, Math.min(COLS - 1, target));
    while (col !== target) {
      col += Math.sign(target - col);
      push(col, row);
    }
    dir = -dir; // the next sweep runs the other way
  }

  // Final descent to the bottom edge.
  while (row < ROWS - 1) {
    row++;
    push(col, row);
  }

  return cells;
}

type Segment =
  | { kind: 'line'; a: THREE.Vector3; b: THREE.Vector3 }
  | { kind: 'quad'; a: THREE.Vector3; c: THREE.Vector3; b: THREE.Vector3 };

/** Turn the raw cell polyline into a rounded, arc-length sampled curve. */
function buildCurve(cellPts: THREE.Vector3[]): { segments: Segment[]; points: THREE.Vector3[] } {
  const segments: Segment[] = [];
  const pts: THREE.Vector3[] = [];

  const pushLine = (a: THREE.Vector3, b: THREE.Vector3) => {
    if (a.distanceToSquared(b) < 1e-6) return;
    segments.push({ kind: 'line', a: a.clone(), b: b.clone() });
  };

  if (cellPts.length < 2) {
    pushLine(cellPts[0], cellPts[0]);
    return { segments, points: cellPts.map((p) => p.clone()) };
  }

  pushLine(cellPts[0], cellPts[0]);

  for (let i = 1; i < cellPts.length - 1; i++) {
    const prev = cellPts[i - 1];
    const cur = cellPts[i];
    const next = cellPts[i + 1];
    const inDir = cur.clone().sub(prev).normalize();
    const outDir = next.clone().sub(cur).normalize();
    const r = Math.min(0.42, cur.distanceTo(prev) * 0.45, cur.distanceTo(next) * 0.45);
    const p1 = cur.clone().addScaledVector(inDir, -r);
    const p2 = cur.clone().addScaledVector(outDir, r);
    pushLine(pts.length ? pts[pts.length - 1] : p1, p1);
    segments.push({ kind: 'quad', a: p1.clone(), c: cur.clone(), b: p2.clone() });
    pts.push(p1, p2);
  }

  const last = cellPts[cellPts.length - 1];
  pushLine(pts.length ? pts[pts.length - 1] : last, last);

  return { segments, points: pts };
}

function sampleSegments(segments: Segment[], step: number): { pos: THREE.Vector3; tangent: THREE.Vector3; dist: number }[] {
  const out: { pos: THREE.Vector3; tangent: THREE.Vector3; dist: number }[] = [];
  let dist = 0;

  for (const seg of segments) {
    if (seg.kind === 'line') {
      const len = seg.a.distanceTo(seg.b);
      const n = Math.max(1, Math.ceil(len / step));
      const dir = seg.b.clone().sub(seg.a).normalize();
      for (let i = 0; i <= n; i++) {
        if (i === 0 && out.length) continue;
        const t = i / n;
        const p = seg.a.clone().lerp(seg.b, t);
        out.push({ pos: p, tangent: dir.clone(), dist: dist + len * t });
      }
      dist += len;
    } else {
      const approxLen = seg.a.distanceTo(seg.c) + seg.c.distanceTo(seg.b);
      const n = Math.max(3, Math.ceil(approxLen / step));
      let prevP: THREE.Vector3 | null = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const p = seg.a
          .clone()
          .multiplyScalar(mt * mt)
          .add(seg.c.clone().multiplyScalar(2 * mt * t))
          .add(seg.b.clone().multiplyScalar(t * t));
        const tangent = prevP ? p.clone().sub(prevP).normalize() : seg.b.clone().sub(seg.a).normalize();
        out.push({ pos: p, tangent, dist });
        prevP = p;
      }
    }
  }

  // Recompute distances from the accumulated sample positions for accuracy.
  let acc = 0;
  for (let i = 0; i < out.length; i++) {
    if (i > 0) acc += out[i].pos.distanceTo(out[i - 1].pos);
    out[i].dist = acc;
  }
  return out;
}

/** Minimum twists the road must contain, and the shortest acceptable road. */
export const MIN_TURNS = 5;
export const MIN_PATH_CELLS = 27;

export function generatePath(seed: number): GeneratedPath {
  const cells = serpentine(seed >>> 0);
  const cellKeys = new Set<string>(cells.map((c) => key(c.col, c.row)));
  const cellPts = cells.map((c) => {
    const w = cellToWorld(c.col, c.row);
    return new THREE.Vector3(w.x, 0, w.z);
  });

  const { segments } = buildCurve(cellPts);
  const raw = sampleSegments(segments, 0.1);

  const samples: PathSample[] = raw.map((r) => ({ pos: r.pos, tangent: r.tangent, dist: r.dist }));
  const length = samples.length ? samples[samples.length - 1].dist : 1;

  // Buildable slots: EVERY cell the road does not use.
  const pads: Pad[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (cellKeys.has(key(col, row))) continue;
      const w = cellToWorld(col, row);
      const pos = new THREE.Vector3(w.x, 0, w.z);
      // Distance along the road of the closest point (used for ordering).
      let minDist = Infinity;
      let minArc = 0;
      for (const s of samples) {
        const d = (s.pos.x - pos.x) ** 2 + (s.pos.z - pos.z) ** 2;
        if (d < minDist) {
          minDist = d;
          minArc = s.dist;
        }
      }
      pads.push({ id: `pad-${col}-${row}`, col, row, pos, nearDist: minArc });
    }
  }

  return { seed: seed >>> 0, cells, cellKeys, points: cellPts, samples, length, pads };
}

/** Position + tangent at a distance along the path. */
export function sampleAt(path: GeneratedPath, dist: number): PathSample {
  const s = path.samples;
  if (s.length === 0) return { pos: new THREE.Vector3(), tangent: new THREE.Vector3(1, 0, 0), dist: 0 };
  const d = Math.max(0, Math.min(dist, path.length));
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].dist <= d) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const span = b.dist - a.dist || 1;
  const t = (d - a.dist) / span;
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    tangent: a.tangent.clone().lerp(b.tangent, t).normalize(),
    dist: d,
  };
}

/** True when the given grid cell is part of the road (dynamite may go here). */
export function isPathCell(path: GeneratedPath, col: number, row: number): boolean {
  return path.cellKeys.has(key(col, row));
}
