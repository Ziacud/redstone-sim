import { World, pos } from '../engine/index.js';

export { pos };

/** A world with a stone floor at y=0 over x,z in [-4, 40). */
export function floorWorld() {
  const w = new World();
  for (let x = -4; x < 40; x++) for (let z = -4; z < 40; z++) w.setRaw(pos(x, 0, z), stoneState(w));
  w.flushChanged();
  return w;
}

function stoneState(w) {
  return w.__stone ?? (w.__stone = makeStone());
}

import { getBlock } from '../engine/index.js';
function makeStone() {
  return getBlock('stone').defaultState;
}

export function place(w, x, y, z, id, props = {}) {
  return w.placeBlock(pos(x, y, z), id, props);
}

export function state(w, x, y, z) {
  return w.getBlockState(pos(x, y, z));
}

/** Runs n ticks and records fn() after each tick. */
export function record(w, n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    w.tick();
    out.push(fn());
  }
  return out;
}
