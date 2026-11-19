// Reads blocks, block entities and scheduled block ticks from a real Minecraft (Java, Anvil)
// world, so a real game's state can be inspected or loaded into the simulator.
//
//   readRegion(worldDir, x0, z0, x1, z1, [y0, y1])  -> { blocks: [[x, y, z, 'id[props]']], blockEntities, ticks }
//
// Run: node scripts/mc-world.js <world dir> x0 z0 x1 z1 [y0 y1] [--save name]
//   --save name writes designs/<name>.json (blocks, moving pistons and pending ticks) for the viewer.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- NBT
export function readNbt(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const i16 = () => ((o += 2), buf.readInt16BE(o - 2));
  const u16 = () => ((o += 2), buf.readUInt16BE(o - 2));
  const i32 = () => ((o += 4), buf.readInt32BE(o - 4));
  const i64 = () => ((o += 8), buf.readBigInt64BE(o - 8));
  const str = () => {
    const n = u16();
    o += n;
    return buf.toString('utf8', o - n, o);
  };
  const payload = (t) => {
    switch (t) {
      case 1: return (buf.readInt8(o++));
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return ((o += 4), buf.readFloatBE(o - 4));
      case 6: return ((o += 8), buf.readDoubleBE(o - 8));
      case 7: { const n = i32(); o += n; return buf.subarray(o - n, o); }
      case 8: return str();
      case 9: { const et = u8(); const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const c = {}; for (;;) { const tt = u8(); if (tt === 0) return c; const k = str(); c[k] = payload(tt); } }
      case 11: { const n = i32(); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i32(); return a; }
      case 12: { const n = i32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i64(); return a; }
      default: throw new Error(`bad NBT tag ${t} at ${o}`);
    }
  };
  const t = u8();
  str();
  return payload(t);
}

// ---------------------------------------------------------------- regions
function readChunk(regionBuf, lx, lz) {
  const idx = 4 * (lx + lz * 32);
  const loc = regionBuf.readUInt32BE(idx);
  const off = (loc >>> 8) * 4096;
  if (!off) return null;
  const len = regionBuf.readUInt32BE(off);
  const type = regionBuf[off + 4];
  const data = regionBuf.subarray(off + 5, off + 4 + len);
  const raw = type === 2 ? zlib.inflateSync(data) : type === 1 ? zlib.gunzipSync(data) : type === 3 ? data : null;
  if (!raw) throw new Error(`unsupported chunk compression ${type}`);
  return readNbt(raw);
}

const stateKey = (p) => {
  const id = p.Name.replace(/^minecraft:/, '');
  const props = p.Properties ? Object.entries(p.Properties).map(([k, v]) => `${k}=${v}`) : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
};

export function readRegion(worldDir, x0, z0, x1, z1, y0 = -64, y1 = 319) {
  const blocks = [];
  const blockEntities = [];
  const ticks = [];
  const regions = new Map();
  for (let cx = x0 >> 4; cx <= x1 >> 4; cx++)
    for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) {
      const rk = `${cx >> 5}.${cz >> 5}`;
      if (!regions.has(rk)) {
        // 26.x keeps the overworld in dimensions/minecraft/overworld; older worlds in region/
        const modern = path.join(worldDir, 'dimensions', 'minecraft', 'overworld', 'region', `r.${rk}.mca`);
        const f = fs.existsSync(modern) ? modern : path.join(worldDir, 'region', `r.${rk}.mca`);
        regions.set(rk, fs.existsSync(f) ? fs.readFileSync(f) : null);
      }
      const rb = regions.get(rk);
      if (!rb) continue;
      const ch = readChunk(rb, cx & 31, cz & 31);
      if (!ch) continue;
      for (const sec of ch.sections ?? []) {
        const pal = sec.block_states?.palette;
        if (!pal) continue;
        const sy = sec.Y;
        const data = sec.block_states.data;
        const bits = Math.max(4, Math.ceil(Math.log2(pal.length)));
        const per = Math.floor(64 / bits);
        const mask = (1n << BigInt(bits)) - 1n;
        for (let i = 0; i < 4096; i++) {
          let pi = 0;
          if (pal.length > 1) {
            const word = BigInt.asUintN(64, data[Math.floor(i / per)]);
            pi = Number((word >> BigInt((i % per) * bits)) & mask);
          }
          const p = pal[pi];
          if (p.Name === 'minecraft:air') continue;
          const x = cx * 16 + (i & 15);
          const z = cz * 16 + ((i >> 4) & 15);
          const y = sy * 16 + (i >> 8);
          if (x < x0 || x > x1 || z < z0 || z > z1 || y < y0 || y > y1) continue;
          blocks.push([x, y, z, stateKey(p)]);
        }
      }
      for (const be of ch.block_entities ?? []) {
        if (be.x < x0 || be.x > x1 || be.z < z0 || be.z > z1 || be.y < y0 || be.y > y1) continue;
        blockEntities.push(be);
      }
      for (const t of ch.block_ticks ?? []) {
        if (t.x < x0 || t.x > x1 || t.z < z0 || t.z > z1 || t.y < y0 || t.y > y1) continue;
        ticks.push(t);
      }
    }
  return { blocks, blockEntities, ticks };
}

/** In the simulator's design format (redstone-sim/1), shifted by (dx, dy, dz). */
export function toDesign({ blocks, blockEntities, ticks }, dx = 0, dy = 0, dz = 0) {
  const be = [];
  for (const e of blockEntities) {
    // a comparator keeps its output signal in its block entity; without it a powered comparator
    // would come back outputting 0
    if (e.id === 'minecraft:comparator') {
      be.push({ pos: [e.x + dx, e.y + dy, e.z + dz], type: 'comparator', data: { output: e.OutputSignal ?? 0 } });
      continue;
    }
    if (e.id !== 'minecraft:piston') continue;
    be.push({
      pos: [e.x + dx, e.y + dy, e.z + dz],
      type: 'moving_piston',
      data: {
        movedState: stateKey(e.blockState),
        direction: ['down', 'up', 'north', 'south', 'west', 'east'][e.facing],
        extending: !!e.extending,
        isSourcePiston: !!e.source,
        progress: e.progress,
        progressO: e.progress, // what a reload does
        lastTicked: 0,
      },
    });
  }
  return {
    format: 'redstone-sim/1',
    time: 0,
    blocks: blocks.map(([x, y, z, k]) => [x + dx, y + dy, z + dz, k]),
    blockEntities: be,
    // a saved tick runs one tick earlier than its delay after a load (see World.simulateRestart)
    ticks: ticks.map((t) => ({ pos: [t.x + dx, t.y + dy, t.z + dz], block: t.i.replace(/^minecraft:/, ''), delay: t.t - 1, priority: t.p })),
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'mc-world.js') {
  const [dir, ...rest] = process.argv.slice(2);
  const saveAt = rest.indexOf('--save');
  const name = saveAt >= 0 ? rest.splice(saveAt, 2)[1] : null;
  const [x0, z0, x1, z1, y0 = -64, y1 = 319] = rest.map(Number);
  const r = readRegion(dir, x0, z0, x1, z1, y0, y1);
  console.log(`${r.blocks.length} blocks, ${r.blockEntities.length} block entities, ${r.ticks.length} pending ticks`);
  if (name) {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    fs.writeFileSync(path.join(ROOT, 'designs', `${name}.json`), JSON.stringify(toDesign(r)));
    console.log(`wrote designs/${name}.json`);
  }
}

// ---------------------------------------------------------------- Litematica schematics
// readLitematic(file) -> { blocks: [[x, y, z, 'id[props]']] } with x/y/z from the schematic's min
// corner (a .litematic does not store where it was taken from: align it yourself).
export function readLitematic(file) {
  const root = readNbt(zlib.gunzipSync(fs.readFileSync(file)));
  const blocks = [];
  for (const r of Object.values(root.Regions)) {
    const sx = Math.abs(r.Size.x), sy = Math.abs(r.Size.y), sz = Math.abs(r.Size.z);
    // the region's min corner, relative to the schematic origin
    const mx = Math.min(r.Position.x, r.Position.x + r.Size.x + (r.Size.x < 0 ? 1 : -1));
    const my = Math.min(r.Position.y, r.Position.y + r.Size.y + (r.Size.y < 0 ? 1 : -1));
    const mz = Math.min(r.Position.z, r.Position.z + r.Size.z + (r.Size.z < 0 ? 1 : -1));
    const pal = r.BlockStatePalette.map(stateKey);
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(pal.length))));
    const longs = r.BlockStates.map((v) => BigInt.asUintN(64, v));
    const mask = (1n << bits) - 1n;
    for (let i = 0; i < sx * sy * sz; i++) {
      const start = BigInt(i) * bits;
      const a = Number(start >> 6n), off = start & 63n;
      let v = longs[a] >> off;
      if (off + bits > 64n) v |= longs[a + 1] << (64n - off);
      const k = pal[Number(v & mask)];
      if (k === 'air') continue;
      const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
      blocks.push([mx + x, my + y, mz + z, k]);
    }
  }
  return { blocks };
}
