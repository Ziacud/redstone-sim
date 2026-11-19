// Conformance suite: replays tickwright fixtures (real Minecraft 26.3 captures) in this engine
// and compares at three levels, like tickwright does:
//   state - every block's state at the end of every tick
//   phase - each block's changes, tagged with tick and tick phase
//   order - every set / neighbor / shape update, scheduled tick and block event, in order
//
// Usage: node conformance/run.js [name-filter] [--level order|phase|state] [--verbose] [--json out.json]
// First run: node scripts/fetch-tickwright.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { World, pos, getBlock, hasBlock, makeState, parseBlockString } from '../engine/index.js';
import { ItemStack } from '../engine/items.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'tickwright');
const MARGIN = 3;
const COMPARED_KINDS = new Set(['set', 'neighbor', 'shape', 'schedule', 'tick', 'block_event_queued', 'block_event']);
// The captures also log every container change ('items'); tickwright does not compare them, but
// --items does (a stricter check of the item logic).
if (process.argv.includes('--items')) COMPARED_KINDS.add('items');
// Items a dispenser handles with a special behaviour (placing fluids, ...) that is not simulated.
const SPECIAL_DISPENSE = /bucket|powder_snow|bone_meal|shulker_box|tnt|fire_charge|flint_and_steel|shears|arrow|egg|snowball|potion|bottle|firework|minecart|boat|_head|skull|carved_pumpkin|armor|helmet|chestplate|leggings|boots|saddle|honeycomb|brush|wind_charge|spawn_egg/;

// ------------------------------------------------------------------ helpers

export function canonical(s) {
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(s);
  if (!m) return s;
  if (!m[2]) return m[1];
  const props = m[2].split(',').map((p) => p.trim()).sort();
  return `${m[1]}[${props.join(',')}]`;
}

function toState(str) {
  const { id, props } = parseBlockString(str);
  if (!hasBlock(id)) throw new Unsupported(`block ${id}`);
  try {
    return makeState(getBlock(id), props);
  } catch (e) {
    throw new Unsupported(`${id}: ${e.message}`);
  }
}

class Unsupported extends Error {}
class SetupMismatch extends Error {}

function parseTransform(t) {
  const m = /^(m?)r(\d+)$/.exec(t);
  return { mirror: m[1] === 'm', turns: (Number(m[2]) / 90) % 4 };
}

function tPos([x, y, z], [sx, , sz], tr) {
  let w = sx;
  let d = sz;
  if (tr.mirror) x = w - 1 - x;
  for (let i = 0; i < tr.turns; i++) {
    [x, z] = [d - 1 - z, x];
    [w, d] = [d, w];
  }
  return [x, y, z];
}

function tDir(dir, tr) {
  let d = dir;
  if (tr.mirror) d = { east: 'west', west: 'east' }[d] ?? d;
  for (let i = 0; i < tr.turns; i++) d = { north: 'east', east: 'south', south: 'west', west: 'north' }[d] ?? d;
  return d;
}

function tState(str, tr) {
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(str);
  if (!m[2]) return str;
  const props = m[2].split(',').map((p) => {
    const [k, v] = p.split('=');
    if (['north', 'east', 'south', 'west'].includes(k)) return `${tDir(k, tr)}=${v}`;
    if (k === 'facing') return `${k}=${tDir(v, tr)}`;
    // the crafter's FrontAndTop: both parts turn
    if (k === 'orientation') return `${k}=${v.split('_').map((d) => tDir(d, tr)).join('_')}`;
    // Block.mirror: doors swap their hinge, chests their half
    if (tr.mirror && k === 'hinge') return `${k}=${v === 'left' ? 'right' : 'left'}`;
    if (tr.mirror && k === 'type' && (v === 'left' || v === 'right')) return `${k}=${v === 'left' ? 'right' : 'left'}`;
    return p;
  });
  return `${m[1]}[${props.join(',')}]`;
}

let fixtureIndex = null;
function findFixture(name) {
  if (!fixtureIndex) {
    fixtureIndex = new Map();
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.json')) {
          const fx = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (fx.name) fixtureIndex.set(fx.name, { ...fx, file: path.relative(VENDOR, p) });
        }
      }
    };
    walk(path.join(VENDOR, 'fixtures'));
  }
  return fixtureIndex.get(name);
}

// ------------------------------------------------------------------ run one trace

export function runTrace(trace) {
  const [name, transform] = trace.fixture.split('~')[0].split('@');
  const fx = findFixture(name);
  if (!fx) throw new Unsupported(`fixture ${name} not found`);
  if (fx.file.includes('experiments')) throw new Unsupported('redstone experiments enabled (out of scope)');
  if (fx.start_entities?.length || trace.entities?.length) throw new Unsupported('entities');
  for (const s of fx.stimuli ?? []) {
    if (!['use', 'set', 'destroy', 'page'].includes(s.action)) throw new Unsupported(`stimulus ${s.action}`);
  }
  if (Object.values(fx.palette).some((s) => /(^|:)water\b|waterlogged=true/.test(s))) {
    throw new Unsupported('fluid flow (water is static in this engine)');
  }
  const tr = parseTransform(transform);
  const size0 = [fx.layers[0][0].length, fx.layers.length, fx.layers[0].length];
  const size = tr.turns % 2 ? [size0[2], size0[1], size0[0]] : size0;
  const origin = trace.origin;

  const w = new World();
  if (fx.max_chained_updates !== undefined) w.updater.max = fx.max_chained_updates;
  const at = (rel) => pos(rel[0] + origin[0], rel[1] + origin[1], rel[2] + origin[2]);
  // The capture harness places the resolved fixture block by block, sorted by (y, z, x), with
  // flags 2|16: no neighbor or shape updates, but onPlace still runs (and may schedule ticks).
  const placed = [];
  fx.layers.forEach((layer, y) =>
    layer.forEach((row, z) =>
      [...row].forEach((ch, x) => {
        if (ch === '.') return;
        const st = fx.palette[ch];
        if (!st) throw new Unsupported(`palette char ${ch}`);
        placed.push([...tPos([x, y, z], size0, tr), tState(st, tr)]);
      }),
    ),
  );
  placed.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  const parsed = placed.map(([x, y, z, s]) => [x, y, z, toState(s)]);
  for (const [x, y, z, st] of parsed) w.setBlock(at([x, y, z]), st, 2 | 16);
  for (const c of fx.comparators ?? []) {
    const be = w.getBlockEntity(at(tPos(c.pos, size0, tr)));
    if (be) be.output = c.output;
  }
  for (const c of fx.containers ?? []) {
    const p = at(tPos(c.pos, size0, tr));
    const be = w.getBlockEntity(p);
    if (!be || typeof be.setItem !== 'function') throw new Unsupported('container type');
    if (be.type === 'dispenser' && c.items.some((it) => SPECIAL_DISPENSE.test(it.id))) throw new Unsupported('dispenser item behaviour');
    if (c.items.some((it) => it.components)) throw new Unsupported('item components');
    // Container.setItem, once per item (wakes comparators where setItem calls setChanged)
    for (const it of c.items) be.setItem(it.slot, ItemStack.of(it.id, it.count));
  }
  for (const l of fx.lecterns ?? []) {
    // a written book of `pages` pages, open at `page`
    const be = w.getBlockEntity(at(tPos(l.pos, size0, tr)));
    if (!be || typeof be.setPage !== 'function') throw new Unsupported('lectern');
    be.pageCount = l.pages;
    be.page = 0;
    if (l.page) be.setPage(l.page); // the harness turns the page: a 2 gt pulse starts
  }
  w.flushChanged();
  // The world after setup must match the captured initial blocks.
  const init = new Map(trace.initial.map(([x, y, z, s]) => [`${x},${y},${z}`, canonical(s)]));
  for (const [key, s] of w.blocks) {
    const [x, y, z] = key.split(',').map(Number);
    const k = `${x - origin[0]},${y - origin[1]},${z - origin[2]}`;
    if (init.get(k) !== canonical(s.key)) throw new SetupMismatch(`${k}: game ${init.get(k) ?? 'air'}, engine ${s.key}`);
    init.delete(k);
  }
  if (init.size) throw new SetupMismatch(`missing ${[...init.keys()][0]}`);

  const stimuli = (fx.stimuli ?? []).map((s) => ({ ...s, pos: tPos(s.pos, size0, tr) }));

  w.time = 0;
  w.rec = { tick: 0, phase: 'input', entries: [] };
  const states = []; // end-of-tick snapshot per tick
  for (let t = 1; t <= trace.ticks; t++) {
    w.rec.tick = t;
    w.rec.phase = 'input';
    for (const s of stimuli.filter((s) => s.tick === t)) {
      const p = at(s.pos);
      // containers are emptied before the action (no items spill); the captures show no update
      // from a lectern there, so its book stays
      if (s.discard_contents) {
        const be = w.getBlockEntity(p);
        if (be?.items) be.clearContent();
      }
      if (s.action === 'use') w.useBlock(p);
      else if (s.action === 'page') w.getBlockEntity(p).setPage(s.page);
      else if (s.action === 'destroy') w.destroyBlock(p, false);
      else if (s.action === 'set') {
        const st = toState(tState(s.state, tr));
        if (s.quiet) w.setBlock(p, st, 2 | 16);
        else w.setBlock(p, st, 3);
      }
    }
    w.tick();
    states.push(new Map([...w.blocks].map(([k, v]) => [k, v.key])));
  }

  const inBox = ([x, y, z]) =>
    x >= -MARGIN && x < size[0] + MARGIN && y >= -MARGIN && y < size[1] + MARGIN && z >= -MARGIN && z < size[2] + MARGIN;
  const rel = (e) => [e.pos[0] - origin[0], e.pos[1] - origin[1], e.pos[2] - origin[2]];
  const actual = w.rec.entries
    .map((e) => ({ ...e, pos: rel(e) }))
    .filter((e) => COMPARED_KINDS.has(e.kind) && inBox(e.pos))
    .map((e) => ({ ...e, state: e.state === undefined ? undefined : canonical(e.state) }));
  return { actual, states, origin, inBox };
}

// ------------------------------------------------------------------ compare

const fmt = (e) =>
  e ? `t${e.tick} ${e.phase} ${e.kind} [${e.pos}]${e.state ? ` ${e.state}` : ''}${e.detail ? ` (${e.detail})` : ''}` : '(end)';

function sameEntry(a, b) {
  return (
    a.tick === b.tick &&
    a.phase === b.phase &&
    a.kind === b.kind &&
    a.pos[0] === b.pos[0] && a.pos[1] === b.pos[1] && a.pos[2] === b.pos[2] &&
    (a.state ?? null) === (b.state ?? null) &&
    (a.kind === 'schedule' || a.kind === 'block_event' ? a.detail === b.detail : true)
  );
}

export function compare(trace, run) {
  const expected = trace.entries
    .filter((e) => COMPARED_KINDS.has(e.kind))
    .map((e) => ({ ...e, state: e.state === undefined ? undefined : canonical(e.state) }));
  const out = {};

  // order
  if (trace.levels.includes('order')) {
    let i = 0;
    while (i < expected.length && i < run.actual.length && sameEntry(expected[i], run.actual[i])) i++;
    out.order =
      i === expected.length && i === run.actual.length
        ? null
        : { index: i, expected: expected.slice(Math.max(0, i - 3), i + 4).map(fmt), actual: run.actual.slice(Math.max(0, i - 3), i + 4).map(fmt), at: Math.min(3, i) };
  }

  // phase: per position, the sequence of (tick, phase, state) changes
  const bySet = (list) => {
    const m = new Map();
    for (const e of list) if (e.kind === 'set') {
      const k = e.pos.join(',');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(`t${e.tick}/${e.phase}/${e.state}`);
    }
    return m;
  };
  const pe = bySet(expected);
  const pa = bySet(run.actual);
  let phaseDiff = null;
  for (const k of new Set([...pe.keys(), ...pa.keys()])) {
    const a = (pe.get(k) ?? []).join(' ');
    const b = (pa.get(k) ?? []).join(' ');
    if (a !== b) {
      phaseDiff = { pos: k, expected: pe.get(k) ?? [], actual: pa.get(k) ?? [] };
      break;
    }
  }
  out.phase = phaseDiff;

  // state: replay expected sets and compare with the engine's end-of-tick worlds
  const cur = new Map(trace.initial.map(([x, y, z, s]) => [`${x},${y},${z}`, canonical(s)]));
  let stateDiff = null;
  for (let t = 1; t <= trace.ticks && !stateDiff; t++) {
    for (const e of expected) if (e.kind === 'set' && e.tick === t) {
      const k = e.pos.join(',');
      if (e.state === 'air') cur.delete(k);
      else cur.set(k, e.state);
    }
    const mine = new Map();
    for (const [key, s] of run.states[t - 1]) {
      const [x, y, z] = key.split(',').map(Number);
      const r = [x - run.origin[0], y - run.origin[1], z - run.origin[2]];
      if (run.inBox(r)) mine.set(r.join(','), canonical(s));
    }
    for (const k of new Set([...cur.keys(), ...mine.keys()])) {
      if ((cur.get(k) ?? 'air') !== (mine.get(k) ?? 'air')) {
        stateDiff = { tick: t, pos: k, expected: cur.get(k) ?? 'air', actual: mine.get(k) ?? 'air' };
        break;
      }
    }
  }
  out.state = stateDiff;
  return out;
}

// ------------------------------------------------------------------ CLI

export function loadTraces(filter) {
  const dir = path.join(VENDOR, 'traces', '26.3');
  if (!fs.existsSync(dir)) throw new Error('No traces. Run: node scripts/fetch-tickwright.js');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz') && (!filter || f.includes(filter)))
    .sort()
    .map((f) => path.join(dir, f));
}

export function readTrace(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const level = args.includes('--level') ? args[args.indexOf('--level') + 1] : 'order';
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const filter = args.find((a, i) => !a.startsWith('--') && !['--level', '--json'].includes(args[i - 1]));
  const results = [];
  const skipped = new Map();
  for (const file of loadTraces(filter)) {
    const trace = readTrace(file);
    try {
      const run = runTrace(trace);
      const diff = compare(trace, run);
      results.push({ id: trace.fixture, diff });
    } catch (e) {
      if (e instanceof Unsupported) {
        skipped.set(e.message, (skipped.get(e.message) ?? 0) + 1);
      } else {
        results.push({ id: trace.fixture, crash: e.stack.split('\n').slice(0, 4).join('\n') });
      }
    }
  }
  const pass = (lv) => results.filter((r) => !r.crash && r.diff[lv] === null).length;
  const ran = results.length;
  console.log(`ran ${ran} traces, skipped ${[...skipped.values()].reduce((a, b) => a + b, 0)} (unsupported)`);
  console.log(`  state: ${pass('state')}/${ran}   phase: ${pass('phase')}/${ran}   order: ${pass('order')}/${ran}   crashes: ${results.filter((r) => r.crash).length}`);
  const failing = results.filter((r) => r.crash || r.diff[level] !== null);
  const byFixture = new Map();
  for (const r of failing) {
    const n = r.id.split('@')[0];
    if (!byFixture.has(n)) byFixture.set(n, []);
    byFixture.get(n).push(r);
  }
  console.log(`\nfailing at level "${level}": ${failing.length} traces in ${byFixture.size} fixtures`);
  for (const [n, rs] of byFixture) {
    const r = rs[0];
    console.log(`- ${n} (${rs.map((x) => x.id.split('@')[1]).join(' ')})`);
    if (!verbose) continue;
    if (r.crash) console.log(`    CRASH ${r.crash}`);
    else if (level === 'order') {
      const d = r.diff.order;
      console.log(`    first divergence at entry ${d.index}`);
      d.expected.forEach((e, i) => console.log(`    ${i === d.at ? '>' : ' '} exp ${e}`));
      d.actual.forEach((e, i) => console.log(`    ${i === d.at ? '>' : ' '} got ${e}`));
    } else console.log(`    ${JSON.stringify(r.diff[level])}`);
  }
  if (skipped.size) {
    console.log('\nskipped:');
    for (const [k, v] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  ${v}x ${k}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ results, skipped: [...skipped] }, null, 1));
}
