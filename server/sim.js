// Simulation controller shared by the MCP tools and the web viewer: owns the world,
// the real-time tick loop, design persistence, text rendering and probes.

import fs from 'node:fs';
import path from 'node:path';
import {
  World,
  pos,
  getBlock,
  hasBlock,
  makeState,
  parseBlockString,
  PistonMovingBlockEntity,
  dirByName,
  MIN_Y,
  MAX_Y,
} from '../engine/index.js';
import { cloneWorld, cloneDeep } from '../engine/clone.js';
import { allBlocks } from '../engine/state.js';
import { ItemStack, EMPTY, maxStackSize } from '../engine/items.js';
import { ContainerBlockEntity } from '../engine/blocks/containers.js';
import { readNbt, writeNbt, litematicToWorld, worldToLitematic } from '../engine/litematic.js';

const MAX_PROBES = 8;
const MAX_PENDING_SAMPLES = 600;

const ARROW = { north: '↑', south: '↓', east: '→', west: '←', up: 'U', down: 'D' };

// Rewind history: an exact copy of the world every SNAP_EVERY game ticks and before the first
// tick after an edit. Going back restores the latest copy at or before the target and runs the
// remaining ticks again (the engine is deterministic). Copies are kept within a memory budget.
const SNAP_EVERY = 32;
const HISTORY_BYTES = 256 * 1024 * 1024;
const MIN_SNAPSHOTS = 4;
const MAX_SNAPSHOTS = 512;

// Material list: the item a block state is built from (null = nothing to place), and stack sizes.
const ITEM_FOR = {
  air: null,
  piston_head: null,
  moving_piston: null,
  redstone_wire: 'redstone',
  redstone_wall_torch: 'redstone_torch',
  water: 'water_bucket',
  farmland: 'dirt',
  melon_stem: 'melon_seeds',
  attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
};

export class Simulation {
  /**
   * designsDir: where designs are saved. gzip / gunzip: (Uint8Array) => Uint8Array or a Promise
   * of one, for .litematic files (Node's zlib on the server, CompressionStream in the browser).
   */
  constructor({ designsDir, gzip = null, gunzip = null }) {
    this.designsDir = designsDir;
    this.gzip = gzip;
    this.gunzip = gunzip;
    this.listeners = new Set();
    this.tps = 20;
    this.running = true;
    this.designName = null; // the design the world was last loaded from / saved to
    this.trap = null; // chunk-border trap (see setTrap)
    this.paper = false; // Paper's piston move order (world.paper)
    this.history = []; // rewind snapshots, oldest first (see SNAP_EVERY)
    this._editSeq = 0; // bumped by every edit; a snapshot is due when it differs from _snapSeq
    this._snapSeq = -1;
    this.probes = []; // the viewer's signal graph: blocks sampled after every tick
    this._samples = []; // [time, values] not yet sent
    this.newWorld({ floor: 32 });
    this._last = performance.now();
    this._acc = 0;
    this._timer = setInterval(() => this._loop(), 10);
  }

  // ---------------------------------------------------------------- lifecycle

  newWorld({ floor = 0, floorBlock = 'smooth_stone', floorY = 0 } = {}) {
    this.world = new World();
    this.designName = null;
    if (floor > 0) {
      const st = getBlock(floorBlock).defaultState;
      for (let x = 0; x < floor; x++) for (let z = 0; z < floor; z++) this.world.setRaw(pos(x, floorY, z), st);
    }
    this.world.flushChanged();
    this._resetHistory();
    this.broadcast({ type: 'snapshot', ...this.snapshot() });
  }

  _loop() {
    const now = performance.now();
    const dt = now - this._last;
    this._last = now;
    if (!this.running) {
      this._acc = 0;
      return;
    }
    this._acc += (dt * this.tps) / 1000;
    let n = Math.floor(this._acc);
    if (n <= 0) return;
    this._acc -= n;
    const budget = performance.now() + 40; // never stall the event loop
    let ran = 0;
    while (n-- > 0 && performance.now() < budget) {
      this.tickOnce();
      ran++;
    }
    if (n > 0) this._acc = 0;
    if (ran) this.flush();
  }

  setRunning(running) {
    this.running = running;
    this._acc = 0;
    this.broadcast({ type: 'status', ...this.status() });
  }

  setTps(tps) {
    this.tps = Math.max(0.1, Math.min(10000, Number(tps)));
    this.broadcast({ type: 'status', ...this.status() });
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) this.tickOnce();
    this.flush();
  }

  /** One game tick, with the viewer's server-test options (Paper move order, chunk-border trap). */
  tickOnce() {
    if (this._editSeq !== this._snapSeq) this._takeSnapshot(true);
    const w = this.world;
    w.paper = this.paper;
    w.pistonEvent = this.trap ? this._trapHook : null;
    w.tick();
    const t = this.trap;
    if (t) {
      if (t.left > 0 && --t.left === 0) {
        for (const k of t.frozen) w.frozenChunks.delete(k);
        if (t.frozen.length && t.reload) w.reloadChunks(new Set(t.frozen));
        t.frozen = [];
        t.wait = t.cooldown;
      } else if (t.left === 0 && t.wait > 0) t.wait--;
    }
    if (w.time % SNAP_EVERY === 0) this._takeSnapshot(false);
    if (this.probes.length) {
      this._samples.push([w.time, this.probes.map((p) => this.probeValue(p))]);
      if (this._samples.length > MAX_PENDING_SAMPLES) this._samples.splice(0, this._samples.length - MAX_PENDING_SAMPLES);
    }
  }

  // ---------------------------------------------------------------- signal graph (viewer)

  /** A graph value 0..15: the block's power, else 15/0 for its on/off property (piston extended, lamp lit…). */
  probeValue({ x, y, z }) {
    const p = pos(x, y, z);
    const v = this.world.powerLevel(p);
    if (v !== null && v !== undefined) return v;
    const props = this.world.getBlockState(p).props ?? {};
    for (const k of ['extended', 'lit', 'open', 'powered', 'triggered', 'enabled'])
      if (k in props) return props[k] === true || props[k] === 'true' ? 15 : 0;
    return 0;
  }

  /** Adds or removes a block from the signal graph (at most MAX_PROBES). */
  toggleProbe(x, y, z) {
    const i = this.probes.findIndex((p) => p.x === x && p.y === y && p.z === z);
    if (i >= 0) this.probes.splice(i, 1);
    else if (this.probes.length < MAX_PROBES) this.probes.push({ x, y, z });
    else throw new Error(`at most ${MAX_PROBES} blocks in the graph`);
    this._samples = [];
    this.broadcast({ type: 'status', ...this.status() });
  }

  // ---------------------------------------------------------------- rewind

  /** Call after anything that changes the world outside a tick (the next tick snapshots first). */
  markEdited() {
    this._editSeq++;
  }

  _resetHistory() {
    this.probes = [];
    this._samples = [];
    this.history = [];
    this._editSeq++;
    this._takeSnapshot(false);
  }

  /** `edited`: taken after edits made at this game time (rewinding to this time undoes them). */
  _takeSnapshot(edited) {
    const w = this.world;
    const entry = { time: w.time, edited, world: cloneWorld(w), trap: cloneDeep(this.trap), paper: this.paper };
    const last = this.history[this.history.length - 1];
    if (last && last.time === w.time) this.history[this.history.length - 1] = entry;
    else this.history.push(entry);
    this._snapSeq = this._editSeq;
    // memory budget: blocks in the index's 16^3 sections cost 32 KB each, map entries ~100 B
    let sections = 0;
    for (const col of w.blocks._cols?.values() ?? []) for (const sec of col) if (sec) sections++;
    const bytes = sections * 32768 + w.blocks.size * 100 + w.blockEntities.size * 300 + 4096;
    const cap = Math.max(MIN_SNAPSHOTS, Math.min(MAX_SNAPSHOTS, Math.floor(HISTORY_BYTES / bytes)));
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
  }

  /** The oldest game time rewind can reach. */
  historyStart() {
    return this.history.length ? this.history[0].time : this.world.time;
  }

  /**
   * Goes back `ticks` game ticks (as far as the history reaches): restores the latest snapshot at
   * or before the target and runs forward to it. Edits made after that point are undone.
   */
  rewind(ticks) {
    const now = this.world.time;
    const target = Math.max(this.historyStart(), now - Math.max(0, Math.floor(ticks)));
    // the latest snapshot before the target, or at it if it holds no edits made at that time
    let i = this.history.length - 1;
    while (i > 0 && (this.history[i].time > target || (this.history[i].time === target && this.history[i].edited))) i--;
    const snap = this.history[i];
    if (!snap || snap.time > target) return { time: now, wanted: now - ticks, reached: now };
    this.history.length = i + 1;
    const old = this.world;
    this.world = cloneWorld(snap.world);
    this.trap = cloneDeep(snap.trap);
    this.paper = snap.paper;
    if (this.trap) this._trapHook = (ev) => this._trapEvent(ev);
    this._snapSeq = this._editSeq;
    while (this.world.time < target) this.tickOnce();
    // tell the viewer what differs from the world it shows
    const w = this.world;
    w.changed.clear();
    for (const [k, s] of w.blocks) if (old.blocks.get(k) !== s) w.changed.add(k);
    for (const k of old.blocks.keys()) if (!w.blocks.has(k)) w.changed.add(k);
    for (const k of w.blockEntities.keys()) w.changed.add(k);
    for (const k of old.blockEntities.keys()) w.changed.add(k);
    this._acc = 0;
    this.flush();
    return { time: this.world.time, wanted: now - ticks, reached: this.world.time };
  }

  // ---------------------------------------------------------------- material list

  /**
   * The items a build takes: one entry per item with its count, full stacks and shulker boxes
   * (27 stacks each). Moving blocks count as the block they carry. Optional box [from, to].
   */
  materials(from, to) {
    const w = this.world;
    const lo = from && to ? from.map((v, i) => Math.min(v, to[i])) : null;
    const hi = from && to ? from.map((v, i) => Math.max(v, to[i])) : null;
    const counts = new Map();
    const add = (state, n = 1) => {
      let id = state.id;
      let item = id in ITEM_FOR ? ITEM_FOR[id] : id;
      if (item && /_slab$/.test(id) && state.props.type === 'double') n *= 2;
      if (item && state.block.isDoor && state.props.half === 'upper') return; // one item per door
      if (item) counts.set(item, (counts.get(item) ?? 0) + n);
    };
    for (const [key, s] of w.blocks) {
      const [x, y, z] = key.split(',').map(Number);
      if (lo && (x < lo[0] || y < lo[1] || z < lo[2] || x > hi[0] || y > hi[1] || z > hi[2])) continue;
      if (s.id === 'moving_piston') {
        const be = w.blockEntities.get(key);
        if (be?.movedState && be.movedState.id !== 'piston_head') add(be.movedState);
      } else add(s);
    }
    return [...counts]
      .map(([item, count]) => {
        const stack = maxStackSize(item);
        return { item, count, stackSize: stack, stacks: Math.floor(count / stack), rest: count % stack, shulkers: +(count / stack / 27).toFixed(2) };
      })
      .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
  }

  // ---------------------------------------------------------------- chunk-border trap (viewer)

  /**
   * Makes a chunk border misbehave the way a server can: the first piston move that carries a block
   * across x = border (a multiple of 16) triggers it, then for `hold` gt either the chunks beyond the
   * border stop ticking (mode 'freeze', the player's simulation edge; optionally reloaded after) or
   * every move across the border is cancelled (mode 'cancel', a plugin cancelling Paper's piston
   * events). Then it rests `cooldown` gt and arms again.
   */
  setTrap({ border, mode = 'freeze', hold = 200, reload = false, cooldown = 200 }) {
    this.clearTrap();
    this.markEdited();
    this.trap = { border: Math.round(border / 16) * 16, mode, hold, reload, cooldown, fired: 0, left: 0, wait: 0, frozen: [] };
    this._trapHook = (ev) => this._trapEvent(ev);
    this.broadcast({ type: 'status', ...this.status() });
  }

  clearTrap() {
    const t = this.trap;
    if (t) for (const k of t.frozen) this.world.frozenChunks.delete(k);
    this.trap = null;
    this.world.pistonEvent = null;
    this.markEdited();
    this.broadcast({ type: 'status', ...this.status() });
  }

  setPaper(on) {
    this.paper = !!on;
    this.markEdited();
    this.broadcast({ type: 'status', ...this.status() });
  }

  _trapEvent({ facing, extending, toPush }) {
    const t = this.trap;
    const step = extending ? facing : facing.opposite;
    const crosses = step.x !== 0 && toPush.some((p) => (p.x < t.border) !== (p.x + step.x < t.border));
    if (t.left > 0) return !(t.mode === 'cancel' && crosses);
    if (t.wait > 0 || !crosses) return true;
    t.fired++;
    t.left = t.hold;
    if (t.mode === 'cancel') return false;
    // freeze every loaded chunk beyond the border, as seen from the moving machine
    const far = new Set();
    for (const key of this.world.blocks.keys()) {
      const [x, , z] = key.split(',').map(Number);
      if (step.x > 0 ? x >= t.border : x < t.border) far.add(World.chunkKey(x, z));
    }
    t.frozen = [...far].filter((k) => !this.world.frozenChunks.has(k));
    for (const k of t.frozen) this.world.frozenChunks.add(k);
    return true;
  }

  status() {
    return {
      time: this.world.time,
      historyStart: this.historyStart(),
      running: this.running,
      tps: this.tps,
      design: this.designName,
      frozen: [...this.world.frozenChunks],
      paper: this.paper,
      probes: this.probes.map((p) => [p.x, p.y, p.z]),
      trap: this.trap && { border: this.trap.border, mode: this.trap.mode, hold: this.trap.hold, reload: this.trap.reload, fired: this.trap.fired, left: this.trap.left },
    };
  }

  // ---------------------------------------------------------------- chunk tests (viewer)

  /** Vanilla-accurate save + reload of every chunk (see World.simulateRestart). */
  restart() {
    this.world.simulateRestart();
    this.markEdited();
    this.flush();
  }

  /** Freezes or thaws one chunk: a frozen chunk is loaded but gets no ticks, like the edge of a
   * player's simulation distance. */
  toggleChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (!this.world.frozenChunks.delete(key)) this.world.frozenChunks.add(key);
    this.markEdited();
    this.flush();
  }

  thawAll() {
    this.world.frozenChunks.clear();
    this.markEdited();
    this.flush();
  }

  // ---------------------------------------------------------------- viewer sync

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(msg) {
    if (!this.listeners.size) return;
    const text = JSON.stringify(msg);
    for (const fn of this.listeners) fn(text);
  }

  encodeBlock(p) {
    const s = this.world.getBlockState(p);
    if (s.block.isAir) return [p.x, p.y, p.z, null];
    const out = [p.x, p.y, p.z, s.id, s.props];
    const be = this.world.getBlockEntity(p);
    if (be instanceof PistonMovingBlockEntity) {
      out.push({
        moving: { id: be.movedState.id, props: be.movedState.props },
        dir: be.direction.name,
        extending: be.extending,
        progress: be.progress,
      });
    } else {
      const power = this.world.powerLevel(p);
      const extra = power === null ? {} : { power };
      if (be instanceof ContainerBlockEntity) extra.items = be.save().items;
      out.push(extra);
    }
    return out;
  }

  snapshot() {
    const blocks = [];
    for (const key of this.world.blocks.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      blocks.push(this.encodeBlock(pos(x, y, z)));
    }
    this.world.changed.clear();
    const colors = {};
    for (const b of allBlocks()) if (b.color !== undefined) colors[b.id] = b.color;
    // blocks a player can place (the viewer's palette); internal ones are left out
    const palette = allBlocks()
      .map((b) => b.id)
      .filter((id) => !/^(air|piston_head|moving_piston|redstone_wall_torch|attached_\w+)$/.test(id));
    return { ...this.status(), blocks, colors, palette };
  }

  /** Sends changed blocks (plus their neighbors, whose displayed power may have changed). */
  flush() {
    const changed = this.world.flushChanged();
    const samples = this._samples;
    this._samples = [];
    if (!this.listeners.size) return;
    const keys = new Map();
    for (const p of changed) {
      keys.set(p.key, p);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = p.offset(dx, dy, dz);
        if (this.world.blocks.has(q.key)) keys.set(q.key, q);
      }
    }
    const changes = [...keys.values()].map((p) => this.encodeBlock(p));
    this.broadcast({ type: 'update', ...this.status(), changes, ...(samples.length ? { samples } : {}) });
  }

  // ---------------------------------------------------------------- editing

  parseState(blockStr) {
    const { id, props } = parseBlockString(blockStr);
    if (!hasBlock(id)) throw new Error(`Unknown block "${id}". Use list_blocks to see supported blocks.`);
    return { id, props };
  }

  /** mode 'place' = like a player (survival checks, setPlacedBy); 'setblock' = like /setblock. */
  setBlock(x, y, z, blockStr, mode = 'place') {
    const p = pos(x, y, z);
    const { id, props } = this.parseState(blockStr);
    this.markEdited();
    if (id === 'air') {
      this.world.breakBlock(p);
      return this.world.getBlockState(p);
    }
    if (mode === 'setblock') {
      const block = getBlock(id);
      const st = block.getStateForPlacement(this.world, p, props);
      this.world.commandSetBlock(p, st);
    } else {
      this.world.placeBlock(p, id, props);
    }
    return this.world.getBlockState(p);
  }

  use(x, y, z) {
    const p = pos(x, y, z);
    const s = this.world.getBlockState(p);
    if (s.block.isAir) throw new Error(`No block at ${p}`);
    this.markEdited();
    const ok = this.world.useBlock(p);
    return { ok, state: this.world.getBlockState(p).key };
  }

  /** Replaces a container's items ([{slot, id, count}]) and wakes comparators like a player would. */
  setItems(x, y, z, items) {
    const p = pos(x, y, z);
    const be = this.world.getBlockEntity(p);
    if (!(be instanceof ContainerBlockEntity)) throw new Error(`no container at ${p}`);
    const n = be.getContainerSize();
    for (const it of items) {
      if (!Number.isInteger(it.slot) || it.slot < 0 || it.slot >= n) throw new Error(`slot ${it.slot} out of range 0..${n - 1}`);
      if (!/^[a-z0-9_]+$/.test(it.id ?? '')) throw new Error(`bad item id "${it.id}"`);
    }
    this.markEdited();
    be.items.fill(EMPTY);
    for (const it of items) {
      const st = ItemStack.of(it.id, Math.max(1, it.count ?? 1));
      st.limitSize(be.getMaxStackSizeFor(st));
      be.items[it.slot] = st;
    }
    be.setChanged();
    return { ok: true, items: be.save().items, signal: this.world.powerLevel(p) };
  }

  setSignal(x, y, z, value) {
    const p = pos(x, y, z);
    const s = this.world.getBlockState(p);
    if (typeof s.block.setSignal !== 'function') throw new Error(`${s.id} at ${p} has no adjustable comparator output (use a barrel)`);
    this.markEdited();
    s.block.setSignal(this.world, p, value);
    return { ok: true, signal: this.world.powerLevel(p) };
  }

  // ---------------------------------------------------------------- probes

  /**
   * Pauses real time and runs `ticks` game ticks deterministically. `actions` run between ticks
   * (`at` = number of ticks already run, like a player acting between server ticks).
   */
  runTicks(ticks, probes = [], actions = []) {
    const wasRunning = this.running;
    this.running = false;
    const start = this.world.time;
    const series = probes.map(() => []);
    const log = [];
    const sample = () =>
      probes.forEach((pr, i) => series[i].push(this.world.powerLevel(pos(pr.x, pr.y, pr.z))));
    const doActions = (t) => {
      for (const a of actions.filter((a) => (a.at ?? 0) === t)) {
        try {
          if (a.action === 'set_signal') this.setSignal(a.x, a.y, a.z, a.value);
          else if (a.action === 'set_items') this.setItems(a.x, a.y, a.z, a.items ?? []);
          else if (a.action === 'place') this.setBlock(a.x, a.y, a.z, a.block, a.mode);
          else if (a.action === 'break') this.setBlock(a.x, a.y, a.z, 'air');
          else this.use(a.x, a.y, a.z);
          log.push(`before tick +${t + 1}: ${a.action ?? 'use'} (${a.x},${a.y},${a.z}) ok`);
        } catch (e) {
          log.push(`before tick +${t + 1}: ${a.action ?? 'use'} (${a.x},${a.y},${a.z}) FAILED: ${e.message}`);
        }
      }
    };
    sample();
    for (let t = 0; t < ticks; t++) {
      doActions(t);
      this.tickOnce();
      sample();
    }
    this.flush();
    this.running = wasRunning;
    this.broadcast({ type: 'status', ...this.status() });
    return { start, end: this.world.time, series, log };
  }

  // ---------------------------------------------------------------- text rendering

  cell(p) {
    const s = this.world.getBlockState(p);
    const pr = s.props;
    const a = (d) => ARROW[d] ?? '?';
    const on = (b) => (b ? '+' : '-');
    switch (s.id) {
      case 'air': return ' . ';
      case 'redstone_wire': return `w${String(pr.power).padStart(2, '0')}`;
      case 'redstone_block': return '[R]';
      case 'redstone_torch': return `t${on(pr.lit)} `;
      case 'redstone_wall_torch': return `t${a(pr.facing)}${on(pr.lit)}`;
      case 'lever':
      case 'stone_button':
      case 'oak_button': {
        const c = s.id === 'lever' ? 'L' : 'b';
        const face = pr.face === 'wall' ? a(pr.facing) : pr.face === 'floor' ? 'f' : 'c';
        return `${c}${face}${on(pr.powered)}`;
      }
      case 'repeater': {
        const out = dirByName(pr.facing).opposite.name;
        return `${pr.powered ? 'R' : 'r'}${a(out)}${pr.locked ? 'x' : pr.delay}`;
      }
      case 'comparator': {
        const out = dirByName(pr.facing).opposite.name;
        return `${pr.powered ? 'C' : 'c'}${a(out)}${pr.mode === 'subtract' ? 's' : 'c'}`;
      }
      case 'redstone_lamp': return pr.lit ? 'O+ ' : 'o- ';
      case 'observer': return `v${a(pr.facing)}${on(pr.powered)}`;
      case 'piston':
      case 'sticky_piston': return `${s.id === 'piston' ? 'p' : 'P'}${a(pr.facing)}${pr.extended ? '+' : '-'}`;
      case 'piston_head': return `h${a(pr.facing)}=`;
      case 'moving_piston': return `m${a(pr.facing)}~`;
      case 'barrel': return `B${String(this.world.powerLevel(p)).padStart(2, '0')}`;
      case 'chest': return `c${String(this.world.powerLevel(p)).padStart(2, '0')}`;
      case 'hopper': return `H${a(pr.facing)}${pr.enabled ? '-' : 'x'}`;
      case 'dropper': return `j${a(pr.facing)}${on(pr.triggered)}`;
      case 'dispenser': return `J${a(pr.facing)}${on(pr.triggered)}`;
      case 'note_block': return `n${String(pr.note).padStart(2, '0')}`;
      case 'slime_block': return 'SSS';
      case 'honey_block': return 'HHH';
      case 'glass':
      case 'white_stained_glass': return 'ggg';
      case 'smooth_stone_slab':
      case 'stone_slab': return pr.type === 'top' ? 's‾ ' : pr.type === 'bottom' ? 's_ ' : '###';
      case 'obsidian': return 'XXX';
      case 'water': return '~~~';
      case 'sugar_cane': return ' | ';
      case 'dirt':
      case 'grass_block':
      case 'sand': return 'TTT';
      default: {
        if (s.block.isCopperBulb) return `U${pr.lit ? '*' : 'o'}${pr.powered ? '+' : '-'}`;
        if (s.id.endsWith('_trapdoor')) return `T${pr.half === 'top' ? '‾' : '_'}${pr.open ? 'o' : 'c'}`;
        if (s.block.isDoor) return `D${pr.half === 'upper' ? '‾' : '_'}${pr.open ? 'o' : 'c'}`;
        if (s.id.endsWith('shulker_box')) return `K${String(this.world.powerLevel(p)).padStart(2, '0')}`;
        const power = s.block.isConductor(s, this.world, p) ? this.world.getDirectSignalTo(p) : 0;
        return power > 0 ? `#${String(power).padStart(2, '0')}` : '###';
      }
    }
  }

  renderRegion(from, to) {
    const [x1, x2] = [Math.min(from[0], to[0]), Math.max(from[0], to[0])];
    const [y1, y2] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
    const [z1, z2] = [Math.min(from[2], to[2]), Math.max(from[2], to[2])];
    const cells = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
    if (cells > 40000) throw new Error(`Region too large (${cells} cells); view at most 40000 at once.`);
    const lines = [`time=${this.world.time} | region x ${x1}..${x2}, y ${y1}..${y2}, z ${z1}..${z2} | north is up (z grows downward), x grows rightward`];
    for (let y = y2; y >= y1; y--) {
      let any = false;
      const rows = [];
      for (let z = z1; z <= z2; z++) {
        let row = `${String(z).padStart(4)} `;
        for (let x = x1; x <= x2; x++) {
          const c = this.cell(pos(x, y, z));
          if (c !== ' . ') any = true;
          row += c;
        }
        rows.push(row);
      }
      if (!any) continue;
      let head = '   x ';
      for (let x = x1; x <= x2; x++) head += String(x).padStart(3);
      lines.push('', `y=${y}`, head, ...rows);
    }
    if (lines.length === 1) lines.push('(empty)');
    return lines.join('\n');
  }

  inspect(x, y, z) {
    const p = pos(x, y, z);
    const w = this.world;
    const s = w.getBlockState(p);
    const out = {
      pos: [x, y, z],
      state: s.key,
      power: w.powerLevel(p),
      conductor: s.block.isConductor(s, w, p),
      signalSource: s.block.isSignalSource(s),
      pendingTicks: w.pendingTicksAt(p),
      receivedSignal: {},
    };
    for (const d of ['down', 'up', 'north', 'south', 'west', 'east']) {
      const dir = dirByName(d);
      const sig = w.getSignal(p.rel(dir), dir);
      if (sig) out.receivedSignal[d] = sig;
    }
    out.strongPowerInto = w.getDirectSignalTo(p);
    const be = w.getBlockEntity(p);
    if (be) out.blockEntity = { type: be.type, ...(be.save ? be.save() : {}) };
    return out;
  }

  // ---------------------------------------------------------------- persistence

  serialize() {
    const w = this.world;
    const blocks = [];
    for (const [key, s] of w.blocks) blocks.push([...key.split(',').map(Number), s.key]);
    const blockEntities = [];
    for (const be of w.blockEntities.values()) {
      blockEntities.push({ pos: be.pos.toArray(), type: be.type, data: be.save ? be.save() : {} });
    }
    const ticks = [...w.pendingTicks.values()]
      .sort((a, b) => a.sub - b.sub)
      .map((t) => ({ pos: t.pos.toArray(), block: t.id, delay: t.trigger - w.time, priority: t.priority }));
    return { format: 'redstone-sim/1', time: w.time, blocks, blockEntities, ticks };
  }

  deserialize(data) {
    const w = new World();
    w.time = data.time ?? 0;
    const toState = (key) => {
      const { id, props } = parseBlockString(key);
      return makeState(getBlock(id), props);
    };
    for (const [x, y, z, key] of data.blocks) w.setRaw(pos(x, y, z), toState(key));
    for (const e of data.blockEntities ?? []) {
      const p = pos(...e.pos);
      const st = w.getBlockState(p);
      let be;
      if (e.type === 'moving_piston') {
        be = new PistonMovingBlockEntity(p, st, toState(e.data.movedState), dirByName(e.data.direction), e.data.extending, e.data.isSourcePiston);
        be.world = w;
        Object.assign(be, { progress: e.data.progress, progressO: e.data.progressO, lastTicked: e.data.lastTicked });
      } else {
        be = st.block.newBlockEntity?.(p, st);
        be?.load?.(e.data);
      }
      if (be) w.setBlockEntity(be);
    }
    for (const t of data.ticks ?? []) w.scheduleTick(pos(...t.pos), getBlock(t.block), t.delay, t.priority);
    w.flushChanged();
    this.world = w;
    this.designName = null;
    this._resetHistory();
    this.broadcast({ type: 'snapshot', ...this.snapshot() });
  }

  /**
   * Builds a world from a .mcfunction: /setblock and /fill run like the game runs them (place
   * with flag 2, then block updates); ~ coordinates are taken relative to (0, 0, 0). Other
   * commands are skipped and counted.
   */
  importMcfunction(text) {
    const w = new World();
    const coord = (c) => (c.startsWith('~') ? Number(c.slice(1) || 0) : Number(c));
    const state = (str) => {
      const { id, props } = this.parseState(str.replace(/^minecraft:/, ''));
      return makeState(getBlock(id), props);
    };
    let placed = 0;
    let skipped = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^\//, '');
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      if (parts[0] === 'setblock' && parts.length >= 5) {
        w.commandSetBlock(pos(coord(parts[1]), coord(parts[2]), coord(parts[3])), state(parts[4]));
        placed++;
      } else if (parts[0] === 'fill' && parts.length >= 8) {
        const [x1, y1, z1, x2, y2, z2] = parts.slice(1, 7).map(coord);
        const st = state(parts[7]);
        const ps = [];
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
          for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) ps.push(pos(x, y, z));
        if (ps.length > 500000) throw new Error(`fill too large: ${ps.length} blocks`);
        for (const p of ps) w.setBlock(p, st, 2);
        for (const p of ps) w.updateNeighborsAt(p, st.block);
        placed += ps.length;
      } else skipped++;
    }
    w.flushChanged();
    this.world = w;
    this.designName = null;
    this._resetHistory();
    this.broadcast({ type: 'snapshot', ...this.snapshot() });
    return { placed, skipped };
  }

  /** Opens a Litematica schematic (uncompressed NBT bytes): every region, container items, ticks. */
  importLitematic(bytes) {
    const { world, placed, skipped } = litematicToWorld(readNbt(bytes));
    this.world = world;
    this.designName = null;
    this._resetHistory();
    this.broadcast({ type: 'snapshot', ...this.snapshot() });
    const unsupported = [...skipped].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ×${n}`);
    return { placed, skipped: [...skipped.values()].reduce((a, b) => a + b, 0), unsupported };
  }

  /** The world as a one-region Litematica schematic (uncompressed NBT bytes). */
  exportLitematic(from, to) {
    return writeNbt(worldToLitematic(this.world, { name: this.designName ?? 'redstone-sim', from, to }));
  }

  // ---------------------------------------------------------------- viewer protocol

  /** One viewer message (the WebSocket protocol), then a flush. */
  handleMessage(m) {
    if (m.type === 'use') this.use(m.x, m.y, m.z);
    else if (m.type === 'place') this.setBlock(m.x, m.y, m.z, String(m.block), 'place');
    else if (m.type === 'break') this.setBlock(m.x, m.y, m.z, 'air');
    else if (m.type === 'probe') this.toggleProbe(m.x | 0, m.y | 0, m.z | 0);
    else if (m.type === 'probes_clear') {
      this.probes = [];
      this.broadcast({ type: 'status', ...this.status() });
    }
    else if (m.type === 'pause') this.setRunning(false);
    else if (m.type === 'resume') this.setRunning(true);
    else if (m.type === 'step') this.step(Math.max(1, Math.min(10000, m.n | 0 || 1)));
    else if (m.type === 'rewind') this.rewind(Math.max(1, Math.min(100000, m.n | 0 || 1)));
    else if (m.type === 'tps') this.setTps(m.tps);
    else if (m.type === 'restart') this.restart();
    else if (m.type === 'chunk') this.toggleChunk(m.cx | 0, m.cz | 0);
    else if (m.type === 'thaw') this.thawAll();
    else if (m.type === 'trap') this.setTrap(m);
    else if (m.type === 'untrap') this.clearTrap();
    else if (m.type === 'paper') this.setPaper(m.on);
    this.flush();
  }

  /**
   * The viewer's HTTP API ("GET /api/..." routes). Returns { json } or { file: { name, type, data } };
   * throws on errors (status 400) and returns null for unknown routes.
   */
  async handleApi(method, pathname, params, body) {
    const route = `${method} ${pathname}`;
    const file = (name, type, data) => ({ file: { name, type, data } });
    const base = this.designName ?? 'world';
    switch (route) {
      case 'GET /api/designs':
        return { json: this.listDesignFiles() };
      case 'POST /api/designs/load':
        this.load(body.name);
        return { json: { ok: true } };
      case 'POST /api/designs/save':
        this.save(body.name);
        return { json: { ok: true } };
      case 'POST /api/designs/delete':
        this.deleteDesign(body.name);
        return { json: { ok: true } };
      case 'GET /api/designs/file': {
        const name = params.get('name');
        return file(`${name}.json`, 'application/json', fs.readFileSync(this.designPath(name), 'utf8'));
      }
      case 'GET /api/world.json':
        return file(`${base}.json`, 'application/json', JSON.stringify(this.serialize()));
      case 'GET /api/world.mcfunction':
        return file(`${base}.mcfunction`, 'text/plain; charset=utf-8', this.exportMcfunction());
      case 'GET /api/world.litematic': {
        if (!this.gzip) throw new Error('no gzip available');
        return file(`${base}.litematic`, 'application/octet-stream', await this.gzip(this.exportLitematic()));
      }
      case 'GET /api/materials':
        return { json: this.materials() };
      case 'POST /api/new':
        this.newWorld({ floor: 32 });
        return { json: { ok: true } };
      case 'POST /api/import': {
        const { filename = '', text = '', data = null, save = false } = body;
        const name = filename.replace(/\.[^.]*$/, '').replace(/[^\w\-. ]/g, '_') || 'imported';
        let info = {};
        if (/\.litematic$/i.test(filename)) {
          if (!this.gunzip) throw new Error('no gunzip available');
          const raw = typeof data === 'string' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
          info = this.importLitematic(await this.gunzip(raw));
        } else if (/\.mcfunction$/i.test(filename)) info = this.importMcfunction(text);
        else {
          const json = JSON.parse(text);
          if (json.format !== 'redstone-sim/1') throw new Error('not a redstone-sim design file');
          this.deserialize(json);
        }
        if (save) this.save(name);
        return { json: { ok: true, name: save ? name : null, ...info } };
      }
      default:
        return null;
    }
  }

  designPath(name) {
    if (!/^[\w\-. ]+$/.test(name)) throw new Error('Design names may only contain letters, digits, space, _ - .');
    return path.join(this.designsDir, `${name}.json`);
  }

  save(name) {
    fs.mkdirSync(this.designsDir, { recursive: true });
    const file = this.designPath(name);
    fs.writeFileSync(file, JSON.stringify(this.serialize()));
    this.designName = name;
    this.broadcast({ type: 'status', ...this.status() });
    return file;
  }

  load(name) {
    this.deserialize(JSON.parse(fs.readFileSync(this.designPath(name), 'utf8')));
    this.designName = name;
    this.broadcast({ type: 'status', ...this.status() });
  }

  listDesigns() {
    return this.listDesignFiles().map((d) => d.name);
  }

  /** Saved designs (only files in the redstone-sim format), newest first. */
  listDesignFiles() {
    if (!fs.existsSync(this.designsDir)) return [];
    return fs
      .readdirSync(this.designsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = path.join(this.designsDir, f);
        const st = fs.statSync(file);
        let blocks = null;
        try {
          const head = fs.readFileSync(file, 'utf8');
          const data = JSON.parse(head);
          if (data.format !== 'redstone-sim/1') return null;
          blocks = data.blocks.length;
        } catch {
          return null;
        }
        return { name: f.slice(0, -5), bytes: st.size, modified: st.mtimeMs, blocks };
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified);
  }

  deleteDesign(name) {
    fs.unlinkSync(this.designPath(name));
    if (this.designName === name) this.designName = null;
    this.broadcast({ type: 'status', ...this.status() });
  }

  /** /setblock commands for real Minecraft, relative to `origin`. */
  exportMcfunction(origin = [0, 0, 0]) {
    const lines = [];
    const solids = [];
    const rest = [];
    for (const [key, s] of this.world.blocks) {
      if (s.id === 'moving_piston' || s.id === 'piston_head') continue;
      const [x, y, z] = key.split(',').map(Number);
      const st = s.id === 'piston' || s.id === 'sticky_piston' ? s.key.replace('extended=true', 'extended=false') : s.key;
      (s.block.isConductor(s, this.world, pos(x, y, z)) || s.block.faceSturdy(s, dirByName('up')) ? solids : rest).push(
        `setblock ~${x - origin[0]} ~${y - origin[1]} ~${z - origin[2]} minecraft:${st}`,
      );
    }
    lines.push('# generated by redstone-sim: supporting blocks first, then components', ...solids, ...rest);
    return lines.join('\n');
  }
}

export function blockCatalog() {
  return [
    'Building blocks (conductive unless noted): stone, smooth_stone, cobblestone, *_concrete (white, gray, black, red, orange, yellow, lime, green, cyan, light_blue, blue, purple, magenta, pink, brown), *_wool (16 colours),',
    '  quartz_block, chiseled_quartz_block, smooth_quartz, quartz_bricks, iron/gold/emerald/diamond_block, oak/spruce/birch/dark_oak_planks, oak/spruce/birch/dark_oak_log, oak_wood [axis],',
    '  target[power=0..15] (conductive; emits its stored power), obsidian (immovable), bedrock (immovable), glass / white_stained_glass (NOT conductive),',
    '  smooth_stone_slab / stone_slab [type=bottom|top|double] (not conductive),',
    '  slime_block (sticky, conductive), honey_block (sticky, not conductive; does not stick to slime).',
    'redstone_wire                 dust; connections are computed automatically; use = toggle dot/cross',
    'redstone_torch                standing torch on top of a block',
    'redstone_wall_torch[facing=D] torch on a wall; facing = direction it points AWAY from the wall it hangs on',
    'redstone_block                power source, not conductive, pushable',
    'lever[face=floor|wall|ceiling,facing=D]         wall: facing points away from the wall; use = toggle',
    'stone_button / oak_button (same props as lever)  use = press (stone 20 gt, oak 30 gt)',
    'repeater[out=D,delay=1..4]    out = direction the signal LEAVES. Vanilla `facing` = the INPUT side (opposite of out). use = cycle delay',
    'comparator[out=D,mode=compare|subtract]         same facing rule as repeater; use = toggle mode',
    'redstone_lamp                 on instantly, off after 4 gt',
    'observer[facing=D]            facing = the side it WATCHES; it outputs from the opposite face. Alias: out=D',
    'piston[facing=D] / sticky_piston[facing=D]      facing = push direction; quasi-connectivity, 12 block limit',
    'chest[facing,type=single|left|right], barrel, hopper[facing=down|north|..,enabled], dropper / dispenser[facing,triggered], shulker_box (+ 16 colours)',
    '                              real containers: put items in with interact action=set_items; hoppers and droppers move them like vanilla',
    '                              (cooldowns, slot order, double chests); comparators read them. Item entities are not simulated: a dropper or',
    '                              dispenser facing a non-container removes the item. A barrel output can also be forced with action=set_signal.',
    'note_block[instrument,note=0..24]  plays on a rising edge (block event); use = tune; instrument comes from the block below',
    '<wood>_door / iron_door[facing,half=lower|upper,hinge,open,powered]  two blocks; place the lower half, the upper follows; use = toggle (not iron)',
    'copper_bulb (+ exposed_/weathered_/oxidized_, waxed_*)[lit,powered]  toggles lit on each rising edge, no delay; not conductive; comparator reads 15 when lit; observers see both edges',
    '<wood>_trapdoor / iron_trapdoor[facing,half=bottom|top,open,powered]  opens while powered, no delay; use = toggle (not iron); view: "T_c" bottom closed, "T‾o" top open',
    'dirt, grass_block, sand (soil), water[level=0] (static source: flow NOT simulated), sugar_cane (needs soil with water beside it, pops 1 gt after losing support, breaks when pushed)',
    'Directions D: north (-z), south (+z), west (-x), east (+x), up, down.',
  ].join('\n');
}

export { MIN_Y, MAX_Y };
