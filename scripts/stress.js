// Shared helpers for chunk-freeze / restart stress tests of moving machines.

import { World, pos } from '../engine/index.js';

/** Blocks of the machine as a translation-invariant signature (only valid at rest). */
export function signature(w, filter = () => true) {
  const cells = [];
  for (const [k, s] of w.blocks) {
    const [x, y, z] = k.split(',').map(Number);
    if (filter(x, y, z, s)) cells.push([x, y, z, s.key]);
  }
  if (!cells.length) return '';
  const mx = Math.min(...cells.map((c) => c[0]));
  return cells.map(([x, y, z, k]) => `${x - mx},${y},${z},${k}`).sort().join(';');
}

export function atRest(w) {
  for (const s of w.blocks.values()) if (s.id === 'moving_piston' || s.id === 'piston_head') return false;
  return true;
}

export function minX(w, filter = () => true) {
  let m = Infinity;
  for (const [k, s] of w.blocks) {
    const [x, y, z] = k.split(',').map(Number);
    if (filter(x, y, z, s)) m = Math.min(m, x);
  }
  return m;
}

/**
 * Runs `scenario(w, step)` and returns whether the machine still matches `restSig` when at rest,
 * and how far it got.
 */
export function settle(w, maxTicks, filter) {
  for (let i = 0; i < maxTicks; i++) {
    w.tick();
    if (i > 20 && atRest(w)) break;
  }
  return signature(w, filter);
}

export { World, pos };
