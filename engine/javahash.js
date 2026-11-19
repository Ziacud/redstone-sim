// Emulates the iteration order of java.util.HashMap / HashSet keyed by BlockPos.
// Vanilla redstone dust and pistons iterate HashSets/HashMaps of positions, which is the
// source of "locational" behavior, so we reproduce Java's bucket layout exactly
// (default capacity 16, load factor 0.75, order-preserving resize splits).
// Buckets are created on first insert (null until then); that changes nothing about the order.

function spread(h) {
  return (h ^ (h >>> 16)) | 0;
}

function indexIn(bucket, pos) {
  for (let i = 0; i < bucket.length; i++) if (bucket[i].key.equals(pos)) return i;
  return -1;
}

export class JavaPosMap {
  constructor(capacity = 16) {
    this.table = new Array(capacity).fill(null);
    this.size = 0;
  }

  _bucket(pos) {
    return this.table[spread(pos.javaHash) & (this.table.length - 1)];
  }

  get(pos) {
    const b = this._bucket(pos);
    if (b === null) return undefined;
    const i = indexIn(b, pos);
    return i >= 0 ? b[i].value : undefined;
  }

  has(pos) {
    const b = this._bucket(pos);
    return b !== null && indexIn(b, pos) >= 0;
  }

  set(pos, value) {
    const hash = spread(pos.javaHash);
    const idx = hash & (this.table.length - 1);
    let b = this.table[idx];
    if (b === null) {
      b = this.table[idx] = [];
    } else {
      const i = indexIn(b, pos);
      if (i >= 0) {
        b[i].value = value;
        return false;
      }
    }
    b.push({ key: pos, value, hash });
    if (++this.size > this.table.length * 0.75) this._resize();
    return true;
  }

  delete(pos) {
    const b = this._bucket(pos);
    if (b === null) return false;
    const i = indexIn(b, pos);
    if (i < 0) return false;
    b.splice(i, 1);
    this.size--;
    return true;
  }

  _resize() {
    const oldCap = this.table.length;
    const next = new Array(oldCap * 2).fill(null);
    for (let j = 0; j < oldCap; j++) {
      const b = this.table[j];
      if (b === null) continue;
      for (const e of b) {
        // Java splits each bucket into lo/hi lists preserving relative order.
        const k = (e.hash & oldCap) === 0 ? j : j + oldCap;
        (next[k] ??= []).push(e);
      }
    }
    this.table = next;
  }

  *entries() {
    for (const b of this.table) if (b !== null) for (const e of b) yield [e.key, e.value];
  }

  *keys() {
    for (const b of this.table) if (b !== null) for (const e of b) yield e.key;
  }

  /** The keys in iteration order, as a snapshot array. */
  keyArray() {
    const out = [];
    for (const b of this.table) if (b !== null) for (const e of b) out.push(e.key);
    return out;
  }
}

export class JavaPosSet {
  constructor() {
    this.map = new JavaPosMap();
  }
  add(pos) { return this.map.set(pos, true); }
  has(pos) { return this.map.has(pos); }
  get size() { return this.map.size; }
  /** The elements in iteration order (a snapshot; same order as iterating the set). */
  toArray() { return this.map.keyArray(); }
  *[Symbol.iterator]() { yield* this.map.keys(); }
}
