// Litematica schematics (.litematic): NBT read/write and world <-> schematic conversion.
// Pure JavaScript on Uint8Array (works in Node and in the browser). A .litematic file is gzipped
// NBT: callers gunzip before readLitematic and gzip after writeLitematic.
//
// Read: every region, block states, container items (TileEntities "Items"), comparator outputs
// and pending block ticks. Blocks the simulator does not have are skipped and reported.
// Write: one region holding the world's blocks, with container items and comparator outputs.

import { World } from './world.js';
import { pos } from './dir.js';
import { getBlock, hasBlock, makeState } from './state.js';
import { ItemStack } from './items.js';

export const DATA_VERSION = 4790; // Minecraft 26.1.2

// ---------------------------------------------------------------- NBT

/** Parses uncompressed NBT. Longs become BigInt, long arrays BigInt arrays. */
export function readNbt(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let o = 0;
  const str = () => {
    const n = dv.getUint16(o);
    o += 2 + n;
    return dec.decode(bytes.subarray(o - n, o));
  };
  const payload = (t) => {
    switch (t) {
      case 1: return dv.getInt8(o++);
      case 2: return ((o += 2), dv.getInt16(o - 2));
      case 3: return ((o += 4), dv.getInt32(o - 4));
      case 4: return ((o += 8), dv.getBigInt64(o - 8));
      case 5: return ((o += 4), dv.getFloat32(o - 4));
      case 6: return ((o += 8), dv.getFloat64(o - 8));
      case 7: { const n = payload(3); o += n; return bytes.slice(o - n, o); }
      case 8: return str();
      case 9: { const et = dv.getUint8(o++); const n = payload(3); const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const c = {}; for (;;) { const tt = dv.getUint8(o++); if (tt === 0) return c; const k = str(); c[k] = payload(tt); } }
      case 11: { const n = payload(3); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = payload(3); return a; }
      case 12: { const n = payload(3); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = payload(4); return a; }
      default: throw new Error(`bad NBT tag ${t} at byte ${o}`);
    }
  };
  const t = dv.getUint8(o++);
  str();
  return payload(t);
}

/** Tagged NBT values for writeNbt. */
export const nbt = {
  byte: (v) => ({ t: 1, v }),
  int: (v) => ({ t: 3, v }),
  long: (v) => ({ t: 4, v: BigInt(v) }),
  string: (v) => ({ t: 8, v }),
  list: (type, v) => ({ t: 9, type, v }),
  compound: (v) => ({ t: 10, v }),
  longArray: (v) => ({ t: 12, v }),
};

/** Uncompressed NBT bytes of a root compound built from `nbt` tags. */
export function writeNbt(root) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const push = (u8) => {
    chunks.push(u8);
    len += u8.length;
  };
  const num = (n, size, set) => {
    const b = new Uint8Array(size);
    new DataView(b.buffer)[set](0, n);
    push(b);
  };
  const str = (s) => {
    const b = enc.encode(s);
    num(b.length, 2, 'setUint16');
    push(b);
  };
  const payload = (tag) => {
    switch (tag.t) {
      case 1: return push(Uint8Array.of(tag.v & 255));
      case 3: return num(tag.v, 4, 'setInt32');
      case 4: return num(BigInt.asIntN(64, tag.v), 8, 'setBigInt64');
      case 8: return str(tag.v);
      case 9:
        push(Uint8Array.of(tag.v.length ? tag.type : 0));
        num(tag.v.length, 4, 'setInt32');
        for (const e of tag.v) payload(e);
        return;
      case 10:
        for (const [k, e] of Object.entries(tag.v)) {
          if (e === undefined) continue;
          push(Uint8Array.of(e.t));
          str(k);
          payload(e);
        }
        return push(Uint8Array.of(0));
      case 12:
        num(tag.v.length, 4, 'setInt32');
        for (const n of tag.v) num(BigInt.asIntN(64, n), 8, 'setBigInt64');
        return;
      default: throw new Error(`nbt: unsupported tag ${tag.t}`);
    }
  };
  push(Uint8Array.of(10));
  str('');
  payload(root);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// ---------------------------------------------------------------- read

/**
 * A World from a parsed .litematic. Regions keep their place relative to the schematic origin;
 * the result is moved so the schematic's min corner sits at `at` (default 0,0,0).
 * Returns { world, placed, skipped: Map(id -> count), name }.
 */
export function litematicToWorld(root, at = [0, 0, 0]) {
  const w = new World();
  const skipped = new Map();
  const skip = (id) => skipped.set(id, (skipped.get(id) ?? 0) + 1);
  const cache = new Map();
  const toState = (p) => {
    const id = String(p.Name).replace(/^minecraft:/, '');
    const props = p.Properties ?? {};
    const key = id + JSON.stringify(props);
    if (cache.has(key)) return cache.get(key);
    let st = null;
    if (hasBlock(id)) {
      const block = getBlock(id);
      try {
        st = makeState(block, props);
      } catch {
        // drop properties this simulator does not model (e.g. waterlogged on a block without it)
        const known = Object.fromEntries(Object.entries(props).filter(([k]) => k in block.properties));
        try { st = makeState(block, known); } catch { st = null; }
      }
    }
    cache.set(key, st ?? id);
    return st ?? id;
  };
  const regions = Object.values(root.Regions ?? {});
  // schematic min corner over all regions
  const boxes = regions.map((r) => {
    const s = { x: r.Size.x, y: r.Size.y, z: r.Size.z };
    const min = (a) => Math.min(r.Position[a], r.Position[a] + s[a] + (s[a] < 0 ? 1 : -1));
    return { r, min: { x: min('x'), y: min('y'), z: min('z') }, size: { x: Math.abs(s.x), y: Math.abs(s.y), z: Math.abs(s.z) } };
  });
  const lo = { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)), z: Math.min(...boxes.map((b) => b.min.z)) };
  let placed = 0;
  const regionPos = (b, x, y, z) => pos(at[0] + b.min.x - lo.x + x, at[1] + b.min.y - lo.y + y, at[2] + b.min.z - lo.z + z);
  for (const b of boxes) {
    const { r, size } = b;
    const pal = r.BlockStatePalette.map(toState);
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(pal.length))));
    const longs = r.BlockStates.map((v) => BigInt.asUintN(64, BigInt(v)));
    const mask = (1n << bits) - 1n;
    const volume = size.x * size.y * size.z;
    for (let i = 0; i < volume; i++) {
      const start = BigInt(i) * bits;
      const a = Number(start >> 6n);
      const off = start & 63n;
      let v = longs[a] >> off;
      if (off + bits > 64n) v |= longs[a + 1] << (64n - off);
      const st = pal[Number(v & mask)];
      if (st === undefined || st === 'air' || st?.block?.isAir) continue;
      if (typeof st === 'string') {
        skip(st);
        continue;
      }
      const x = i % size.x;
      const z = Math.floor(i / size.x) % size.z;
      const y = Math.floor(i / (size.x * size.z));
      const p = regionPos(b, x, y, z);
      if (w.isOutsideBuildHeight(p)) continue;
      w.setRaw(p, st);
      placed++;
    }
  }
  // block entities: create them all, then fill containers and comparators
  for (const [key, st] of w.blocks) {
    if (!st.block.hasBlockEntity(st)) continue;
    const [x, y, z] = key.split(',').map(Number);
    const be = st.block.newBlockEntity?.(pos(x, y, z), st);
    if (be) w.setBlockEntity(be);
  }
  for (const b of boxes) {
    for (const te of b.r.TileEntities ?? []) {
      const p = regionPos(b, num(te.x), num(te.y), num(te.z));
      const be = w.getBlockEntity(p);
      if (!be) continue;
      if (Array.isArray(te.Items) && be.items) {
        for (const it of te.Items) {
          const slot = num(it.Slot);
          const id = String(it.id ?? '').replace(/^minecraft:/, '');
          const count = num(it.count ?? it.Count ?? 1);
          if (slot >= 0 && slot < be.items.length && id) be.items[slot] = ItemStack.of(id, count);
        }
      }
      if (be.type === 'comparator' && te.OutputSignal !== undefined) be.output = num(te.OutputSignal);
    }
    for (const t of b.r.PendingBlockTicks ?? []) {
      const id = String(t.Block ?? '').replace(/^minecraft:/, '');
      if (!hasBlock(id)) continue;
      w.scheduleTick(regionPos(b, num(t.x), num(t.y), num(t.z)), getBlock(id), Math.max(1, num(t.Time ?? 1)), num(t.Priority ?? 0));
    }
  }
  w.flushChanged();
  return { world: w, placed, skipped, name: root.Metadata?.Name ?? null };
}

// ---------------------------------------------------------------- write

const itemsTag = (be) =>
  nbt.list(
    10,
    be.save().items.map(([slot, id, count]) => nbt.compound({ Slot: nbt.byte(slot), id: nbt.string(`minecraft:${id}`), count: nbt.int(count) })),
  );

/**
 * One-region .litematic NBT (schematic version 6) of the world's blocks (or a box [from, to]).
 * Moving pistons are written as the block they carry. Returns the root tag for writeNbt.
 */
export function worldToLitematic(world, { name = 'redstone-sim', author = 'redstone-sim', from, to } = {}) {
  const entries = [];
  for (const [key, st] of world.blocks) {
    const [x, y, z] = key.split(',').map(Number);
    if (from && to && (x < Math.min(from[0], to[0]) || x > Math.max(from[0], to[0]) || y < Math.min(from[1], to[1]) || y > Math.max(from[1], to[1]) || z < Math.min(from[2], to[2]) || z > Math.max(from[2], to[2]))) continue;
    let s = st;
    if (s.id === 'moving_piston') {
      const be = world.blockEntities.get(key);
      if (!be?.movedState) continue;
      s = be.movedState;
    }
    entries.push([x, y, z, s, key]);
  }
  if (!entries.length) throw new Error('nothing to export');
  const lo = [0, 1, 2].map((i) => Math.min(...entries.map((e) => e[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...entries.map((e) => e[i])));
  const size = { x: hi[0] - lo[0] + 1, y: hi[1] - lo[1] + 1, z: hi[2] - lo[2] + 1 };
  const volume = size.x * size.y * size.z;
  const palette = [world.air];
  const index = new Map([[world.air, 0]]);
  const cells = new Uint32Array(volume);
  const tiles = [];
  for (const [x, y, z, s, key] of entries) {
    if (!index.has(s)) {
      index.set(s, palette.length);
      palette.push(s);
    }
    const rx = x - lo[0], ry = y - lo[1], rz = z - lo[2];
    cells[(ry * size.z + rz) * size.x + rx] = index.get(s);
    const be = world.blockEntities.get(key);
    if (be?.items) tiles.push(nbt.compound({ x: nbt.int(rx), y: nbt.int(ry), z: nbt.int(rz), id: nbt.string(`minecraft:${s.id}`), Items: itemsTag(be) }));
    else if (be?.type === 'comparator') tiles.push(nbt.compound({ x: nbt.int(rx), y: nbt.int(ry), z: nbt.int(rz), id: nbt.string('minecraft:comparator'), OutputSignal: nbt.int(be.output) }));
  }
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const longs = new Array(Math.ceil((volume * bits) / 64)).fill(0n);
  for (let i = 0; i < volume; i++) {
    const v = BigInt(cells[i]);
    if (!v) continue;
    const start = i * bits;
    const a = start >> 6;
    const off = BigInt(start & 63);
    longs[a] |= (v << off) & 0xffffffffffffffffn;
    const b = (start + bits - 1) >> 6;
    if (b !== a) longs[b] |= v >> (64n - off);
  }
  const vec = (v) => nbt.compound({ x: nbt.int(v.x), y: nbt.int(v.y), z: nbt.int(v.z) });
  const paletteTags = palette.map((s) => {
    const c = { Name: nbt.string(`minecraft:${s.id}`) };
    const props = Object.entries(s.props);
    if (props.length) c.Properties = nbt.compound(Object.fromEntries(props.map(([k, v]) => [k, nbt.string(String(v))])));
    return nbt.compound(c);
  });
  const ticks = [...world.pendingTicks.values()]
    .filter((t) => world.getBlockState(t.pos).id === t.id && t.pos.x >= lo[0] && t.pos.x <= hi[0] && t.pos.y >= lo[1] && t.pos.y <= hi[1] && t.pos.z >= lo[2] && t.pos.z <= hi[2])
    .sort((a, b) => a.sub - b.sub)
    .map((t) => nbt.compound({
      Block: nbt.string(`minecraft:${t.id}`),
      Priority: nbt.int(t.priority),
      SubTick: nbt.long(t.sub),
      Time: nbt.int(Math.max(0, t.trigger - world.time)),
      x: nbt.int(t.pos.x - lo[0]), y: nbt.int(t.pos.y - lo[1]), z: nbt.int(t.pos.z - lo[2]),
    }));
  const now = BigInt(Date.now());
  return nbt.compound({
    Version: nbt.int(6),
    SubVersion: nbt.int(1),
    MinecraftDataVersion: nbt.int(DATA_VERSION),
    Metadata: nbt.compound({
      Name: nbt.string(name),
      Author: nbt.string(author),
      Description: nbt.string(''),
      RegionCount: nbt.int(1),
      TotalBlocks: nbt.int(entries.length),
      TotalVolume: nbt.int(volume),
      TimeCreated: nbt.long(now),
      TimeModified: nbt.long(now),
      EnclosingSize: vec(size),
    }),
    Regions: nbt.compound({
      [name]: nbt.compound({
        Position: vec({ x: 0, y: 0, z: 0 }),
        Size: vec(size),
        BlockStatePalette: nbt.list(10, paletteTags),
        BlockStates: nbt.longArray(longs),
        TileEntities: nbt.list(10, tiles),
        Entities: nbt.list(10, []),
        PendingBlockTicks: nbt.list(10, ticks),
        PendingFluidTicks: nbt.list(10, []),
      }),
    }),
  });
}

