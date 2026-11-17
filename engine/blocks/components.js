// Ports of RedstoneTorchBlock, RedstoneWallTorchBlock, LeverBlock, ButtonBlock, the redstone
// block, RedstoneLampBlock, DiodeBlock (repeater + comparator), ObserverBlock and a container.

import { defineBlock, COMPONENT, BaseBlock } from './base.js';
import { makeState, withProp } from '../state.js';
import { ALL, HORIZONTAL, UP, DOWN, dirByName } from '../dir.js';
import { F, PRIORITY } from '../world.js';

const HDIRS = ['north', 'south', 'west', 'east'];
const DIRS6 = ['down', 'up', 'north', 'south', 'west', 'east'];

// ------------------------------------------------------------------ redstone block

defineBlock({
  id: 'redstone_block',
  glyph: 'R',
  color: 0xb01a0a,
  isConductor() { return false; },
  isSignalSource() { return true; },
  getSignal() { return 15; },
  reportPower() { return 15; },
});

// ------------------------------------------------------------------ torches

const BURNOUT_WINDOW = 60;
const BURNOUT_TOGGLES = 8;

function isToggledTooFrequently(world, pos, logToggle) {
  if (logToggle) world.torchToggles.push({ pos, when: world.time });
  let i = 0;
  for (const t of world.torchToggles) {
    if (t.pos.equals(pos) && ++i >= BURNOUT_TOGGLES) return true;
  }
  return false;
}

const torchBehavior = {
  ...COMPONENT,
  glyph: '!',
  color: 0xff3010,
  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.lit ? 15 : 0; },

  onPlace(world, pos) {
    for (const d of ALL) world.updateNeighborsAt(pos.rel(d), this);
  },
  affectNeighborsAfterRemoval(world, pos, state, isMoving) {
    if (!isMoving) for (const d of ALL) world.updateNeighborsAt(pos.rel(d), this);
  },
  getDirectSignal(world, pos, state, dir) {
    return dir === DOWN ? this.getSignal(world, pos, state, dir) : 0;
  },
  tick(world, pos, state) {
    const powered = this.hasNeighborSignal(world, pos, state);
    const list = world.torchToggles;
    while (list.length && world.time - list[0].when > BURNOUT_WINDOW) list.shift();
    if (state.props.lit) {
      if (powered) {
        world.setBlock(pos, withProp(state, 'lit', false), F.ALL);
        if (isToggledTooFrequently(world, pos, true)) {
          world.scheduleTick(pos, world.getBlockState(pos).block, 160);
        }
      }
    } else if (!powered && !isToggledTooFrequently(world, pos, false)) {
      world.setBlock(pos, withProp(state, 'lit', true), F.ALL);
    }
  },
  neighborChanged(world, pos, state) {
    if (state.props.lit === this.hasNeighborSignal(world, pos, state) && !world.willTickThisTick(pos, this)) {
      world.scheduleTick(pos, this, 2);
    }
  },
};

defineBlock({
  ...torchBehavior,
  id: 'redstone_torch',
  properties: { lit: [true, false] },
  canSurvive(world, pos) {
    const below = world.getBlockState(pos.below());
    return below.block.faceSturdy(below, UP, 'center', world, pos.below());
  },
  updateShape(world, pos, state, dir) {
    return dir === DOWN && !this.canSurvive(world, pos, state) ? world.air : state;
  },
  hasNeighborSignal(world, pos) {
    return world.hasSignal(pos.below(), DOWN);
  },
  getSignal(world, pos, state, dir) {
    return state.props.lit && dir !== UP ? 15 : 0;
  },
});

defineBlock({
  ...torchBehavior,
  id: 'redstone_wall_torch',
  properties: { facing: HDIRS, lit: [true, false] },
  canSurvive(world, pos, state) {
    const facing = dirByName(state.props.facing);
    const attached = world.getBlockState(pos.rel(facing.opposite));
    return attached.block.faceSturdy(attached, facing, 'full', world, pos.rel(facing.opposite));
  },
  updateShape(world, pos, state, dir) {
    return dir.opposite.name === state.props.facing && !this.canSurvive(world, pos, state) ? world.air : state;
  },
  hasNeighborSignal(world, pos, state) {
    const d = dirByName(state.props.facing).opposite;
    return world.hasSignal(pos.rel(d), d);
  },
  getSignal(world, pos, state, dir) {
    return state.props.lit && state.props.facing !== dir.name ? 15 : 0;
  },
});

// ------------------------------------------------------------------ lever & buttons

function connectedDirection(state) {
  if (state.props.face === 'ceiling') return DOWN;
  if (state.props.face === 'floor') return UP;
  return dirByName(state.props.facing);
}

const attachedBehavior = {
  ...COMPONENT,
  properties: { face: ['floor', 'wall', 'ceiling'], facing: HDIRS, powered: [false, true] },
  defaults: { face: 'floor', facing: 'north' },
  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.powered ? 15 : 0; },
  canSurvive(world, pos, state) {
    const d = connectedDirection(state).opposite;
    const bp = pos.rel(d);
    const bs = world.getBlockState(bp);
    return bs.block.faceSturdy(bs, d.opposite, 'full', world, bp);
  },
  updateShape(world, pos, state, dir) {
    return connectedDirection(state).opposite === dir && !this.canSurvive(world, pos, state) ? world.air : state;
  },
  getSignal(world, pos, state) {
    return state.props.powered ? 15 : 0;
  },
  getDirectSignal(world, pos, state, dir) {
    return state.props.powered && connectedDirection(state) === dir ? 15 : 0;
  },
  updateNeighbours(world, pos, state) {
    world.updateNeighborsAt(pos, this);
    world.updateNeighborsAt(pos.rel(connectedDirection(state).opposite), this);
  },
  affectNeighborsAfterRemoval(world, pos, state, isMoving) {
    if (!isMoving && state.props.powered) this.updateNeighbours(world, pos, state);
  },
};

defineBlock({
  ...attachedBehavior,
  id: 'lever',
  glyph: 'L',
  color: 0x6b5a3a,
  use(world, pos, state) {
    const next = withProp(state, 'powered', !state.props.powered);
    world.setBlock(pos, next, F.ALL);
    this.updateNeighbours(world, pos, next);
    return true;
  },
});

function defineButton(id, pressTicks, color) {
  defineBlock({
    ...attachedBehavior,
    id,
    glyph: 'b',
    color,
    pressTicks,
    use(world, pos, state) {
      if (state.props.powered) return true;
      const next = withProp(state, 'powered', true);
      world.setBlock(pos, next, F.ALL);
      this.updateNeighbours(world, pos, next);
      world.scheduleTick(pos, this, this.pressTicks);
      return true;
    },
    tick(world, pos, state) {
      if (state.props.powered) {
        // no projectiles are simulated, so the button always releases
        world.setBlock(pos, withProp(state, 'powered', false), F.ALL);
        this.updateNeighbours(world, pos, state);
      }
    },
  });
}
defineButton('stone_button', 20, 0x8a8a8a);
defineButton('oak_button', 30, 0xa2834f);

// ------------------------------------------------------------------ lamp

defineBlock({
  id: 'redstone_lamp',
  glyph: 'O',
  color: 0x5a3a1e,
  properties: { lit: [false, true] },
  reportPower(world, pos, state) { return state.props.lit ? 15 : 0; },
  getStateForPlacement(world, pos) {
    return makeState(this, { lit: world.hasNeighborSignal(pos) });
  },
  neighborChanged(world, pos, state) {
    const lit = state.props.lit;
    if (lit !== world.hasNeighborSignal(pos)) {
      if (lit) world.scheduleTick(pos, this, 4);
      else world.setBlock(pos, withProp(state, 'lit', true), F.CLIENTS);
    }
  },
  tick(world, pos, state) {
    if (state.props.lit && !world.hasNeighborSignal(pos)) {
      world.setBlock(pos, withProp(state, 'lit', false), F.CLIENTS);
    }
  },
});

// ------------------------------------------------------------------ diodes

const diodeBehavior = {
  ...COMPONENT,
  isDiode: true,
  isSignalSource() { return true; },
  reportPower(world, pos, state) {
    return state.props.powered ? this.getOutputSignal(world, pos, state) : 0;
  },
  canSurvive(world, pos) {
    const below = world.getBlockState(pos.below());
    return below.block.faceSturdy(below, UP, 'rigid', world, pos.below());
  },
  facing(state) { return dirByName(state.props.facing); },
  isLocked() { return false; },
  // 1.21.2+: diodes pop on a shape update when they lose their support (not covered by captures yet)
  updateShape(world, pos, state, dir, neighborState, neighborPos) {
    if (dir === DOWN && !neighborState.block.faceSturdy(neighborState, UP, 'rigid', world, neighborPos)) return world.air;
    return this.updateShapeSides ? this.updateShapeSides(world, pos, state, dir) : state;
  },
  getOutputSignal() { return 15; },

  tick(world, pos, state) {
    if (!this.isLocked(world, pos, state)) {
      const on = state.props.powered;
      const shouldOn = this.shouldTurnOn(world, pos, state);
      if (on && !shouldOn) {
        world.setBlock(pos, withProp(state, 'powered', false), F.CLIENTS);
      } else if (!on) {
        world.setBlock(pos, withProp(state, 'powered', true), F.CLIENTS);
        if (!shouldOn) world.scheduleTick(pos, this, this.getDelay(state), PRIORITY.VERY_HIGH);
      }
    }
  },
  getDirectSignal(world, pos, state, dir) {
    return this.getSignal(world, pos, state, dir);
  },
  getSignal(world, pos, state, dir) {
    if (!state.props.powered) return 0;
    return state.props.facing === dir.name ? this.getOutputSignal(world, pos, state) : 0;
  },
  neighborChanged(world, pos, state) {
    if (this.canSurvive(world, pos, state)) {
      this.checkTickOnNeighbor(world, pos, state);
    } else {
      world.removeBlock(pos, false);
      for (const d of ALL) world.updateNeighborsAt(pos.rel(d), this);
    }
  },
  checkTickOnNeighbor(world, pos, state) {
    if (!this.isLocked(world, pos, state)) {
      const on = state.props.powered;
      const shouldOn = this.shouldTurnOn(world, pos, state);
      if (on !== shouldOn && !world.willTickThisTick(pos, this)) {
        let p = PRIORITY.HIGH;
        if (this.shouldPrioritize(world, pos, state)) p = PRIORITY.EXTREMELY_HIGH;
        else if (on) p = PRIORITY.VERY_HIGH;
        world.scheduleTick(pos, this, this.getDelay(state), p);
      }
    }
  },
  shouldTurnOn(world, pos, state) {
    return this.getInputSignal(world, pos, state) > 0;
  },
  getInputSignal(world, pos, state) {
    const d = this.facing(state);
    const bp = pos.rel(d);
    const i = world.getSignal(bp, d);
    if (i >= 15) return i;
    const bs = world.getBlockState(bp);
    return Math.max(i, bs.id === 'redstone_wire' ? bs.props.power : 0);
  },
  getAlternateSignal(world, pos, state) {
    const d = this.facing(state);
    const d1 = d.clockwise();
    const d2 = d.counterClockwise();
    const diodesOnly = this.sideInputDiodesOnly;
    return Math.max(
      world.getControlInputSignal(pos.rel(d1), d1, diodesOnly),
      world.getControlInputSignal(pos.rel(d2), d2, diodesOnly),
    );
  },
  shouldPrioritize(world, pos, state) {
    const d = this.facing(state).opposite;
    const bs = world.getBlockState(pos.rel(d));
    return bs.block.isDiode && bs.props.facing !== d.name;
  },
  updateNeighborsInFront(world, pos, state) {
    const d = this.facing(state);
    const bp = pos.rel(d.opposite);
    world.neighborChanged(bp, this, pos);
    world.updateNeighborsAtExceptFromFacing(bp, this, d);
  },
  onPlace(world, pos, state) {
    this.updateNeighborsInFront(world, pos, state);
  },
  affectNeighborsAfterRemoval(world, pos, state, isMoving) {
    if (!isMoving) this.updateNeighborsInFront(world, pos, state);
  },
  setPlacedBy(world, pos, state) {
    if (this.shouldTurnOn(world, pos, state)) world.scheduleTick(pos, this, 1);
  },
};

/** `out` is a convenience alias: the side the signal leaves from (vanilla `facing` is the input side). */
function diodeFacing(props) {
  const p = { ...props };
  if (p.out) {
    p.facing = dirByName(p.out).opposite.name;
    delete p.out;
  }
  return p;
}

defineBlock({
  ...diodeBehavior,
  id: 'repeater',
  glyph: '>',
  color: 0x9a9a9a,
  properties: { facing: HDIRS, delay: [1, 2, 3, 4], locked: [false, true], powered: [false, true] },
  sideInputDiodesOnly: true,
  getDelay(state) { return state.props.delay * 2; },
  isLocked(world, pos, state) { return this.getAlternateSignal(world, pos, state) > 0; },
  getStateForPlacement(world, pos, props) {
    const s = makeState(this, { ...diodeFacing(props), locked: false });
    return withProp(s, 'locked', this.isLocked(world, pos, s));
  },
  updateShapeSides(world, pos, state, dir) {
    if (dir.axis !== this.facing(state).axis) return withProp(state, 'locked', this.isLocked(world, pos, state));
    return state;
  },
  use(world, pos, state) {
    const d = state.props.delay;
    world.setBlock(pos, withProp(state, 'delay', d === 4 ? 1 : d + 1), F.ALL);
    return true;
  },
});

class ComparatorBlockEntity {
  constructor(pos, state) {
    this.type = 'comparator';
    this.pos = pos;
    this.state = state;
    this.output = 0;
    this.removed = false;
  }
  isValid(state) { return state.id === 'comparator'; }
  save() { return { output: this.output }; }
  load(data) { this.output = data.output ?? 0; }
}

defineBlock({
  ...diodeBehavior,
  id: 'comparator',
  glyph: 'C',
  color: 0xb0b0b0,
  properties: { facing: HDIRS, mode: ['compare', 'subtract'], powered: [false, true] },
  sideInputDiodesOnly: false,
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new ComparatorBlockEntity(pos, state); },
  getDelay() { return 2; },
  getStateForPlacement(world, pos, props) {
    return makeState(this, diodeFacing(props));
  },
  getOutputSignal(world, pos) {
    const be = world.getBlockEntity(pos);
    return be instanceof ComparatorBlockEntity ? be.output : 0;
  },
  reportPower(world, pos, state) {
    return this.getOutputSignal(world, pos, state);
  },
  calculateOutputSignal(world, pos, state) {
    const i = this.getInputSignal(world, pos, state);
    if (i === 0) return 0;
    const j = this.getAlternateSignal(world, pos, state);
    if (j > i) return 0;
    return state.props.mode === 'subtract' ? i - j : i;
  },
  shouldTurnOn(world, pos, state) {
    const i = this.getInputSignal(world, pos, state);
    if (i === 0) return false;
    const j = this.getAlternateSignal(world, pos, state);
    return i > j || (i === j && state.props.mode === 'compare');
  },
  getInputSignal(world, pos, state) {
    let i = diodeBehavior.getInputSignal.call(this, world, pos, state);
    const d = this.facing(state);
    let bp = pos.rel(d);
    let bs = world.getBlockState(bp);
    if (bs.block.hasAnalogOutput(bs)) {
      i = bs.block.getAnalogOutput(world, bp, bs);
    } else if (i < 15 && bs.block.isConductor(bs, world, bp)) {
      bp = bp.rel(d);
      bs = world.getBlockState(bp);
      if (bs.block.hasAnalogOutput(bs)) i = bs.block.getAnalogOutput(world, bp, bs);
    }
    return i;
  },
  checkTickOnNeighbor(world, pos, state) {
    if (!world.willTickThisTick(pos, this)) {
      const i = this.calculateOutputSignal(world, pos, state);
      const j = this.getOutputSignal(world, pos, state);
      if (i !== j || state.props.powered !== this.shouldTurnOn(world, pos, state)) {
        const p = this.shouldPrioritize(world, pos, state) ? PRIORITY.HIGH : PRIORITY.NORMAL;
        world.scheduleTick(pos, this, 2, p);
      }
    }
  },
  refreshOutputState(world, pos, state) {
    const i = this.calculateOutputSignal(world, pos, state);
    const be = world.getBlockEntity(pos);
    let j = 0;
    if (be instanceof ComparatorBlockEntity) {
      j = be.output;
      be.output = i;
      world.changed.add(pos.key);
    }
    if (j !== i || state.props.mode === 'compare') {
      const shouldOn = this.shouldTurnOn(world, pos, state);
      const on = state.props.powered;
      if (on && !shouldOn) world.setBlock(pos, withProp(state, 'powered', false), F.CLIENTS);
      else if (!on && shouldOn) world.setBlock(pos, withProp(state, 'powered', true), F.CLIENTS);
      this.updateNeighborsInFront(world, pos, state);
    }
  },
  tick(world, pos, state) {
    this.refreshOutputState(world, pos, state);
  },
  use(world, pos, state) {
    const next = withProp(state, 'mode', state.props.mode === 'compare' ? 'subtract' : 'compare');
    world.setBlock(pos, next, F.CLIENTS);
    this.refreshOutputState(world, pos, next);
    return true;
  },
});

// ------------------------------------------------------------------ observer

const observer = defineBlock({
  id: 'observer',
  glyph: 'V',
  color: 0x5c5c5c,
  properties: { facing: DIRS6, powered: [false, true] },
  defaults: { facing: 'south' },
  isConductor() { return false; },
  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.powered ? 15 : 0; },
  getStateForPlacement(world, pos, props) {
    const p = { ...props };
    if (p.out) {
      p.facing = dirByName(p.out).opposite.name;
      delete p.out;
    }
    return makeState(this, p);
  },
  tick(world, pos, state) {
    if (state.props.powered) {
      world.setBlock(pos, withProp(state, 'powered', false), F.CLIENTS);
    } else {
      world.setBlock(pos, withProp(state, 'powered', true), F.CLIENTS);
      world.scheduleTick(pos, this, 2);
    }
    this.updateNeighborsInFront(world, pos, state);
  },
  updateShape(world, pos, state, dir) {
    if (state.props.facing === dir.name && !state.props.powered) this.startSignal(world, pos);
    return state;
  },
  startSignal(world, pos) {
    if (!world.hasScheduledTick(pos, this)) world.scheduleTick(pos, this, 2);
  },
  updateNeighborsInFront(world, pos, state) {
    const d = dirByName(state.props.facing);
    const bp = pos.rel(d.opposite);
    world.neighborChanged(bp, this, pos);
    world.updateNeighborsAtExceptFromFacing(bp, this, d);
  },
  getDirectSignal(world, pos, state, dir) {
    return this.getSignal(world, pos, state, dir);
  },
  getSignal(world, pos, state, dir) {
    return state.props.powered && state.props.facing === dir.name ? 15 : 0;
  },
  onPlace(world, pos, state, oldState) {
    if (state.id !== oldState.id && state.props.powered && !world.hasScheduledTick(pos, this)) {
      const off = withProp(state, 'powered', false);
      world.setBlock(pos, off, F.CLIENTS | F.KNOWN_SHAPE);
      this.updateNeighborsInFront(world, pos, off);
    }
  },
  affectNeighborsAfterRemoval(world, pos, state) {
    if (state.props.powered && world.hasScheduledTick(pos, this)) {
      this.updateNeighborsInFront(world, pos, withProp(state, 'powered', false));
    }
  },
});

// ------------------------------------------------------------------ container

class ContainerBlockEntity {
  constructor(pos, state) {
    this.type = 'container';
    this.pos = pos;
    this.state = state;
    this.signal = 0;
    this.removed = false;
  }
  isValid(state) { return state.id === 'barrel'; }
  save() { return { signal: this.signal }; }
  load(data) { this.signal = data.signal ?? 0; }
}

/** Stand-in for any container: its comparator output (0-15) is set directly instead of via items. */
defineBlock({
  id: 'barrel',
  glyph: 'B',
  color: 0x7a5530,
  properties: { facing: DIRS6, open: [false, true] },
  defaults: { facing: 'up' },
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new ContainerBlockEntity(pos, state); },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos) {
    const be = world.getBlockEntity(pos);
    return be instanceof ContainerBlockEntity ? be.signal : 0;
  },
  reportPower(world, pos, state) { return this.getAnalogOutput(world, pos, state); },
  setSignal(world, pos, signal) {
    const be = world.getBlockEntity(pos);
    if (!(be instanceof ContainerBlockEntity)) return false;
    be.signal = Math.max(0, Math.min(15, signal | 0));
    world.changed.add(pos.key);
    world.updateNeighbourForOutputSignal(pos, this);
    return true;
  },
});

export { ComparatorBlockEntity, ContainerBlockEntity, observer, HORIZONTAL };
