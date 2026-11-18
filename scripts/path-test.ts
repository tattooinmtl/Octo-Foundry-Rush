/**
 * Offline check of the procedural path generator.
 * Run: node --import ./scripts/register-ts.mjs scripts/path-test.ts
 */
import { generatePath, ZIGZAGS } from '../src/core/path.ts';
import { COLS, ROWS } from '../src/core/config.ts';

let minSweeps = Infinity;
let maxSweeps = 0;
let minLen = Infinity;
let maxLen = 0;
let minPads = Infinity;
const signatures = new Set<string>();

for (let i = 0; i < 200; i++) {
  const p = generatePath((i * 2654435761) >>> 0);

  // Count the horizontal sweeps (= zig-zags).
  let sweeps = 0;
  for (let k = 1; k < p.cells.length; k++) {
    const a = p.cells[k - 1];
    const b = p.cells[k];
    if (a.row === b.row && k < 2) sweeps++;
    else if (a.row === b.row && p.cells[k - 2].row !== a.row) sweeps++;
  }
  minSweeps = Math.min(minSweeps, sweeps);
  maxSweeps = Math.max(maxSweeps, sweeps);

  minLen = Math.min(minLen, p.length);
  maxLen = Math.max(maxLen, p.length);
  minPads = Math.min(minPads, p.pads.length);
  signatures.add(p.cells.map((c) => `${c.col},${c.row}`).join(' '));

  // The road must start at the top and end at the bottom.
  if (p.cells[0].row !== 0) throw new Error('road does not start at the top');
  if (p.cells[p.cells.length - 1].row !== ROWS - 1) throw new Error('road does not end at the bottom');

  // The road must never touch itself outside of consecutive cells.
  const set = new Set(p.cells.map((c) => `${c.col},${c.row}`));
  for (let k = 0; k < p.cells.length; k++) {
    const c = p.cells[k];
    for (const [dc, dr] of [
      [1, 0],
      [0, 1],
    ]) {
      const n = `${c.col + dc},${c.row + dr}`;
      if (!set.has(n)) continue;
      const idx = p.cells.findIndex((x) => `${x.col},${x.row}` === n);
      if (Math.abs(idx - k) !== 1) throw new Error(`self-touching road at ${c.col},${c.row} vs ${n}`);
    }
  }

  // Every free cell must be a build socket.
  const free = COLS * ROWS - p.cells.length;
  if (p.pads.length !== free) {
    throw new Error(`expected ${free} build sockets, got ${p.pads.length}`);
  }
}

console.log('maps generated :', signatures.size, '/ 200 unique');
console.log('zig-zags        :', minSweeps, '->', maxSweeps, '(target', ZIGZAGS + ')');
console.log('path length     :', minLen.toFixed(1), '->', maxLen.toFixed(1), 'units');
console.log('build sockets   :', minPads, 'min');
