// Containers (26.1.2 ports): BaseContainerBlockEntity, ChestBlock + ChestBlockEntity +
// CompoundContainer, HopperBlock + HopperBlockEntity, DispenserBlock / DropperBlock +
// DispenserBlockEntity, BarrelBlock, ShulkerBoxBlock. Items move between containers exactly as
// in vanilla (slot order, hopper cooldowns, setChanged calls that wake comparators). Not
// simulated: item entities (a dropper or dispenser facing air removes the item it would throw),
// players opening containers, and the special dispenser behaviours (buckets, bone meal, ...):
// a dispenser throws every item like a dropper facing air.

import { defineBlock } from './base.js';
import { makeState, withProp } from '../state.js';
import { ALL, UP, DOWN, dirByName } from '../dir.js';
import { F } from '../world.js';
import { ItemStack, EMPTY, sameItem, redstoneSignalFromContainer } from '../items.js';

const HDIRS = ['north', 'south', 'west', 'east'];
const DIRS6 = ['down', 'up', 'north', 'south', 'west', 'east'];

const isShulkerBoxItem = (id) => /(^|_)shulker_box$/.test(id);

// ------------------------------------------------------------------ block entity base

/** BaseContainerBlockEntity (+ RandomizableContainerBlockEntity without loot tables). */
export class ContainerBlockEntity {
  constructor(type, pos, state, size) {
    this.type = type;
    this.pos = pos;
    this.state = state;
    this.items = new Array(size).fill(EMPTY);
    this.removed = false;
    this.world = null;
  }

  isValid(state) { return state.block === this.state.block; }
  getContainerSize() { return this.items.length; }
  getItem(slot) { return this.items[slot]; }
  isEmpty() { return this.items.every((it) => it.isEmpty()); }
  getMaxStackSize() { return 99; }
  getMaxStackSizeFor(stack) { return Math.min(this.getMaxStackSize(), stack.getMaxStackSize()); }
  canPlaceItem() { return true; }
  canTakeItem() { return true; }

  /** ContainerHelper.removeItem */
  _remove(slot, count) {
    if (slot < 0 || slot >= this.items.length || this.items[slot].isEmpty() || count <= 0) return EMPTY;
    return this.items[slot].split(count);
  }

  removeItem(slot, count) {
    const out = this._remove(slot, count);
    if (!out.isEmpty()) this.setChanged();
    return out;
  }

  setItem(slot, stack) {
    this.items[slot] = stack;
    stack.limitSize(this.getMaxStackSizeFor(stack));
    this.setChanged();
  }

  /** BlockEntity.setChanged: wakes comparators (Level.updateNeighbourForOutputSignal). */
  setChanged() {
    const w = this.world;
    if (!w) return;
    w.changed.add(this.pos.key);
    if (w.rec) w.record('items', this.pos, undefined, this.describe());
    if (!this.state.block.isAir) w.updateNeighbourForOutputSignal(this.pos, this.state.block);
  }

  /** "slot:minecraft:id*count ..." (the conformance captures' item log format). */
  describe() {
    const parts = [];
    this.items.forEach((it, i) => {
      if (!it.isEmpty()) parts.push(`${i}:minecraft:${it.id}*${it.count}`);
    });
    return parts.join(' ');
  }

  save() {
    const items = [];
    this.items.forEach((it, i) => {
      if (!it.isEmpty()) items.push([i, it.id, it.count]);
    });
    return { items };
  }

  load(data) {
    this.items.fill(EMPTY);
    for (const [slot, id, count] of data?.items ?? []) {
      if (slot >= 0 && slot < this.items.length) this.items[slot] = ItemStack.of(id, count);
    }
  }

  /** Clearable.clearContent (BaseContainerBlockEntity: getItems().clear(), no update) */
  clearContent() {
    this.items.fill(EMPTY);
  }

  /** Puts items in without any update (loading a design). */
  fill(list) {
    for (const { slot, id, count } of list) this.items[slot] = ItemStack.of(id, count);
  }
}

/** CompoundContainer: a double chest (first = the right half). */
class CompoundContainer {
  constructor(c1, c2) {
    this.c1 = c1;
    this.c2 = c2;
  }
  getContainerSize() { return this.c1.getContainerSize() + this.c2.getContainerSize(); }
  isEmpty() { return this.c1.isEmpty() && this.c2.isEmpty(); }
  _at(slot) {
    const n = this.c1.getContainerSize();
    return slot >= n ? [this.c2, slot - n] : [this.c1, slot];
  }
  getItem(slot) { const [c, i] = this._at(slot); return c.getItem(i); }
  removeItem(slot, count) { const [c, i] = this._at(slot); return c.removeItem(i, count); }
  setItem(slot, stack) { const [c, i] = this._at(slot); c.setItem(i, stack); }
  getMaxStackSize() { return this.c1.getMaxStackSize(); }
  getMaxStackSizeFor(stack) { return Math.min(this.getMaxStackSize(), stack.getMaxStackSize()); }
  setChanged() {
    this.c1.setChanged();
    this.c2.setChanged();
  }
  canPlaceItem(slot, stack) { const [c, i] = this._at(slot); return c.canPlaceItem(i, stack); }
  canTakeItem() { return true; }
}

// ------------------------------------------------------------------ hopper transfer logic

const FLAT_SLOTS = [];
function getSlots(container, dir) {
  if (container.getSlotsForFace) return container.getSlotsForFace(dir);
  const n = container.getContainerSize();
  return (FLAT_SLOTS[n] ??= [...Array(n).keys()]);
}

function isFullContainer(container, dir) {
  for (const slot of getSlots(container, dir)) {
    const it = container.getItem(slot);
    if (it.count < it.getMaxStackSize()) return false;
  }
  return true;
}

function canPlaceItemInContainer(container, stack, slot, dir) {
  if (!container.canPlaceItem(slot, stack)) return false;
  return !container.canPlaceItemThroughFace || container.canPlaceItemThroughFace(slot, stack, dir);
}

function canTakeItemFromContainer(into, from, stack, slot, dir) {
  if (!from.canTakeItem(into, slot, stack)) return false;
  return !from.canTakeItemThroughFace || from.canTakeItemThroughFace(slot, stack, dir);
}

const canMergeItems = (a, b) => a.count <= a.getMaxStackSize() && sameItem(a, b);

/** HopperBlockEntity.tryMoveInItem */
function tryMoveInItem(from, container, stack, slot, dir) {
  const current = container.getItem(slot);
  if (canPlaceItemInContainer(container, stack, slot, dir)) {
    let success = false;
    const wasEmpty = container.isEmpty();
    if (current.isEmpty()) {
      container.setItem(slot, stack);
      stack = EMPTY;
      success = true;
    } else if (canMergeItems(current, stack)) {
      const space = stack.getMaxStackSize() - current.count;
      const count = Math.min(stack.count, space);
      stack.shrink(count);
      current.grow(count);
      success = count > 0;
    }
    if (success) {
      if (wasEmpty && container instanceof HopperBlockEntity && !container.isOnCustomCooldown()) {
        let skip = 0;
        if (from instanceof HopperBlockEntity && container.tickedGameTime >= from.tickedGameTime) skip = 1;
        container.cooldownTime = 8 - skip;
      }
      container.setChanged();
    }
  }
  return stack;
}

/** HopperBlockEntity.addItem(from, container, stack, dir) */
export function addItem(from, container, stack, dir) {
  if (container.getSlotsForFace && dir) {
    for (const slot of container.getSlotsForFace(dir)) {
      if (stack.isEmpty()) return stack;
      stack = tryMoveInItem(from, container, stack, slot, dir);
    }
    return stack;
  }
  const n = container.getContainerSize();
  for (let i = 0; i < n; i++) {
    if (stack.isEmpty()) return stack;
    stack = tryMoveInItem(from, container, stack, i, dir);
  }
  return stack;
}

/** HopperBlockEntity.getContainerAt (block containers only: no entities are simulated). */
export function getContainerAt(world, pos) {
  const state = world.getBlockState(pos);
  // WorldlyContainerHolder (the composter)
  if (state.block.getWorldlyContainer) return state.block.getWorldlyContainer(world, pos, state);
  if (!state.block.hasBlockEntity(state)) return null;
  const be = world.getBlockEntity(pos);
  if (!(be instanceof ContainerBlockEntity)) return null;
  if (be instanceof ChestBlockEntity && state.block.isChest) return chestContainer(world, pos, state, true);
  return be;
}

// ------------------------------------------------------------------ chest

class ChestBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('chest', pos, state, 27);
  }
}

/** ChestBlock.getConnectedDirection */
function connectedDirection(state) {
  const f = dirByName(state.props.facing);
  return state.props.type === 'left' ? f.clockwise() : f.counterClockwise();
}

/** ChestBlock.isChestBlockedAt (no cats): a redstone conductor on top. */
function chestBlocked(world, pos) {
  const above = pos.above();
  const s = world.getBlockState(above);
  return s.block.isConductor(s, world, above);
}

/** ChestBlock.getContainer: the single chest, the double chest, or null when blocked. */
function chestContainer(world, pos, state, ignoreBlocked) {
  const be = world.getBlockEntity(pos);
  if (!(be instanceof ChestBlockEntity)) return null;
  if (!ignoreBlocked && chestBlocked(world, pos)) return null;
  const type = state.props.type;
  if (type === 'single') return be;
  const np = pos.rel(connectedDirection(state));
  const ns = world.getBlockState(np);
  if (ns.block === state.block && ns.props.type !== 'single' && ns.props.type !== type && ns.props.facing === state.props.facing) {
    if (!ignoreBlocked && chestBlocked(world, np)) return null;
    const nbe = world.getBlockEntity(np);
    if (nbe instanceof ChestBlockEntity) return type === 'right' ? new CompoundContainer(be, nbe) : new CompoundContainer(nbe, be);
  }
  return be;
}

const containerBlock = {
  hasBlockEntity() { return true; },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos) {
    const be = world.getBlockEntity(pos);
    return be instanceof ContainerBlockEntity ? redstoneSignalFromContainer(be) : 0;
  },
  /** Containers.updateNeighboursAfterDestroy */
  affectNeighborsAfterRemoval(world, pos, state) {
    world.updateNeighbourForOutputSignal(pos, state.block);
  },
  reportPower(world, pos, state) { return this.getAnalogOutput(world, pos, state); },
};

for (const [id, color] of [['chest', 0xa06a2c]]) {
  defineBlock({
    ...containerBlock,
    id,
    color,
    glyph: 'c',
    isChest: true,
    properties: { facing: HDIRS, type: ['single', 'left', 'right'], waterlogged: [false, true] },
    isConductor() { return false; },
    faceSturdy(state, dir, type = 'full') { return dir === DOWN && type !== 'full'; },
    newBlockEntity(pos, state) { return new ChestBlockEntity(pos, state); },
    getStateForPlacement(world, pos, props) {
      const s = makeState(this, props);
      if ('type' in props) return s;
      // ChestBlock.getChestType: join a single chest with the same facing on the left or right
      const f = dirByName(s.props.facing);
      const partner = (d) => {
        const n = world.getBlockState(pos.rel(d));
        return n.block === this && n.props.type === 'single' ? n.props.facing : null;
      };
      if (s.props.facing === partner(f.clockwise())) return withProp(s, 'type', 'left');
      if (s.props.facing === partner(f.counterClockwise())) return withProp(s, 'type', 'right');
      return s;
    },
    updateShape(world, pos, state, dir, neighborState) {
      if (neighborState.block === this && dir.isHorizontal) {
        const nt = neighborState.props.type;
        if (state.props.type === 'single' && nt !== 'single' && state.props.facing === neighborState.props.facing && connectedDirection(neighborState) === dir.opposite) {
          return withProp(state, 'type', nt === 'left' ? 'right' : 'left');
        }
      } else if (state.props.type !== 'single' && connectedDirection(state) === dir) {
        return withProp(state, 'type', 'single');
      }
      return state;
    },
    getAnalogOutput(world, pos, state) {
      return redstoneSignalFromContainer(chestContainer(world, pos, state, false));
    },
  });
}

// ------------------------------------------------------------------ hopper

class HopperBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('hopper', pos, state, 5);
    this.cooldownTime = -1;
    this.tickedGameTime = 0;
  }

  // a hopper's own removeItem / setItem do not call setChanged (its callers do)
  removeItem(slot, count) { return this._remove(slot, count); }
  setItem(slot, stack) {
    this.items[slot] = stack;
    stack.limitSize(this.getMaxStackSizeFor(stack));
  }

  isOnCooldown() { return this.cooldownTime > 0; }
  isOnCustomCooldown() { return this.cooldownTime > 8; }
  facing() { return dirByName(this.state.props.facing); }

  inventoryFull() {
    for (const it of this.items) if (it.isEmpty() || it.count !== it.getMaxStackSize()) return false;
    return true;
  }

  /** HopperBlockEntity.pushItemsTick */
  tick(world, pos, state) {
    this.cooldownTime--;
    this.tickedGameTime = world.time;
    if (!this.isOnCooldown()) {
      this.cooldownTime = 0;
      this.tryMoveItems(world, pos, state);
    }
  }

  tryMoveItems(world, pos, state) {
    if (this.isOnCooldown() || !state.props.enabled) return false;
    let changed = false;
    if (!this.isEmpty()) changed = this.ejectItems(world, pos);
    if (!this.inventoryFull()) changed = this.suckInItems(world, pos) || changed;
    if (changed) {
      this.cooldownTime = 8;
      // the static BlockEntity.setChanged(level, pos, state), with the ticker's state (the captures
      // log only the instance method's calls)
      world.changed.add(pos.key);
      if (!state.block.isAir) world.updateNeighbourForOutputSignal(pos, state.block);
      return true;
    }
    return false;
  }

  ejectItems(world, pos) {
    const container = getContainerAt(world, pos.rel(this.facing()));
    if (!container) return false;
    const dir = this.facing().opposite;
    if (isFullContainer(container, dir)) return false;
    for (let slot = 0; slot < this.items.length; slot++) {
      const stack = this.items[slot];
      if (stack.isEmpty()) continue;
      const original = stack.count;
      const result = addItem(this, container, this.removeItem(slot, 1), dir);
      if (result.isEmpty()) {
        container.setChanged();
        return true;
      }
      stack.setCount(original);
      if (original === 1) this.setItem(slot, stack);
    }
    return false;
  }

  suckInItems(world, pos) {
    const container = getContainerAt(world, pos.above());
    if (!container) return false; // item entities are not simulated
    for (const slot of getSlots(container, DOWN)) {
      const stack = container.getItem(slot);
      if (stack.isEmpty() || !canTakeItemFromContainer(this, container, stack, slot, DOWN)) continue;
      const original = stack.count;
      const result = addItem(container, this, container.removeItem(slot, 1), null);
      if (result.isEmpty()) {
        container.setChanged();
        return true;
      }
      stack.setCount(original);
      if (original === 1) container.setItem(slot, stack);
    }
    return false;
  }

  save() { return { ...super.save(), cooldown: this.cooldownTime }; }
  load(data) {
    super.load(data);
    this.cooldownTime = data?.cooldown ?? -1;
  }
}

defineBlock({
  ...containerBlock,
  id: 'hopper',
  glyph: 'h',
  color: 0x4a4a4e,
  properties: { facing: ['down', 'north', 'south', 'west', 'east'], enabled: [true, false] },
  isConductor() { return false; },
  faceSturdy(state, dir, type = 'full') { return dir === UP || (dir === DOWN && type !== 'full'); },
  newBlockEntity(pos, state) { return new HopperBlockEntity(pos, state); },
  getStateForPlacement(world, pos, props) {
    const p = { ...props };
    if (p.facing === 'up') p.facing = 'down';
    return makeState(this, p);
  },
  checkPoweredState(world, pos, state) {
    const on = !world.hasNeighborSignal(pos);
    if (on !== state.props.enabled) world.setBlock(pos, withProp(state, 'enabled', on), F.CLIENTS);
  },
  onPlace(world, pos, state, oldState) {
    if (oldState.block !== state.block) this.checkPoweredState(world, pos, state);
  },
  neighborChanged(world, pos, state) {
    this.checkPoweredState(world, pos, state);
  },
});

// ------------------------------------------------------------------ dispenser / dropper

class DispenserBlockEntity extends ContainerBlockEntity {
  constructor(type, pos, state) {
    super(type, pos, state, 9);
  }
  /** DispenserBlockEntity.getRandomSlot: reservoir sampling over the filled slots. */
  getRandomSlot(random) {
    let slot = -1;
    let odds = 1;
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].isEmpty() && random.nextInt(odds++) === 0) slot = i;
    }
    return slot;
  }
}

/** DefaultDispenseItemBehavior.execute: one item flies out (as an entity, not simulated). */
function defaultDispense(stack) {
  stack.split(1);
  return stack;
}

function dispenserBlock(id, dropper) {
  defineBlock({
    ...containerBlock,
    id,
    glyph: dropper ? 'd' : 'p',
    color: 0x6e6e6e,
    properties: { facing: DIRS6, triggered: [false, true] },
    newBlockEntity(pos, state) { return new DispenserBlockEntity(id, pos, state); },
    neighborChanged(world, pos, state) {
      const should = world.hasNeighborSignal(pos) || world.hasNeighborSignal(pos.above());
      const triggered = state.props.triggered;
      if (should && !triggered) {
        world.scheduleTick(pos, this, 4);
        world.setBlock(pos, withProp(state, 'triggered', true), F.CLIENTS);
      } else if (!should && triggered) {
        world.setBlock(pos, withProp(state, 'triggered', false), F.CLIENTS);
      }
    },
    tick(world, pos, state) {
      const be = world.getBlockEntity(pos);
      if (!(be instanceof DispenserBlockEntity)) return;
      const slot = be.getRandomSlot(world.random);
      if (slot < 0) {
        if (!dropper) world.gameEvent('block_activate', pos, be.state);
        return;
      }
      const stack = be.getItem(slot);
      if (!dropper) {
        be.setItem(slot, defaultDispense(stack));
        return;
      }
      if (stack.isEmpty()) return;
      const dir = dirByName(world.getBlockState(pos).props.facing);
      const into = getContainerAt(world, pos.rel(dir));
      let remaining;
      if (!into) {
        remaining = defaultDispense(stack);
      } else {
        remaining = addItem(be, into, stack.copyWithCount(1), dir.opposite);
        if (remaining.isEmpty()) {
          remaining = stack.copy();
          remaining.shrink(1);
          if (remaining.count <= 0) remaining = EMPTY;
        } else {
          remaining = stack.copy();
        }
      }
      be.setItem(slot, remaining);
    },
  });
}
dispenserBlock('dispenser', false);
dispenserBlock('dropper', true);

// ------------------------------------------------------------------ barrel

/**
 * Barrel: a 27-slot container. Its comparator output can also be set directly (setSignal), which
 * stands in for any container; that value holds until items change.
 */
class BarrelBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('container', pos, state, 27);
    this.signal = null;
  }
  setChanged() {
    this.signal = null;
    super.setChanged();
  }
  save() {
    const out = super.save();
    if (this.signal !== null) out.signal = this.signal;
    return out;
  }
  load(data) {
    super.load(data);
    this.signal = data?.signal ?? null;
  }
}

defineBlock({
  ...containerBlock,
  id: 'barrel',
  glyph: 'B',
  color: 0x7a5530,
  properties: { facing: DIRS6, open: [false, true] },
  defaults: { facing: 'up' },
  newBlockEntity(pos, state) { return new BarrelBlockEntity(pos, state); },
  getAnalogOutput(world, pos) {
    const be = world.getBlockEntity(pos);
    if (!(be instanceof BarrelBlockEntity)) return 0;
    return be.signal ?? redstoneSignalFromContainer(be);
  },
  setSignal(world, pos, signal) {
    const be = world.getBlockEntity(pos);
    if (!(be instanceof BarrelBlockEntity)) return false;
    be.signal = Math.max(0, Math.min(15, signal | 0));
    world.changed.add(pos.key);
    world.updateNeighbourForOutputSignal(pos, this);
    return true;
  },
});

// ------------------------------------------------------------------ shulker boxes

const SHULKER_SLOTS = [...Array(27).keys()];

class ShulkerBoxBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('shulker_box', pos, state, 27);
  }
  getSlotsForFace() { return SHULKER_SLOTS; }
  canPlaceItemThroughFace(slot, stack) { return !isShulkerBoxItem(stack.id); }
  canTakeItemThroughFace() { return true; }
}

const COLORS = {
  '': 0x8b5f8b, white_: 0xd8dcdc, orange_: 0xe8701a, magenta_: 0xb03fa8, light_blue_: 0x3aafd9, yellow_: 0xf8c628,
  lime_: 0x70b81a, pink_: 0xee8dac, gray_: 0x3e4447, light_gray_: 0x8e8e86, cyan_: 0x158991, purple_: 0x792aac,
  blue_: 0x35399d, brown_: 0x724728, green_: 0x546d1b, red_: 0xa12722, black_: 0x15151a,
};
for (const [prefix, color] of Object.entries(COLORS)) {
  defineBlock({
    ...containerBlock,
    id: `${prefix}shulker_box`,
    glyph: 'X',
    color,
    properties: { facing: DIRS6 },
    defaults: { facing: 'up' },
    pushReaction() { return 'destroy'; },
    newBlockEntity(pos, state) { return new ShulkerBoxBlockEntity(pos, state); },
  });
}

export { ChestBlockEntity, HopperBlockEntity, DispenserBlockEntity, BarrelBlockEntity, ShulkerBoxBlockEntity, chestContainer };
