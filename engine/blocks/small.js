// Smaller redstone blocks (26.1.2 ports): tripwire hooks and string (TripWireHookBlock,
// TripWireBlock), cake (CakeBlock), bell (BellBlock + BellBlockEntity), lectern (LecternBlock +
// LecternBlockEntity) and the wooden shelves (ShelfBlock, SideChainPartBlock, ShelfBlockEntity).
// No entities: nothing walks through a string (a powered string unpowers on its next check), the
// cake is eaten by "use", a lectern's book is a page count (use turns to the next page), and
// players never swap items with a shelf (hoppers can still fill and empty one).

import { defineBlock, COMPONENT } from './base.js';
import { makeState, withProp } from '../state.js';
import { UP, DOWN, NORTH, SOUTH, WEST, EAST, dirByName } from '../dir.js';
import { F } from '../world.js';
import { ContainerBlockEntity } from './containers.js';

const HDIRS = ['north', 'south', 'west', 'east'];

/**
 * BlockState.isSolid (the legacy "solid" flag, from the collision shape): what a cake needs below.
 * Components that pistons destroy are not solid; doors and shulker boxes are.
 */
function isLegacySolid(s) {
  if (s.block.isAir) return false;
  if (s.block.legacySolid !== undefined) return s.block.legacySolid;
  if (s.block.isDoor || /shulker_box$/.test(s.id)) return true;
  return s.block.pushReaction(s) !== 'destroy';
}

// ------------------------------------------------------------------ tripwire hook

/** TripWireHookBlock.calculateState */
function calculateState(world, pos, state, isBeingDestroyed, canUpdate, wireSource, wireSourceState) {
  if (!('facing' in state.props)) return;
  const direction = dirByName(state.props.facing);
  const wasAttached = state.props.attached ?? false;
  const wasPowered = state.props.powered ?? false;
  const block = state.block;
  let attached = !isBeingDestroyed;
  let powered = false;
  let receiverPos = 0;
  const wireStates = new Array(42).fill(null);
  for (let i = 1; i < 42; i++) {
    const testPos = pos.rel(direction, i);
    let wireState = world.getBlockState(testPos);
    if (wireState.id === 'tripwire_hook') {
      if (wireState.props.facing === direction.opposite.name) receiverPos = i;
      break;
    }
    if (wireState.id === 'tripwire' || i === wireSource) {
      if (i === wireSource) wireState = wireSourceState ?? wireState;
      const armed = !wireState.props.disarmed;
      powered ||= armed && !!wireState.props.powered;
      wireStates[i] = wireState;
      if (i !== wireSource) continue;
      world.scheduleTick(pos, block, 10);
      attached &&= armed;
      continue;
    }
    wireStates[i] = null;
    attached = false;
  }
  attached &&= receiverPos > 1;
  powered &&= attached;
  // block.defaultBlockState() with attached and powered: its facing is the default (north)
  const newState = withProp(withProp(block.defaultState, 'attached', attached), 'powered', powered);
  if (receiverPos > 0) {
    const testPos = pos.rel(direction, receiverPos);
    const opposite = direction.opposite;
    world.setBlock(testPos, withProp(newState, 'facing', opposite.name), F.ALL);
    notifyHookNeighbors(block, world, testPos, opposite);
    if (world.getBlockState(pos).id !== 'tripwire_hook') {
      onHookRemoved(newState, world, pos);
      return;
    }
    emitHookState(world, testPos, attached, powered, wasAttached, wasPowered);
  }
  emitHookState(world, pos, attached, powered, wasAttached, wasPowered);
  if (!isBeingDestroyed) {
    world.setBlock(pos, withProp(newState, 'facing', direction.name), F.ALL);
    if (canUpdate) notifyHookNeighbors(block, world, pos, direction);
  }
  if (wasAttached !== attached) {
    for (let i = 1; i < receiverPos; i++) {
      const p = pos.rel(direction, i);
      const wireData = wireStates[i];
      if (!wireData) continue;
      const now = world.getBlockState(p);
      if (now.id !== 'tripwire' && now.id !== 'tripwire_hook') continue;
      world.setBlock(p, 'attached' in wireData.props ? withProp(wireData, 'attached', attached) : wireData, F.ALL);
    }
  }
}

function emitHookState(world, pos, attached, powered, wasAttached, wasPowered) {
  if (powered && !wasPowered) world.gameEvent('block_activate', pos);
  else if (!powered && wasPowered) world.gameEvent('block_deactivate', pos);
  else if (attached && !wasAttached) world.gameEvent('block_attach', pos);
  else if (!attached && wasAttached) world.gameEvent('block_detach', pos);
}

function notifyHookNeighbors(block, world, pos, direction) {
  const front = direction.opposite;
  world.updateNeighborsAt(pos, block);
  world.updateNeighborsAt(pos.rel(front), block);
}

function onHookRemoved(state, world, pos) {
  const { attached, powered } = state.props;
  if (attached || powered) calculateState(world, pos, state, true, false, -1, null);
  if (powered) notifyHookNeighbors(state.block, world, pos, dirByName(state.props.facing));
}

defineBlock({
  ...COMPONENT,
  id: 'tripwire_hook',
  glyph: 'h',
  color: 0x8a7a5a,
  properties: { facing: HDIRS, powered: [false, true], attached: [false, true] },
  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.powered ? 15 : 0; },
  getSignal(world, pos, state) { return state.props.powered ? 15 : 0; },
  getDirectSignal(world, pos, state, dir) { return state.props.powered && state.props.facing === dir.name ? 15 : 0; },
  canSurvive(world, pos, state) {
    const d = dirByName(state.props.facing);
    const behind = pos.rel(d.opposite);
    const bs = world.getBlockState(behind);
    return bs.block.faceSturdy(bs, d);
  },
  updateShape(world, pos, state, dir) {
    if (dir.opposite.name === state.props.facing && !this.canSurvive(world, pos, state)) return world.air;
    return state;
  },
  setPlacedBy(world, pos, state) {
    calculateState(world, pos, state, false, false, -1, null);
  },
  tick(world, pos, state) {
    calculateState(world, pos, state, false, true, -1, null);
  },
  affectNeighborsAfterRemoval(world, pos, state, movedByPiston) {
    if (!movedByPiston) onHookRemoved(state, world, pos);
  },
});

// ------------------------------------------------------------------ tripwire (string)

const STRING_SIDES = { north: NORTH, east: EAST, south: SOUTH, west: WEST };

defineBlock({
  ...COMPONENT,
  id: 'tripwire',
  glyph: 's',
  color: 0xdedede,
  properties: {
    powered: [false, true], attached: [false, true], disarmed: [false, true],
    north: [false, true], east: [false, true], west: [false, true], south: [false, true],
  },
  shouldConnectTo(s, dir) {
    if (s.id === 'tripwire_hook') return s.props.facing === dir.opposite.name;
    return s.id === 'tripwire';
  },
  getStateForPlacement(world, pos, props) {
    let s = makeState(this, props);
    for (const [name, d] of Object.entries(STRING_SIDES)) {
      if (!(name in props)) s = withProp(s, name, this.shouldConnectTo(world.getBlockState(pos.rel(d)), d));
    }
    return s;
  },
  updateShape(world, pos, state, dir, neighborState) {
    if (dir.axis !== 'y') return withProp(state, dir.name, this.shouldConnectTo(neighborState, dir));
    return state;
  },
  onPlace(world, pos, state, oldState) {
    if (oldState.block !== state.block) this.updateSource(world, pos, state);
  },
  affectNeighborsAfterRemoval(world, pos, state, movedByPiston) {
    if (!movedByPiston) this.updateSource(world, pos, withProp(state, 'powered', true));
  },
  /** TripWireBlock.updateSource: the hooks to the south and the west recompute the line */
  updateSource(world, pos, state) {
    for (const dir of [SOUTH, WEST]) {
      for (let i = 1; i < 42; i++) {
        const testPos = pos.rel(dir, i);
        const s = world.getBlockState(testPos);
        if (s.id === 'tripwire_hook') {
          if (s.props.facing === dir.opposite.name) calculateState(world, testPos, s, false, true, i, state);
          break;
        }
        if (s.id !== 'tripwire') break;
      }
    }
  },
  /** checkPressed with no entities inside: a powered string turns off */
  tick(world, pos) {
    const s = world.getBlockState(pos);
    if (!s.props.powered) return;
    const next = withProp(s, 'powered', false);
    world.setBlock(pos, next, F.ALL);
    this.updateSource(world, pos, next);
  },
});

// ------------------------------------------------------------------ cake

defineBlock({
  ...COMPONENT,
  id: 'cake',
  glyph: 'k',
  color: 0xf3e6d8,
  properties: { bites: [0, 1, 2, 3, 4, 5, 6] },
  legacySolid: true,
  canSurvive(world, pos) { return isLegacySolid(world.getBlockState(pos.below())); },
  updateShape(world, pos, state, dir) {
    if (dir === DOWN && !this.canSurvive(world, pos, state)) return world.air;
    return state;
  },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos, state) { return (7 - state.props.bites) * 2; },
  reportPower(world, pos, state) { return (7 - state.props.bites) * 2; },
  /** CakeBlock.eat (a player who can eat) */
  use(world, pos, state) {
    world.gameEvent('eat', pos);
    if (state.props.bites < 6) world.setBlock(pos, withProp(state, 'bites', state.props.bites + 1), F.ALL);
    else {
      world.removeBlock(pos, false);
      world.gameEvent('block_destroy', pos);
    }
    return true;
  },
});

// ------------------------------------------------------------------ bell

class BellBlockEntity {
  constructor(pos, state) {
    this.type = 'bell';
    this.pos = pos;
    this.state = state;
    this.removed = false;
  }
  isValid(state) { return state.id === 'bell'; }
  save() { return {}; }
  load() {}
}

/** BellBlock.getConnectedDirection */
function bellConnected(state) {
  switch (state.props.attachment) {
    case 'ceiling': return DOWN;
    case 'floor': return UP;
    default: return dirByName(state.props.facing).opposite;
  }
}

defineBlock({
  ...COMPONENT,
  id: 'bell',
  glyph: 'n',
  color: 0xe8c03a,
  properties: { facing: HDIRS, attachment: ['floor', 'ceiling', 'single_wall', 'double_wall'], powered: [false, true] },
  legacySolid: true,
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new BellBlockEntity(pos, state); },
  canSurvive(world, pos, state) {
    const d = bellConnected(state).opposite;
    const np = pos.rel(d);
    const ns = world.getBlockState(np);
    if (d === UP) return ns.block.faceSturdy(ns, DOWN, 'center');
    return ns.block.faceSturdy(ns, d.opposite);
  },
  updateShape(world, pos, state, dir, neighborState) {
    const attachment = state.props.attachment;
    const connected = bellConnected(state).opposite;
    if (connected === dir && !this.canSurvive(world, pos, state) && attachment !== 'double_wall') return world.air;
    if (dir.axis === dirByName(state.props.facing).axis) {
      if (attachment === 'double_wall' && !neighborState.block.faceSturdy(neighborState, dir)) {
        return withProp(withProp(state, 'attachment', 'single_wall'), 'facing', dir.opposite.name);
      }
      if (attachment === 'single_wall' && connected.opposite === dir && neighborState.block.faceSturdy(neighborState, dirByName(state.props.facing))) {
        return withProp(state, 'attachment', 'double_wall');
      }
    }
    return state;
  },
  neighborChanged(world, pos, state) {
    const signal = world.hasNeighborSignal(pos);
    if (signal !== state.props.powered) {
      if (signal) this.attemptToRing(world, pos, null);
      world.setBlock(pos, withProp(state, 'powered', signal), F.ALL);
    }
  },
  use(world, pos) { return this.attemptToRing(world, pos, null); },
  /** BellBlock.attemptToRing + BellBlockEntity.onHit */
  attemptToRing(world, pos, direction) {
    if (!(world.getBlockEntity(pos) instanceof BellBlockEntity)) return false;
    const d = direction ?? dirByName(world.getBlockState(pos).props.facing);
    world.blockEvent(pos, this, 1, d.data3d);
    world.gameEvent('block_change', pos);
    return true;
  },
  /** BellBlockEntity.triggerEvent: the swing (nothing in the world changes) */
  triggerEvent(world, pos, state, a) { return a === 1; },
});

// ------------------------------------------------------------------ lectern

class LecternBlockEntity {
  constructor(pos, state) {
    this.type = 'lectern';
    this.pos = pos;
    this.state = state;
    this.removed = false;
    this.world = null;
    // the book, as a page count (0 = no book); a lectern placed with has_book=true gets 15 pages
    this.pageCount = state.props.has_book ? 15 : 0;
    this.page = 0;
  }
  isValid(state) { return state.id === 'lectern'; }
  hasBook() { return this.pageCount > 0; }
  /** BlockEntity.setChanged: wakes comparators */
  setChanged() {
    const w = this.world;
    if (!w) return;
    w.changed.add(this.pos.key);
    if (!this.state.block.isAir) w.updateNeighbourForOutputSignal(this.pos, this.state.block);
  }
  /** LecternBlockEntity.setPage (the book GUI's page buttons) */
  setPage(page) {
    const next = Math.max(0, Math.min(page, this.pageCount - 1));
    if (next !== this.page) {
      this.page = next;
      this.setChanged();
      this.state.block.signalPageChange(this.world, this.pos, this.state);
    }
  }
  getRedstoneSignal() {
    const progress = this.pageCount > 1 ? Math.fround(this.page / Math.fround(this.pageCount - 1)) : 1;
    return Math.floor(Math.fround(progress * 14)) + (this.hasBook() ? 1 : 0);
  }
  save() { return { pages: this.pageCount, page: this.page }; }
  load(data) {
    this.pageCount = data?.pages ?? this.pageCount;
    this.page = data?.page ?? 0;
  }
}

defineBlock({
  id: 'lectern',
  glyph: 'T',
  color: 0xa0784a,
  properties: { facing: HDIRS, powered: [false, true], has_book: [false, true] },
  isConductor() { return false; },
  faceSturdy(state, dir) { return dir === DOWN; },
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new LecternBlockEntity(pos, state); },
  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.powered ? 15 : 0; },
  getSignal(world, pos, state) { return state.props.powered ? 15 : 0; },
  getDirectSignal(world, pos, state, dir) { return dir === UP && state.props.powered ? 15 : 0; },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos, state) {
    const be = world.getBlockEntity(pos);
    return state.props.has_book && be instanceof LecternBlockEntity ? be.getRedstoneSignal() : 0;
  },
  signalPageChange(world, pos, state) {
    this.changePowered(world, pos, state, true);
    world.scheduleTick(pos, this, 2);
  },
  changePowered(world, pos, state, powered) {
    world.setBlock(pos, withProp(state, 'powered', powered), F.ALL);
    world.updateNeighborsAt(pos.below(), this);
  },
  tick(world, pos, state) { this.changePowered(world, pos, state, false); },
  affectNeighborsAfterRemoval(world, pos, state) {
    if (state.props.powered) world.updateNeighborsAt(pos.below(), this);
  },
  /** stands in for the book GUI: the next page (back to the first after the last) */
  use(world, pos, state) {
    const be = world.getBlockEntity(pos);
    if (!state.props.has_book || !(be instanceof LecternBlockEntity) || be.pageCount < 2) return false;
    be.setPage((be.page + 1) % be.pageCount);
    return true;
  },
});

// ------------------------------------------------------------------ shelves

const SHELF_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];
const SHELVES = new Set(SHELF_WOODS.map((w) => `${w}_shelf`));

class ShelfBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('shelf', pos, state, 3);
  }
  /** ShelfBlockEntity.setChanged(BLOCK_ACTIVATE) */
  setChanged() {
    super.setChanged();
    if (this.world) this.world.gameEvent('block_activate', this.pos, this.state);
  }
}

// SideChainPart transitions
const PART = {
  connectedRight: { unconnected: 'left', left: 'left', right: 'center', center: 'center' },
  connectedLeft: { unconnected: 'right', right: 'right', center: 'center', left: 'center' },
  disconnectedRight: { unconnected: 'unconnected', left: 'unconnected', right: 'right', center: 'right' },
  disconnectedLeft: { unconnected: 'unconnected', right: 'unconnected', center: 'left', left: 'left' },
};
const isChainEnd = (part) => part !== 'center';
const connectsTowards = (part, end) => part === 'center' || part === end;
const isConnectable = (s) => SHELVES.has(s.id) && s.props.powered === true;

/** SideChainPartBlock.Neighbors: neighbours are read once and cached with their part. */
class ShelfNeighbors {
  constructor(world, facing, center) {
    this.world = world;
    this.facing = facing;
    this.center = center;
    this.cache = new Map();
  }
  get(dir, steps) {
    const p = this.center.rel(dir, steps);
    let n = this.cache.get(p.key);
    if (!n) {
      const s = this.world.getBlockState(p);
      const part = isConnectable(s) && s.props.facing === this.facing.name ? s.props.side_chain : null;
      n = { pos: p, part };
      this.cache.set(p.key, n);
    }
    return n;
  }
  left(steps = 1) { return this.get(this.facing.clockwise(), steps); }
  right(steps = 1) { return this.get(this.facing.counterClockwise(), steps); }
}

function setPart(world, pos, part) {
  const s = world.getBlockState(pos);
  if (s.props.side_chain !== part) world.setBlock(pos, withProp(s, 'side_chain', part), F.ALL);
}
const neighborSet = (world, n, table) => n.part !== null && setPart(world, n.pos, PART[table][n.part]);

function connectedTo(world, pos) {
  const s = world.getBlockState(pos);
  if (!isConnectable(s)) return [];
  const nb = new ShelfNeighbors(world, dirByName(s.props.facing), pos);
  const out = [pos];
  for (const [side, end, add] of [['left', 'left', (p) => out.unshift(p)], ['right', 'right', (p) => out.push(p)]]) {
    for (let steps = 1; steps < 3; steps++) {
      const n = nb[side](steps);
      if (n.part !== null && connectsTowards(n.part, end)) add(n.pos);
      if (n.part === null || isChainEnd(n.part)) break;
    }
  }
  return out;
}

const shelfBehavior = {
  glyph: 'f',
  isConductor() { return false; },
  faceSturdy() { return false; },
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new ShelfBlockEntity(pos, state); },
  hasAnalogOutput() { return true; },
  /** the comparator must read it from the front */
  getAnalogOutput(world, pos, state, dir) {
    if (dir && dir.name !== dirByName(state.props.facing).opposite.name) return 0;
    const be = world.getBlockEntity(pos);
    if (!(be instanceof ShelfBlockEntity)) return 0;
    return (be.getItem(0).isEmpty() ? 0 : 1) | (be.getItem(1).isEmpty() ? 0 : 2) | (be.getItem(2).isEmpty() ? 0 : 4);
  },
  reportPower(world, pos, state) { return this.getAnalogOutput(world, pos, state, null); },
  getStateForPlacement(world, pos, props) {
    const s = makeState(this, props);
    return 'powered' in props ? s : withProp(s, 'powered', world.hasNeighborSignal(pos));
  },
  neighborChanged(world, pos, state) {
    const signal = world.hasNeighborSignal(pos);
    if (state.props.powered !== signal) {
      let next = withProp(state, 'powered', signal);
      if (!signal) next = withProp(next, 'side_chain', 'unconnected');
      world.setBlock(pos, next, F.ALL);
      world.gameEvent(signal ? 'block_activate' : 'block_deactivate', pos, next);
    }
  },
  onPlace(world, pos, state, oldState) {
    if (state.props.powered) this.poweringUp(world, pos, state, oldState);
    else this.poweringDown(world, pos, state);
  },
  affectNeighborsAfterRemoval(world, pos, state) {
    world.updateNeighbourForOutputSignal(pos, state.block);
    this.poweringDown(world, pos, state);
  },
  /** SideChainPartBlock.updateNeighborsAfterPoweringDown */
  poweringDown(world, pos, state) {
    const nb = new ShelfNeighbors(world, dirByName(state.props.facing), pos);
    neighborSet(world, nb.left(), 'disconnectedRight');
    neighborSet(world, nb.right(), 'disconnectedLeft');
  },
  /** SideChainPartBlock.updateSelfAndNeighborsOnPoweringUp (chains of up to 3) */
  poweringUp(world, pos, state, oldState) {
    if (!isConnectable(state)) return;
    const gettingConnected = state.props.side_chain !== 'unconnected';
    const wasConnected = isConnectable(oldState) && oldState.props.side_chain !== 'unconnected';
    if (gettingConnected || wasConnected) return;
    const nb = new ShelfNeighbors(world, dirByName(state.props.facing), pos);
    let part = 'unconnected';
    const left = nb.left();
    const right = nb.right();
    const onLeft = left.part !== null ? connectedTo(world, left.pos).length : 0;
    const onRight = right.part !== null ? connectedTo(world, right.pos).length : 0;
    let length = 1;
    if (onLeft > 0 && length + onLeft <= 3) {
      part = PART.connectedLeft[part];
      neighborSet(world, left, 'connectedRight');
      length += onLeft;
    }
    if (onRight > 0 && length + onRight <= 3) {
      part = PART.connectedRight[part];
      neighborSet(world, right, 'connectedLeft');
    }
    setPart(world, pos, part);
  },
};

for (const wood of SHELF_WOODS) {
  defineBlock({
    ...shelfBehavior,
    id: `${wood}_shelf`,
    color: 0x9c7a4a,
    properties: { facing: HDIRS, powered: [false, true], side_chain: ['unconnected', 'right', 'center', 'left'], waterlogged: [false, true] },
  });
}
