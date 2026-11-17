// Default block behavior (BlockBehaviour) that concrete blocks override.

import { registerBlock, makeState } from '../state.js';

export const BaseBlock = {
  isAir: false,
  isDiode: false,
  glyph: '#',
  color: 0x888888,

  /** BlockState.isRedstoneConductor */
  isConductor(state, world, pos) { return true; },
  isSignalSource(state) { return false; },
  getSignal(world, pos, state, dir) { return 0; },
  getDirectSignal(world, pos, state, dir) { return 0; },
  hasAnalogOutput(state) { return false; },
  getAnalogOutput(world, pos, state) { return 0; },

  /** isFaceSturdy(dir, type) with type 'full' | 'center' | 'rigid' */
  faceSturdy(state, dir, type = 'full') { return true; },
  /** 'normal' | 'destroy' | 'block' | 'push_only' */
  pushReaction(state) { return 'normal'; },
  /** Unbreakable blocks (destroy speed -1) cannot be pushed. */
  unbreakable: false,
  hasBlockEntity(state) { return false; },

  canSurvive(world, pos, state) { return true; },
  neighborChanged(world, pos, state, sourceBlock, sourcePos, movedByPiston) {},
  updateShape(world, pos, state, dir, neighborState, neighborPos) { return state; },
  updateIndirectNeighbourShapes(world, pos, state, flags, recursionLeft) {},
  onPlace(world, pos, state, oldState, isMoving) {},
  /** Runs only when the block type changes (1.21.5+ replacement of onRemove). */
  affectNeighborsAfterRemoval(world, pos, state, movedByPiston) {},
  tick(world, pos, state) {},
  triggerEvent(world, pos, state, a, b) { return false; },
  use(world, pos, state) { return false; },
  getStateForPlacement(world, pos, props) { return makeState(this, props); },
  setPlacedBy(world, pos, state) {},

  /** Value a probe shows: for conductors, how strongly the block is powered. */
  reportPower(world, pos, state) {
    return this.isConductor(state, world, pos) ? world.getDirectSignalTo(pos) : null;
  },
};

export function defineBlock(def) {
  return registerBlock(Object.assign(Object.create(BaseBlock), def));
}

/** Shorthand for a non-solid component that sits on another block. */
export const COMPONENT = {
  isConductor() { return false; },
  faceSturdy() { return false; },
  pushReaction() { return 'destroy'; },
};
