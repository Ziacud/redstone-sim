// The simulated level. Ports the parts of Level / ServerLevel / LevelChunk / LevelTicks that
// matter for redstone: setBlock flags, block & shape updates, scheduled ticks with priorities,
// block events (pistons) and ticking block entities (moving pistons), in vanilla phase order.

import { ALL, UPDATE_SHAPE_ORDER, HORIZONTAL, DOWN, Pos, posFromKey } from './dir.js';
import { CollectingNeighborUpdater } from './updater.js';
import { JavaPosMap } from './javahash.js';
import { getBlock } from './state.js';
import { BaseBlock } from './blocks/base.js';

const BASE_GET_DIRECT_SIGNAL = BaseBlock.getDirectSignal;

export const MIN_Y = -64;
export const MAX_Y = 320; // exclusive (max build height)

// Block.UPDATE_* flags
/** Seeded random (mulberry32) with Java Random-like helpers. */
// An object (not a closure) so World snapshots (engine/clone.js) can copy its state.
class SeededRandom {
  constructor(seed) {
    this.a = seed >>> 0;
  }
  nextFloat() {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(n) {
    return Math.floor(this.nextFloat() * n);
  }
  nextDouble() {
    return this.nextFloat();
  }
}

export function seededRandom(seed) {
  return new SeededRandom(seed);
}

export const F = {
  NEIGHBORS: 1,
  CLIENTS: 2,
  INVISIBLE: 4,
  IMMEDIATE: 8,
  KNOWN_SHAPE: 16,
  SUPPRESS_DROPS: 32,
  MOVE_BY_PISTON: 64,
  SKIP_BLOCK_ENTITY_SIDEEFFECTS: 256,
  SKIP_ON_PLACE: 1024,
  ALL: 3,
};

// TickPriority values (lower runs first)
export const PRIORITY = {
  EXTREMELY_HIGH: -3,
  VERY_HIGH: -2,
  HIGH: -1,
  NORMAL: 0,
  LOW: 1,
  VERY_LOW: 2,
  EXTREMELY_LOW: 3,
};

// Block storage: a Map "x,y,z" -> state (the public view: iteration order, get/has/size), plus an
// index of the same entries in 16^3 chunk sections for fast lookups by coordinates. Coordinates
// the index cannot hold (non-integers, outside the build height, |x|,|z| >= 2^18) are only in the
// Map. Every write path (set/delete/clear and the internal setAt/deleteAt) keeps both in sync.
const SECTIONS = (MAX_Y - MIN_Y) >> 4;
const GRID_OFF = 16384; // chunk coordinate offset: 0 <= cx + GRID_OFF < 32768

class BlockMap extends Map {
  constructor() {
    super();
    this._cols = new Map(); // (cx + GRID_OFF) * 32768 + (cz + GRID_OFF) -> sections (null = empty)
  }

  /** Column key for an indexable coordinate, or -1. */
  static _colKey(x, y, z) {
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z || y < MIN_Y || y >= MAX_Y) return -1;
    const cx = (x >> 4) + GRID_OFF;
    const cz = (z >> 4) + GRID_OFF;
    if (cx < 0 || cx >= 32768 || cz < 0 || cz >= 32768) return -1;
    return cx * 32768 + cz;
  }

  _index(x, y, z, value) {
    const ck = BlockMap._colKey(x, y, z);
    if (ck < 0) return;
    let col = this._cols.get(ck);
    if (col === undefined) {
      if (value === null) return;
      col = new Array(SECTIONS).fill(null);
      this._cols.set(ck, col);
    }
    const si = (y - MIN_Y) >> 4;
    let sec = col[si];
    if (sec === null) {
      if (value === null) return;
      sec = col[si] = new Array(4096).fill(null);
    }
    sec[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = value;
  }

  /** Coordinates of a canonical "x,y,z" key, or null. */
  static _parse(key) {
    if (typeof key !== 'string') return null;
    const parts = key.split(',');
    if (parts.length !== 3) return null;
    const [x, y, z] = parts.map(Number);
    return `${x},${y},${z}` === key ? [x, y, z] : null;
  }

  /** Same result as get(pos.key). */
  getAt(pos) {
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    if ((x | 0) === x && (y | 0) === y && (z | 0) === z && y >= MIN_Y && y < MAX_Y) {
      const cx = (x >> 4) + GRID_OFF;
      const cz = (z >> 4) + GRID_OFF;
      if (cx >= 0 && cx < 32768 && cz >= 0 && cz < 32768) {
        const col = this._cols.get(cx * 32768 + cz);
        if (col === undefined) return undefined;
        const sec = col[(y - MIN_Y) >> 4];
        if (sec === null) return undefined;
        const v = sec[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
        return v === null ? undefined : v;
      }
    }
    return super.get(pos.key);
  }

  /** set(pos.key, value); `key` may be passed when the caller already built pos.key. */
  /** Same result as get(`${x},${y},${z}`) (= get(pos(x, y, z).key)). */
  getXYZ(x, y, z) {
    if ((x | 0) === x && (y | 0) === y && (z | 0) === z && y >= MIN_Y && y < MAX_Y) {
      const cx = (x >> 4) + GRID_OFF;
      const cz = (z >> 4) + GRID_OFF;
      if (cx >= 0 && cx < 32768 && cz >= 0 && cz < 32768) {
        const col = this._cols.get(cx * 32768 + cz);
        if (col === undefined) return undefined;
        const sec = col[(y - MIN_Y) >> 4];
        if (sec === null) return undefined;
        const v = sec[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
        return v === null ? undefined : v;
      }
    }
    return super.get(`${x},${y},${z}`);
  }

  setAt(pos, value, key = pos.key) {
    super.set(key, value);
    this._indexKey(pos, key, value === null ? undefined : value);
  }

  deleteAt(pos, key = pos.key) {
    if (super.delete(key)) this._indexKey(pos, key, null);
  }

  /** Indexes `key` (= pos.key): from pos's numbers, or, if pos has odd coordinates (strings,
   * ...), from the key itself when that is a canonical in-range key. */
  _indexKey(pos, key, value) {
    if (BlockMap._colKey(pos.x, pos.y, pos.z) >= 0) {
      this._index(pos.x, pos.y, pos.z, value);
    } else {
      const p = BlockMap._parse(key);
      if (p) this._index(p[0], p[1], p[2], value);
    }
  }

  set(key, value) {
    super.set(key, value);
    const p = BlockMap._parse(key);
    if (p) this._index(p[0], p[1], p[2], value === null ? undefined : value);
    return this;
  }

  delete(key) {
    const had = super.delete(key);
    if (had) {
      const p = BlockMap._parse(key);
      if (p) this._index(p[0], p[1], p[2], null);
    }
    return had;
  }

  clear() {
    super.clear();
    this._cols.clear();
  }
}

export class World {
  constructor() {
    this.blocks = new BlockMap(); // key "x,y,z" -> state (air is absent)
    this.blockEntities = new Map(); // key -> block entity
    this.time = 0; // game time
    this.updater = new CollectingNeighborUpdater(this);

    // LevelTicks
    this.pendingTicks = new Map(); // "pos|block" -> tick
    this.toRunThisTick = [];
    this.toRunThisTickSet = new Set();
    this.subTickCount = 0;

    // Block events (ObjectLinkedOpenHashSet: insertion ordered, deduplicated)
    this.blockEvents = new Map();

    // Block entity tickers (RebindableTickingBlockEntityWrapper per position)
    this.tickers = [];
    this.pendingTickers = [];
    this.tickersByPos = new Map();
    this.tickingBlockEntities = false;
    // Game event listeners (vibration listeners of sculk sensors), in registration order
    this.vibrationListeners = new Set();

    this.handlingTick = false;
    this.wireShouldSignal = true; // RedStoneWireBlock.shouldSignal (static in vanilla)
    this.torchToggles = []; // RedstoneTorchBlock.RECENT_TOGGLES
    this.changed = new Set(); // keys changed since last flush (for the viewer)
    this.air = getBlock('air').defaultState;
    // Optional event recorder ({ phase, entries }) used by the conformance suite.
    this.rec = null;
    // Chunks ("cx,cz") that are loaded but not block-ticking (lazy), or unloaded.
    this.frozenChunks = new Set();
    // Chunks that tick but whose entities are still loading: vanilla runs block events and block
    // entities there, but scheduled block ticks wait (LevelTicks checks
    // isPositionTickingWithEntitiesLoaded). Happens for a few ticks after a chunk loads.
    this.entitiesLoading = new Set();
    // Random ticks (ServerLevel.tickChunk): off unless randomTickSpeed > 0 (the game rule; 3 in
    // vanilla and Paper). Sections that ever held a randomly ticking block ("sx,sy,sz"), the
    // position LCG of Level.getBlockRandomPos, and a seeded random for the blocks' own rolls.
    this.randomTickSpeed = 0;
    this.randomTickSections = new Set();
    this.randValue = 0x2545f491;
    this.random = seededRandom(0x6d2b79f5);
    // the simulator has no light engine: raw brightness assumed everywhere (open sky = 15)
    this.assumedBrightness = 15;
  }

  /** Level.getBlockRandomPos: an LCG over the 16^3 section at (x, y, z). */
  getBlockRandomPos(x, y, z) {
    this.randValue = (Math.imul(this.randValue, 3) + 1013904223) | 0;
    const i = this.randValue >> 2;
    return new Pos(x + (i & 15), y + ((i >> 16) & 15), z + ((i >> 8) & 15));
  }

  _runRandomTicks() {
    for (const key of this.randomTickSections) {
      const [sx, sy, sz] = key.split(',').map(Number);
      if (this.frozenChunks.size && this.frozenChunks.has(`${sx},${sz}`)) continue;
      for (let n = 0; n < this.randomTickSpeed; n++) {
        const p = this.getBlockRandomPos(sx * 16, sy * 16, sz * 16);
        const s = this.getBlockState(p);
        if (s.block.randomTick) s.block.randomTick(this, p, s);
      }
    }
  }

  // ---------------------------------------------------------------- chunk ticking / restarts

  static chunkKey(x, z) {
    return `${x >> 4},${z >> 4}`;
  }

  /** ServerLevel.shouldTickBlocksAt */
  shouldTickBlocksAt(pos) {
    return this.frozenChunks.size === 0 || !this.frozenChunks.has(World.chunkKey(pos.x, pos.z));
  }

  /**
   * What a save + reload (server restart, or chunks unloading and loading again) loses:
   * queued block events and the torch burnout memory are not saved. Scheduled ticks and
   * block entities (moving pistons) are, and come back in chunk order.
   */
  simulateRestart() {
    this.reloadChunks(null);
  }

  /**
   * Unload + load of some chunks ("cx,cz" keys; null = all, a restart): the same losses, limited to
   * those chunks. Their block entity tickers re-register after everything else (load order).
   */
  reloadChunks(chunks) {
    const hit = (pos) => !chunks || chunks.has(World.chunkKey(pos.x, pos.z));
    if (!chunks) this.blockEvents.clear();
    else for (const [key, ev] of [...this.blockEvents]) if (hit(ev.pos)) this.blockEvents.delete(key);
    if (!chunks) this.torchToggles = [];
    // Block entities are saved and loaded through a HashMap<BlockPos, BlockEntity> per chunk, so
    // after a reload their tickers run in Java hash order of their positions, chunk by chunk.
    const byChunk = new Map();
    const kept = [];
    for (const w of this.tickers) {
      if (!w.be || w.be.removed) continue;
      if (!hit(w.pos)) {
        kept.push(w);
        continue;
      }
      const ck = World.chunkKey(w.pos.x, w.pos.z);
      if (!byChunk.has(ck)) byChunk.set(ck, new JavaPosMap());
      byChunk.get(ck).set(w.pos, w);
    }
    const loaded = [...byChunk.keys()].sort().flatMap((ck) => [...byChunk.get(ck).entries()].map(([, w]) => w));
    this.tickers = [...kept, ...loaded];
    // PistonMovingBlockEntity saves progressO as "progress"; on load both are that value and
    // lastTicked = 0, so a moving block is half a step behind after a reload.
    for (const w of loaded) {
      if (w.be.type === 'moving_piston') {
        w.be.progress = w.be.progressO;
        w.be.lastTicked = 0;
      }
    }
    // Saved scheduled ticks run one tick earlier after a reload than their delay says. Both effects
    // measured on a real 26.1.2 server: after a save + reload, stepping it and this simulator in
    // lockstep from the same save files matched for 300 ticks only with both.
    const ticks = [...this.pendingTicks.values()].filter((t) => hit(t.pos)).sort((a, b) => a.sub - b.sub);
    for (const t of ticks) {
      t.trigger -= 1;
      t.sub = this.subTickCount++;
    }
  }

  record(kind, pos, state, detail) {
    const e = { tick: this.rec.tick, phase: this.rec.phase, kind, pos: [pos.x, pos.y, pos.z] };
    if (state !== undefined) e.state = state;
    if (detail !== undefined) e.detail = detail;
    this.rec.entries.push(e);
  }

  // ---------------------------------------------------------------- block access

  getBlockState(pos) {
    return this.blocks.getAt(pos) ?? this.air;
  }

  isOutsideBuildHeight(pos) {
    return pos.y < MIN_Y || pos.y >= MAX_Y;
  }

  /** Writes a state with no side effects at all (used when loading saved designs). */
  setRaw(pos, state) {
    const key = pos.key;
    if (state.block.isAir) this.blocks.deleteAt(pos, key);
    else this.blocks.setAt(pos, state, key);
    if (state.block.randomTick) this.randomTickSections.add(`${pos.x >> 4},${pos.y >> 4},${pos.z >> 4}`);
    this.changed.add(key);
  }

  /**
   * LevelChunk.setBlockState (1.21.5+): stores the state; when the block type changes, removes the
   * old block entity (after its pre-remove side effects) and runs affectNeighborsAfterRemoval;
   * then onPlace. Returns the old state, or null when nothing changed.
   */
  chunkSetBlockState(pos, state, flags) {
    const old = this.getBlockState(pos);
    if (old === state) return null;
    const isMoving = (flags & F.MOVE_BY_PISTON) !== 0;
    this.setRaw(pos, state);
    if (this.rec) this.record('set', pos, state.key);
    const blockChanged = old.id !== state.id;
    if (blockChanged && old.block.hasBlockEntity(old)) {
      const be = this.blockEntities.get(pos.key);
      if (be && (flags & F.SKIP_BLOCK_ENTITY_SIDEEFFECTS) === 0) be.preRemoveSideEffects?.(this, pos, old);
      this.removeBlockEntity(pos);
    }
    if (blockChanged && ((flags & F.NEIGHBORS) !== 0 || isMoving)) {
      old.block.affectNeighborsAfterRemoval(this, pos, old, isMoving);
    }
    if (this.getBlockState(pos).id !== state.id) return null;
    if ((flags & F.SKIP_ON_PLACE) === 0) state.block.onPlace(this, pos, state, old, isMoving);
    if (state.block.hasBlockEntity(state)) {
      const be = this.blockEntities.get(pos.key);
      if (!be) {
        const created = state.block.newBlockEntity?.(pos, state);
        if (created) this.addAndRegisterBlockEntity(created);
      } else {
        be.state = state;
        this.updateBlockEntityTicker(be);
      }
    }
    return old;
  }

  /** Level.setBlock(pos, state, flags, recursionLeft) */
  setBlock(pos, state, flags = F.ALL, recursionLeft = 512) {
    if (this.isOutsideBuildHeight(pos)) return false;
    const old = this.chunkSetBlockState(pos, state, flags);
    if (old === null) return false;
    const now = this.getBlockState(pos);
    if (now === state) {
      if (flags & F.NEIGHBORS) {
        this.updateNeighborsAt(pos, old.block);
        if (state.block.hasAnalogOutput(state)) this.updateNeighbourForOutputSignal(pos, state.block);
      }
      if ((flags & F.KNOWN_SHAPE) === 0 && recursionLeft > 0) {
        const f = flags & ~(F.NEIGHBORS | F.SUPPRESS_DROPS);
        old.block.updateIndirectNeighbourShapes(this, pos, old, f, recursionLeft - 1);
        this.updateNeighbourShapes(pos, state, f, recursionLeft - 1);
        state.block.updateIndirectNeighbourShapes(this, pos, state, f, recursionLeft - 1);
      }
    }
    return true;
  }

  removeBlock(pos, isMoving) {
    return this.setBlock(pos, this.air, F.ALL | (isMoving ? F.MOVE_BY_PISTON : 0));
  }

  destroyBlock(pos, drop = true, recursionLeft = 512) {
    const st = this.getBlockState(pos);
    if (st.block.isAir) return false;
    const destroyed = this.setBlock(pos, this.air, F.ALL, recursionLeft);
    if (destroyed) this.gameEvent('block_destroy', pos, st);
    return destroyed;
  }

  /**
   * Level.gameEvent at the centre of `pos` (GameEventDispatcher.post). `affected` is the context's
   * affected block state (wool dampens). Listeners only queue a candidate, so their order does not
   * matter.
   */
  gameEvent(event, pos, affected = null) {
    if (this.vibrationListeners.size === 0) return;
    for (const be of this.vibrationListeners) be.handleGameEvent(this, event, pos, affected);
  }

  /** Block.updateOrDestroy */
  updateOrDestroy(oldState, newState, pos, flags, recursionLeft = 512) {
    if (newState !== oldState) {
      if (newState.block.isAir) this.destroyBlock(pos, (flags & F.SUPPRESS_DROPS) === 0, recursionLeft);
      else this.setBlock(pos, newState, flags & ~F.SUPPRESS_DROPS, recursionLeft);
    }
  }

  /** Block.updateFromNeighbourShapes */
  updateFromNeighbourShapes(state, pos) {
    let s = state;
    for (const d of UPDATE_SHAPE_ORDER) {
      const np = pos.rel(d);
      if (this.rec) this.record('shape', pos);
      s = s.block.updateShape(this, pos, s, d, this.getBlockState(np), np);
    }
    return s;
  }

  // ---------------------------------------------------------------- updates

  updateNeighborsAt(pos, block) {
    this.updater.updateNeighborsAtExceptFromFacing(pos, block, null);
  }

  updateNeighborsAtExceptFromFacing(pos, block, skip) {
    this.updater.updateNeighborsAtExceptFromFacing(pos, block, skip);
  }

  neighborChanged(pos, block, fromPos) {
    this.updater.neighborChanged(pos, block, fromPos);
  }

  neighborChangedWithState(state, pos, block, fromPos, isMoving) {
    this.updater.neighborChangedFull(state, pos, block, fromPos, isMoving);
  }

  /** BlockState.updateNeighbourShapes */
  updateNeighbourShapes(pos, state, flags, recursionLeft = 512) {
    for (const d of UPDATE_SHAPE_ORDER) {
      this.updater.shapeUpdate(d.opposite, state, pos.rel(d), pos, flags, recursionLeft);
    }
  }

  neighborShapeChanged(direction, state, pos, neighborPos, flags, recursionLeft) {
    this.updater.shapeUpdate(direction, state, pos, neighborPos, flags, recursionLeft);
  }

  /** Level.updateNeighbourForOutputSignal: tells comparators that a container's contents changed. */
  updateNeighbourForOutputSignal(pos, block) {
    for (const d of HORIZONTAL) {
      let bp = pos.rel(d);
      let bs = this.getBlockState(bp);
      if (bs.id === 'comparator') {
        this.neighborChangedWithState(bs, bp, block, pos, false);
      } else if (bs.block.isConductor(bs, this, bp)) {
        bp = bp.rel(d);
        bs = this.getBlockState(bp);
        if (bs.id === 'comparator') this.neighborChangedWithState(bs, bp, block, pos, false);
      }
    }
  }

  // ---------------------------------------------------------------- signals (SignalGetter)

  getDirectSignal(pos, dir) {
    const s = this.getBlockState(pos);
    return s.block.getDirectSignal(this, pos, s, dir);
  }

  getDirectSignalTo(pos) {
    let i = 0;
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    for (const d of ALL) {
      // Same as i = max(i, getDirectSignal(pos.rel(d), d)), but blocks that keep the default
      // getDirectSignal (always 0, no side effects) are skipped without building their Pos.
      const s = this.blocks.getXYZ(x + d.x, y + d.y, z + d.z) ?? this.air;
      if (s.block.getDirectSignal === BASE_GET_DIRECT_SIGNAL) continue;
      i = Math.max(i, s.block.getDirectSignal(this, pos.rel(d), s, d));
      if (i >= 15) return i;
    }
    return i;
  }

  getSignal(pos, dir) {
    const s = this.getBlockState(pos);
    const i = s.block.getSignal(this, pos, s, dir);
    return s.block.isConductor(s, this, pos) ? Math.max(i, this.getDirectSignalTo(pos)) : i;
  }

  hasSignal(pos, dir) {
    return this.getSignal(pos, dir) > 0;
  }

  // In the two loops below, air neighbours are skipped without building their Pos: air's
  // getSignal is the default (0) and it is not a conductor, so getSignal(air) is always 0.

  hasNeighborSignal(pos) {
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    for (const d of ALL) {
      if ((this.blocks.getXYZ(x + d.x, y + d.y, z + d.z) ?? this.air) === this.air) continue;
      if (this.getSignal(pos.rel(d), d) > 0) return true;
    }
    return false;
  }

  getBestNeighborSignal(pos) {
    let i = 0;
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    for (const d of ALL) {
      if ((this.blocks.getXYZ(x + d.x, y + d.y, z + d.z) ?? this.air) === this.air) continue;
      const j = this.getSignal(pos.rel(d), d);
      if (j >= 15) return 15;
      if (j > i) i = j;
    }
    return i;
  }

  getControlInputSignal(pos, dir, diodesOnly) {
    const s = this.getBlockState(pos);
    if (diodesOnly) return s.block.isDiode ? this.getDirectSignal(pos, dir) : 0;
    if (s.id === 'redstone_block') return 15;
    if (s.id === 'redstone_wire') return s.props.power;
    return s.block.isSignalSource(s) ? this.getDirectSignal(pos, dir) : 0;
  }

  // ---------------------------------------------------------------- scheduled ticks (LevelTicks)

  _tickKey(pos, id) {
    return `${pos.key}|${id}`;
  }

  scheduleTick(pos, block, delay, priority = PRIORITY.NORMAL) {
    if (this.rec) this.record('schedule', pos, undefined, `delay=${delay},priority=${priority}`);
    const key = this._tickKey(pos, block.id);
    if (this.pendingTicks.has(key)) return;
    this.pendingTicks.set(key, {
      pos,
      id: block.id,
      trigger: this.time + delay,
      priority,
      sub: this.subTickCount++,
      key,
    });
  }

  hasScheduledTick(pos, block) {
    return this.pendingTicks.has(this._tickKey(pos, block.id));
  }

  willTickThisTick(pos, block) {
    return this.toRunThisTickSet.has(this._tickKey(pos, block.id));
  }

  _runScheduledTicks() {
    const due = [];
    for (const t of this.pendingTicks.values()) {
      if (t.trigger <= this.time && this.shouldTickBlocksAt(t.pos) && !(this.entitiesLoading.size && this.entitiesLoading.has(World.chunkKey(t.pos.x, t.pos.z))))
        due.push(t);
    }
    for (const t of due) this.pendingTicks.delete(t.key);
    due.sort((a, b) => a.trigger - b.trigger || a.priority - b.priority || a.sub - b.sub);
    this.toRunThisTick = due;
    this.toRunThisTickSet = new Set(due.map((t) => t.key));
    while (this.toRunThisTick.length) {
      const t = this.toRunThisTick.shift();
      this.toRunThisTickSet.delete(t.key);
      if (this.rec) this.record('tick', t.pos);
      const s = this.getBlockState(t.pos);
      if (s.id === t.id) s.block.tick(this, t.pos, s);
    }
    this.toRunThisTickSet.clear();
  }

  // ---------------------------------------------------------------- block events

  blockEvent(pos, block, a, b) {
    const key = `${pos.key}|${block.id}|${a}|${b}`;
    if (this.rec) this.record('block_event_queued', pos);
    if (!this.blockEvents.has(key)) this.blockEvents.set(key, { pos, id: block.id, a, b });
  }

  _runBlockEvents() {
    const reschedule = [];
    while (this.blockEvents.size) {
      const [key, ev] = this.blockEvents.entries().next().value;
      this.blockEvents.delete(key);
      if (!this.shouldTickBlocksAt(ev.pos)) {
        reschedule.push([key, ev]);
        continue;
      }
      if (this.rec) this.record('block_event', ev.pos, undefined, `${ev.a},${ev.b}`);
      const s = this.getBlockState(ev.pos);
      if (s.id === ev.id) s.block.triggerEvent(this, ev.pos, s, ev.a, ev.b);
    }
    // events in non-ticking chunks wait in memory (and are lost on a restart)
    for (const [key, ev] of reschedule) this.blockEvents.set(key, ev);
  }

  // ---------------------------------------------------------------- block entities

  getBlockEntity(pos) {
    return this.blockEntities.get(pos.key) ?? null;
  }

  /** LevelChunk.setBlockEntity + addAndRegisterBlockEntity */
  setBlockEntity(be) {
    this.addAndRegisterBlockEntity(be);
  }

  addAndRegisterBlockEntity(be) {
    const s = this.getBlockState(be.pos);
    if (!s.block.hasBlockEntity(s)) return;
    be.removed = false;
    if ('world' in be) be.world = this;
    const old = this.blockEntities.get(be.pos.key);
    this.blockEntities.set(be.pos.key, be);
    if (old && old !== be) {
      old.removed = true;
      this.vibrationListeners.delete(old);
    }
    if (be.listensToVibrations) this.vibrationListeners.add(be);
    this.changed.add(be.pos.key);
    this.updateBlockEntityTicker(be);
  }

  updateBlockEntityTicker(be) {
    const key = be.pos.key;
    if (typeof be.tick !== 'function') {
      this.removeBlockEntityTicker(key);
      return;
    }
    const wrapper = this.tickersByPos.get(key);
    if (wrapper) {
      wrapper.be = be;
    } else {
      const w = { be, pos: be.pos };
      this.tickersByPos.set(key, w);
      (this.tickingBlockEntities ? this.pendingTickers : this.tickers).push(w);
    }
  }

  removeBlockEntityTicker(key) {
    const w = this.tickersByPos.get(key);
    if (w) {
      this.tickersByPos.delete(key);
      w.be = null;
    }
  }

  removeBlockEntity(pos) {
    if (this.isOutsideBuildHeight(pos)) return;
    const be = this.blockEntities.get(pos.key);
    if (be) {
      this.blockEntities.delete(pos.key);
      be.removed = true;
      this.vibrationListeners.delete(be);
      this.changed.add(pos.key);
    }
    this.removeBlockEntityTicker(pos.key);
  }

  _tickBlockEntities() {
    this.tickingBlockEntities = true;
    if (this.pendingTickers.length) {
      this.tickers.push(...this.pendingTickers);
      this.pendingTickers = [];
    }
    const kept = [];
    for (const w of this.tickers) {
      if (!w.be || w.be.removed) continue;
      kept.push(w);
      const s = this.getBlockState(w.be.pos);
      if (this.shouldTickBlocksAt(w.be.pos) && w.be.isValid(s)) w.be.tick(this, w.be.pos, s);
    }
    this.tickers = kept;
    this.tickingBlockEntities = false;
  }

  // ---------------------------------------------------------------- game tick

  /** One game tick in ServerLevel.tick order. */
  tick() {
    this.time++;
    const phase = (p) => this.rec && (this.rec.phase = p);
    this.handlingTick = true;
    phase('block_ticks');
    this._runScheduledTicks();
    if (this.randomTickSpeed > 0) {
      phase('random_ticks');
      this._runRandomTicks();
    }
    phase('block_events');
    this._runBlockEvents();
    this.handlingTick = false;
    phase('block_entities');
    this._tickBlockEntities();
    phase('input');
  }

  // ---------------------------------------------------------------- player-like actions

  /**
   * Places a block the way BlockItem.place does: placement state, survival check,
   * setBlock(..., 11), then setPlacedBy.
   */
  placeBlock(pos, id, props = {}) {
    const block = getBlock(id);
    if (this.isOutsideBuildHeight(pos)) throw new Error(`y=${pos.y} is outside the build height`);
    const existing = this.getBlockState(pos);
    if (!existing.block.isAir) this.removeBlock(pos, false);
    const state = block.getStateForPlacement(this, pos, props);
    if (!state.block.canSurvive(this, pos, state)) {
      throw new Error(`${id} cannot survive at ${pos} (needs a supporting block)`);
    }
    this.setBlock(pos, state, F.NEIGHBORS | F.CLIENTS | F.IMMEDIATE);
    const now = this.getBlockState(pos);
    if (now.id === state.id) now.block.setPlacedBy(this, pos, now);
    // BlockItem.place
    this.gameEvent('block_place', pos, this.getBlockState(pos));
    return this.getBlockState(pos);
  }

  /** /setblock semantics: place with flag 2 (shape updates only), then a block update. */
  commandSetBlock(pos, state) {
    if (this.isOutsideBuildHeight(pos)) throw new Error(`y=${pos.y} is outside the build height`);
    if (!this.setBlock(pos, state, F.CLIENTS)) return false;
    this.updateNeighborsAt(pos, state.block);
    return true;
  }

  breakBlock(pos) {
    return this.removeBlock(pos, false);
  }

  useBlock(pos) {
    const s = this.getBlockState(pos);
    return s.block.use(this, pos, s);
  }

  // ---------------------------------------------------------------- introspection

  pendingTicksAt(pos) {
    const out = [];
    for (const t of this.pendingTicks.values()) {
      if (t.pos.equals(pos)) out.push({ block: t.id, inTicks: t.trigger - this.time, priority: t.priority });
    }
    return out;
  }

  /** Signal strength a probe should report for a block (what Redstone Multimeter would show). */
  powerLevel(pos) {
    const s = this.getBlockState(pos);
    return s.block.isAir ? null : s.block.reportPower(this, pos, s);
  }

  flushChanged() {
    const keys = [...this.changed];
    this.changed.clear();
    return keys.map(posFromKey);
  }

  bounds() {
    if (!this.blocks.size) return null;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const k of this.blocks.keys()) {
      const p = k.split(',').map(Number);
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    return { min, max };
  }
}

export { Pos };
