// Port of RedStoneWireBlock (Java Edition, redstone experiments off).

import { defineBlock, COMPONENT } from './base.js';
import { makeState, withProp, withProps } from '../state.js';
import { ALL, HORIZONTAL, VERTICAL, UP, DOWN } from '../dir.js';
import { JavaPosSet } from '../javahash.js';
import { F } from '../world.js';

const SIDES = ['none', 'side', 'up'];
const isConnected = (side) => side !== 'none';

const wire = defineBlock({
  id: 'redstone_wire',
  glyph: '+',
  color: 0xff0000,
  ...COMPONENT,
  properties: {
    north: SIDES,
    east: SIDES,
    south: SIDES,
    west: SIDES,
    power: [...Array(16).keys()],
  },

  isSignalSource() { return true; },
  reportPower(world, pos, state) { return state.props.power; },

  canSurvive(world, pos) {
    const bp = pos.below();
    return canSurviveOn(world, bp, world.getBlockState(bp));
  },

  getStateForPlacement(world, pos) {
    return getConnectionState(world, crossState(), pos);
  },

  getDirectSignal(world, pos, state, dir) {
    return !world.wireShouldSignal ? 0 : this.getSignal(world, pos, state, dir);
  },

  getSignal(world, pos, state, dir) {
    if (world.wireShouldSignal && dir !== DOWN) {
      const i = state.props.power;
      if (i === 0) return 0;
      if (dir !== UP && !isConnected(getConnectionState(world, state, pos).props[dir.opposite.name])) return 0;
      return i;
    }
    return 0;
  },

  updateShape(world, pos, state, dir, neighborState, neighborPos) {
    // 1.21.2+: dust pops on a shape update when it loses its support (not covered by captures yet)
    if (dir === DOWN) return canSurviveOn(world, neighborPos, neighborState) ? state : world.air;
    if (dir === UP) return getConnectionState(world, state, pos);
    const side = getConnectingSide(world, pos, dir);
    if (isConnected(side) === isConnected(state.props[dir.name]) && !isCross(state)) {
      return withProp(state, dir.name, side);
    }
    return getConnectionState(
      world,
      withProps(crossState(), { power: state.props.power, [dir.name]: side }),
      pos,
    );
  },

  updateIndirectNeighbourShapes(world, pos, state, flags, recursionLeft) {
    for (const d of HORIZONTAL) {
      const side = state.props[d.name];
      if (side !== 'none' && world.getBlockState(pos.rel(d)).id !== 'redstone_wire') {
        const below = pos.rel(d).below();
        if (world.getBlockState(below).id === 'redstone_wire') {
          const bp = below.rel(d.opposite);
          world.neighborShapeChanged(d.opposite, world.getBlockState(bp), below, bp, flags, recursionLeft);
        }
        const above = pos.rel(d).above();
        if (world.getBlockState(above).id === 'redstone_wire') {
          const bp = above.rel(d.opposite);
          world.neighborShapeChanged(d.opposite, world.getBlockState(bp), above, bp, flags, recursionLeft);
        }
      }
    }
  },

  onPlace(world, pos, state, oldState) {
    if (oldState.id !== 'redstone_wire') {
      updatePowerStrength(world, pos, state);
      for (const d of VERTICAL) world.updateNeighborsAt(pos.rel(d), wire);
      updateNeighborsOfNeighboringWires(world, pos);
    }
  },

  affectNeighborsAfterRemoval(world, pos, state, isMoving) {
    if (!isMoving) {
      for (const d of ALL) world.updateNeighborsAt(pos.rel(d), wire);
      updatePowerStrength(world, pos, state);
      updateNeighborsOfNeighboringWires(world, pos);
    }
  },

  neighborChanged(world, pos, state) {
    if (this.canSurvive(world, pos, state)) {
      updatePowerStrength(world, pos, state);
    } else {
      world.removeBlock(pos, false);
    }
  },

  /** Right-click toggles between dot and cross when unconnected. */
  use(world, pos, state) {
    if (isCross(state) || isDot(state)) {
      let next = isCross(state) ? wire.defaultState : crossState();
      next = withProp(next, 'power', state.props.power);
      next = getConnectionState(world, next, pos);
      if (next !== state) {
        world.setBlock(pos, next, F.ALL);
        updatesOnShapeChange(world, pos, state, next);
        return true;
      }
    }
    return false;
  },
});

let CROSS = null; // interned, so always the same state
function crossState() {
  return (CROSS ??= makeState(wire, { north: 'side', east: 'side', south: 'side', west: 'side' }));
}

function isCross(state) {
  return HORIZONTAL.every((d) => isConnected(state.props[d.name]));
}

function isDot(state) {
  return HORIZONTAL.every((d) => !isConnected(state.props[d.name]));
}

function canSurviveOn(world, pos, state) {
  return state.block.faceSturdy(state, UP, 'full', world, pos) || state.id === 'hopper';
}

function getConnectionState(world, state, pos) {
  const wasDot = isDot(state);
  let s = getMissingConnections(world, withProp(wire.defaultState, 'power', state.props.power), pos);
  if (wasDot && isDot(s)) return s;
  const n = isConnected(s.props.north);
  const so = isConnected(s.props.south);
  const e = isConnected(s.props.east);
  const w = isConnected(s.props.west);
  const noNS = !n && !so;
  const noEW = !e && !w;
  if (!w && noNS) s = withProp(s, 'west', 'side');
  if (!e && noNS) s = withProp(s, 'east', 'side');
  if (!n && noEW) s = withProp(s, 'north', 'side');
  if (!so && noEW) s = withProp(s, 'south', 'side');
  return s;
}

function getMissingConnections(world, state, pos) {
  const above = world.getBlockState(pos.above());
  // vanilla passes `pos` (not pos.above()) here; irrelevant for the blocks we simulate
  const nonConductorAbove = !above.block.isConductor(above, world, pos);
  let s = state;
  for (const d of HORIZONTAL) {
    if (!isConnected(s.props[d.name])) {
      s = withProp(s, d.name, getConnectingSideWith(world, pos, d, nonConductorAbove));
    }
  }
  return s;
}

function getConnectingSide(world, pos, dir) {
  const above = world.getBlockState(pos.above());
  return getConnectingSideWith(world, pos, dir, !above.block.isConductor(above, world, pos));
}

function getConnectingSideWith(world, pos, dir, nonConductorAbove) {
  const bp = pos.rel(dir);
  const bs = world.getBlockState(bp);
  if (nonConductorAbove) {
    const supports = canSurviveOn(world, bp, bs);
    if (supports && shouldConnectTo(world.getBlockState(bp.above()), null)) {
      return bs.block.faceSturdy(bs, dir.opposite, 'full', world, bp) ? 'up' : 'side';
    }
  }
  if (
    !shouldConnectTo(bs, dir) &&
    (bs.block.isConductor(bs, world, bp) || !shouldConnectTo(world.getBlockState(bp.below()), null))
  ) {
    return 'none';
  }
  return 'side';
}

/** RedStoneWireBlock.shouldConnectTo(state, direction) */
function shouldConnectTo(state, dir) {
  if (state.id === 'redstone_wire') return true;
  if (state.id === 'repeater') {
    const f = state.props.facing;
    return dir !== null && (f === dir.name || f === dir.opposite.name);
  }
  if (state.id === 'observer') return dir !== null && state.props.facing === dir.name;
  return state.block.isSignalSource(state) && dir !== null;
}

function getWireSignal(state) {
  return state.id === 'redstone_wire' ? state.props.power : 0;
}

function calculateTargetStrength(world, pos) {
  world.wireShouldSignal = false;
  const i = world.getBestNeighborSignal(pos);
  world.wireShouldSignal = true;
  let j = 0;
  if (i < 15) {
    const above = pos.above();
    const aboveState = world.getBlockState(above);
    const aboveConducts = aboveState.block.isConductor(aboveState, world, above);
    for (const d of HORIZONTAL) {
      const bp = pos.rel(d);
      const bs = world.getBlockState(bp);
      j = Math.max(j, getWireSignal(bs));
      const conducts = bs.block.isConductor(bs, world, bp);
      if (conducts && !aboveConducts) {
        j = Math.max(j, getWireSignal(world.getBlockState(bp.above())));
      } else if (!conducts) {
        j = Math.max(j, getWireSignal(world.getBlockState(bp.below())));
      }
    }
  }
  return Math.max(i, j - 1);
}

function updatePowerStrength(world, pos, state) {
  const i = calculateTargetStrength(world, pos);
  if (state.props.power !== i) {
    if (world.getBlockState(pos) === state) world.setBlock(pos, withProp(state, 'power', i), F.CLIENTS);
    const set = new JavaPosSet();
    set.add(pos);
    for (const d of ALL) set.add(pos.rel(d));
    // the set is local and complete here, so a snapshot iterates exactly like the set
    for (const bp of set.toArray()) world.updateNeighborsAt(bp, wire);
  }
}

function checkCornerChangeAt(world, pos) {
  if (world.getBlockState(pos).id === 'redstone_wire') {
    world.updateNeighborsAt(pos, wire);
    for (const d of ALL) world.updateNeighborsAt(pos.rel(d), wire);
  }
}

function updateNeighborsOfNeighboringWires(world, pos) {
  for (const d of HORIZONTAL) checkCornerChangeAt(world, pos.rel(d));
  for (const d of HORIZONTAL) {
    const bp = pos.rel(d);
    const bs = world.getBlockState(bp);
    if (bs.block.isConductor(bs, world, bp)) checkCornerChangeAt(world, bp.above());
    else checkCornerChangeAt(world, bp.below());
  }
}

function updatesOnShapeChange(world, pos, oldState, newState) {
  for (const d of HORIZONTAL) {
    const bp = pos.rel(d);
    const bs = world.getBlockState(bp);
    if (isConnected(oldState.props[d.name]) !== isConnected(newState.props[d.name]) && bs.block.isConductor(bs, world, bp)) {
      world.updateNeighborsAtExceptFromFacing(bp, newState.block, d.opposite);
    }
  }
}

export { getConnectionState as wireConnectionState };
