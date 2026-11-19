// Ports of NoteBlock and DoorBlock (26.1.2).

import { defineBlock } from './base.js';
import { makeState, withProp } from '../state.js';
import { UP, DOWN, dirByName } from '../dir.js';
import { F } from '../world.js';
import { instrumentOf, INSTRUMENTS, MOB_HEAD_INSTRUMENTS } from './instruments.js';

// ------------------------------------------------------------------ note block

const worksAboveNoteBlock = (instrument) => MOB_HEAD_INSTRUMENTS.has(instrument);

defineBlock({
  id: 'note_block',
  glyph: 'n',
  color: 0x6b4630,
  properties: { instrument: INSTRUMENTS, note: [...Array(25).keys()], powered: [false, true] },
  /** NoteBlock.setInstrument: a mob head on top wins, else the block below (harp if that is a head). */
  withInstrument(world, pos, state) {
    const above = instrumentOf(world.getBlockState(pos.above()));
    if (worksAboveNoteBlock(above)) return withProp(state, 'instrument', above);
    const below = instrumentOf(world.getBlockState(pos.below()));
    return withProp(state, 'instrument', worksAboveNoteBlock(below) ? 'harp' : below);
  },
  getStateForPlacement(world, pos, props) {
    const s = makeState(this, props);
    return 'instrument' in props ? s : this.withInstrument(world, pos, s);
  },
  updateShape(world, pos, state, dir) {
    return dir.axis === 'y' ? this.withInstrument(world, pos, state) : state;
  },
  neighborChanged(world, pos, state) {
    const signal = world.hasNeighborSignal(pos);
    if (signal !== state.props.powered) {
      if (signal) this.playNote(world, pos, state);
      world.setBlock(pos, withProp(state, 'powered', signal), F.ALL);
    }
  },
  playNote(world, pos, state) {
    if (worksAboveNoteBlock(state.props.instrument) || world.getBlockState(pos.above()).block.isAir) {
      world.blockEvent(pos, this, 0, 0);
    }
  },
  /** useWithoutItem: tune one step up, then play. */
  use(world, pos, state) {
    const next = withProp(state, 'note', (state.props.note + 1) % 25);
    world.setBlock(pos, next, F.ALL);
    this.playNote(world, pos, next);
    return true;
  },
  /** The sound and particle; nothing in the world changes. */
  triggerEvent() { return true; },
  reportPower(world, pos, state) { return state.props.powered ? 1 : 0; },
});

// ------------------------------------------------------------------ doors

function door(id, color, byHand) {
  defineBlock({
    id,
    color,
    glyph: 'D',
    properties: {
      facing: ['north', 'south', 'west', 'east'],
      half: ['lower', 'upper'],
      hinge: ['left', 'right'],
      open: [false, true],
      powered: [false, true],
    },
    defaults: { half: 'lower' },
    canOpenByHand: byHand,
    isConductor() { return false; },
    pushReaction() { return 'destroy'; },
    reportPower() { return null; },
    /** The panel side: facing when closed, turned towards the hinge when open. Its far face is full. */
    faceSturdy(state, dir) {
      const f = dirByName(state.props.facing);
      const d = state.props.open ? (state.props.hinge === 'right' ? f.counterClockwise() : f.clockwise()) : f;
      return dir === d.opposite;
    },
    canSurvive(world, pos, state) {
      const below = world.getBlockState(pos.below());
      if (state.props.half === 'lower') return below.block.faceSturdy(below, UP, 'full');
      return below.block === this;
    },
    getStateForPlacement(world, pos, props) {
      if (props.half === 'upper') return makeState(this, props);
      const powered = world.hasNeighborSignal(pos) || world.hasNeighborSignal(pos.above());
      return makeState(this, { ...props, half: 'lower', powered, open: powered });
    },
    setPlacedBy(world, pos, state) {
      if (state.props.half === 'lower') world.setBlock(pos.above(), withProp(state, 'half', 'upper'), F.ALL);
    },
    updateShape(world, pos, state, dir, neighborState) {
      const half = state.props.half;
      if (dir.axis === 'y' && (half === 'lower') === (dir === UP)) {
        if (neighborState.block.isDoor && neighborState.props.half !== half) return withProp(neighborState, 'half', half);
        return world.air;
      }
      if (half === 'lower' && dir === DOWN && !this.canSurvive(world, pos, state)) return world.air;
      return state;
    },
    isDoor: true,
    neighborChanged(world, pos, state, sourceBlock) {
      const other = pos.rel(state.props.half === 'lower' ? UP : DOWN);
      const signal = world.hasNeighborSignal(pos) || world.hasNeighborSignal(other);
      if (sourceBlock !== this && signal !== state.props.powered) {
        world.setBlock(pos, withProp(withProp(state, 'powered', signal), 'open', signal), F.CLIENTS);
      }
    },
    use(world, pos, state) {
      if (!byHand) return false;
      world.setBlock(pos, withProp(state, 'open', !state.props.open), F.CLIENTS | F.IMMEDIATE);
      return true;
    },
  });
}

for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak']) {
  door(`${wood}_door`, 0x9c7a4a, true);
}
door('iron_door', 0xcfcfcf, false);
