// Exact copies of a World, for rewinding: the copy continues tick for tick exactly as the original
// would (same pending ticks and their order, block events, moving pistons, ticker order, random
// state). Everything reachable from the world is copied with its prototype, keeping aliasing (a
// block entity in both blockEntities and tickers stays one object). Shared, never copied:
// interned block states and other frozen objects, block definitions, directions and functions.

import { Dir } from './dir.js';
import { allBlocks } from './state.js';

let BLOCKS = null;

function shared(v) {
  if (v === null || typeof v !== 'object') return true; // primitives and functions
  if (Object.isFrozen(v) || v instanceof Dir) return true;
  if (!BLOCKS || BLOCKS.size !== allBlocks().length) BLOCKS = new Set(allBlocks());
  return BLOCKS.has(v);
}

function copy(v, memo) {
  if (shared(v)) return v;
  const done = memo.get(v);
  if (done !== undefined) return done;
  let out;
  if (Array.isArray(v)) {
    out = new Array(v.length);
    memo.set(v, out);
    for (let i = 0; i < v.length; i++) {
      const e = v[i];
      out[i] = e === null || typeof e !== 'object' || Object.isFrozen(e) ? e : copy(e, memo);
    }
    if (Object.getPrototypeOf(v) !== Array.prototype) Object.setPrototypeOf(out, Object.getPrototypeOf(v));
    return out;
  }
  if (v instanceof Map) {
    out = new v.constructor();
    memo.set(v, out);
    copyOwn(v, out, memo); // subclass fields (BlockMap._cols) before the entries
    for (const [k, e] of v) Map.prototype.set.call(out, copy(k, memo), copy(e, memo));
    return out;
  }
  if (v instanceof Set) {
    out = new v.constructor();
    memo.set(v, out);
    copyOwn(v, out, memo);
    for (const e of v) Set.prototype.add.call(out, copy(e, memo));
    return out;
  }
  if (ArrayBuffer.isView(v)) {
    out = v.slice();
    memo.set(v, out);
    return out;
  }
  out = Object.create(Object.getPrototypeOf(v));
  memo.set(v, out);
  copyOwn(v, out, memo);
  return out;
}

function copyOwn(from, to, memo) {
  for (const key of Reflect.ownKeys(from)) {
    const d = Object.getOwnPropertyDescriptor(from, key);
    if ('value' in d) d.value = copy(d.value, memo);
    Object.defineProperty(to, key, d);
  }
}

/** A deep, independent copy of `world` (see the file comment). */
export function cloneWorld(world) {
  return copy(world, new Map());
}

/** A deep copy of any plain data reachable from `value`, with the same sharing rules. */
export function cloneDeep(value) {
  return copy(value, new Map());
}
