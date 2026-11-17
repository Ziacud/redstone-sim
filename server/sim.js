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

const ARROW = { north: '↑', south: '↓', east: '→', west: '←', up: 'U', down: 'D' };

export class Simulation {
  constructor({ designsDir }) {
    this.designsDir = designsDir;
    this.listeners = new Set();
    this.tps = 20;
    this.running = true;
    this.designName = null; // the design the world was last loaded from / saved to
    this.trap = null; // chunk-border trap (see setTrap)
    this.paper = false; // Paper's piston move order (world.paper)
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
    const w = this.world;
    w.paper = this.paper;
    w.pistonEvent = this.trap ? this._trapHook : null;
    w.tick();
    const t = this.trap;
    if (!t) return;
    if (t.left > 0 && --t.left === 0) {
      for (const k of t.frozen) w.frozenChunks.delete(k);
      if (t.frozen.length && t.reload) w.reloadChunks(new Set(t.frozen));
      t.frozen = [];
      t.wait = t.cooldown;
    } else if (t.left === 0 && t.wait > 0) t.wait--;
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
    this.trap = { border: Math.round(border / 16) * 16, mode, hold, reload, cooldown, fired: 0, left: 0, wait: 0, frozen: [] };
    this._trapHook = (ev) => this._trapEvent(ev);
    this.broadcast({ type: 'status', ...this.status() });
  }

  clearTrap() {
    const t = this.trap;
    if (t) for (const k of t.frozen) this.world.frozenChunks.delete(k);
    this.trap = null;
    this.world.pistonEvent = null;
    this.broadcast({ type: 'status', ...this.status() });
  }

  setPaper(on) {
    this.paper = !!on;
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
      running: this.running,
      tps: this.tps,
      design: this.designName,
      frozen: [...this.world.frozenChunks],
      paper: this.paper,
      trap: this.trap && { border: this.trap.border, mode: this.trap.mode, hold: this.trap.hold, reload: this.trap.reload, fired: this.trap.fired, left: this.trap.left },
    };
  }

  // ---------------------------------------------------------------- chunk tests (viewer)

  /** Vanilla-accurate save + reload of every chunk (see World.simulateRestart). */
  restart() {
    this.world.simulateRestart();
    this.flush();
  }

  /** Freezes or thaws one chunk: a frozen chunk is loaded but gets no ticks, like the edge of a
   * player's simulation distance. */
  toggleChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (!this.world.frozenChunks.delete(key)) this.world.frozenChunks.add(key);
    this.flush();
  }

  thawAll() {
    this.world.frozenChunks.clear();
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
      out.push(power === null ? {} : { power });
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
    return { ...this.status(), blocks };
  }

  /** Sends changed blocks (plus their neighbors, whose displayed power may have changed). */
  flush() {
    const changed = this.world.flushChanged();
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
    this.broadcast({ type: 'update', ...this.status(), changes });
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
    const ok = this.world.useBlock(p);
    return { ok, state: this.world.getBlockState(p).key };
  }

  setSignal(x, y, z, value) {
    const p = pos(x, y, z);
    const s = this.world.getBlockState(p);
    if (typeof s.block.setSignal !== 'function') throw new Error(`${s.id} at ${p} has no adjustable comparator output (use a barrel)`);
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
      this.world.tick();
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
    this.broadcast({ type: 'snapshot', ...this.snapshot() });
    return { placed, skipped };
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
    'Building blocks (conductive unless noted): stone, smooth_stone, cobblestone, *_concrete (white, gray, black, red, orange, yellow, lime, green, cyan, light_blue, blue, purple, magenta, pink, brown), white_wool,',
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
    'barrel                        stands in for any container: set its comparator output with interact action=set_signal',
    'copper_bulb (+ exposed_/weathered_/oxidized_, waxed_*)[lit,powered]  toggles lit on each rising edge, no delay; not conductive; comparator reads 15 when lit; observers see both edges',
    '<wood>_trapdoor / iron_trapdoor[facing,half=bottom|top,open,powered]  opens while powered, no delay; use = toggle (not iron); view: "T_c" bottom closed, "T‾o" top open',
    'dirt, grass_block, sand (soil), water[level=0] (static source: flow NOT simulated), sugar_cane (needs soil with water beside it, pops 1 gt after losing support, breaks when pushed)',
    'Directions D: north (-z), south (+z), west (-x), east (+x), up, down.',
  ].join('\n');
}

export { MIN_Y, MAX_Y };
