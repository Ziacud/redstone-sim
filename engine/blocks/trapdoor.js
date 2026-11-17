// Port of TrapDoorBlock: opens/closes when its neighbor power changes (no delay), or by hand.

import { defineBlock } from './base.js';
import { withProp } from '../state.js';
import { UP, DOWN } from '../dir.js';
import { F } from '../world.js';

const OPEN_FACE = { north: 'south', south: 'north', east: 'west', west: 'east' };

function trapdoor(id, color, byHand) {
  defineBlock({
    id,
    color,
    glyph: 't',
    properties: {
      facing: ['north', 'south', 'west', 'east'],
      half: ['bottom', 'top'],
      open: [false, true],
      powered: [false, true],
      waterlogged: [false, true],
    },
    isConductor() { return false; },
    reportPower() { return null; },
    /** A closed trapdoor is a 3/16 slab on its half; an open one hugs the side opposite `facing`. */
    faceSturdy(state, dir, type = 'full') {
      if (!state.props.open) return state.props.half === 'top' ? dir === UP : dir === DOWN;
      return dir.name === OPEN_FACE[state.props.facing];
    },
    neighborChanged(world, pos, state) {
      const powered = world.hasNeighborSignal(pos);
      if (powered !== state.props.powered) {
        let s = state;
        if (s.props.open !== powered) s = withProp(s, 'open', powered);
        world.setBlock(pos, withProp(s, 'powered', powered), F.CLIENTS);
      }
    },
    use(world, pos, state) {
      if (!byHand) return false;
      world.setBlock(pos, withProp(state, 'open', !state.props.open), F.CLIENTS);
      return true;
    },
  });
}

for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak']) {
  trapdoor(`${wood}_trapdoor`, 0x9c7a4a, true);
}
trapdoor('iron_trapdoor', 0xcfcfcf, false);
