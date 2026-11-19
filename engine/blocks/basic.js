// Non-redstone building blocks with the properties that matter for redstone.

import { defineBlock } from './base.js';
import { UP, DOWN } from '../dir.js';

defineBlock({
  id: 'air',
  isAir: true,
  glyph: '.',
  isConductor() { return false; },
  faceSturdy() { return false; },
  pushReaction() { return 'destroy'; },
});

// Ordinary full, opaque blocks: conductive, sturdy, pushable.
const SOLIDS = [
  ['stone', 0x8a8a8a],
  ['smooth_stone', 0xa0a0a0],
  ['cobblestone', 0x7a7a7a],
  ['white_concrete', 0xe0e4e5],
  ['gray_concrete', 0x3e4347],
  ['black_concrete', 0x101317],
  ['red_concrete', 0x8e2121],
  ['orange_concrete', 0xe06101],
  ['yellow_concrete', 0xf1af15],
  ['lime_concrete', 0x5ea819],
  ['green_concrete', 0x495b24],
  ['cyan_concrete', 0x157788],
  ['light_blue_concrete', 0x2389c7],
  ['blue_concrete', 0x2d2f8f],
  ['purple_concrete', 0x64209c],
  ['magenta_concrete', 0xa9309f],
  ['pink_concrete', 0xd5658f],
  ['brown_concrete', 0x603c20],
  ['white_wool', 0xeaeded],
  ['orange_wool', 0xf07613],
  ['magenta_wool', 0xbd44b3],
  ['light_blue_wool', 0x3aafd9],
  ['yellow_wool', 0xf8c627],
  ['lime_wool', 0x70b919],
  ['pink_wool', 0xed8dac],
  ['gray_wool', 0x3e4447],
  ['light_gray_wool', 0x8e8e86],
  ['cyan_wool', 0x158991],
  ['purple_wool', 0x792aac],
  ['blue_wool', 0x35399d],
  ['brown_wool', 0x724728],
  ['green_wool', 0x546d1b],
  ['red_wool', 0xa12722],
  ['black_wool', 0x141519],
  ['quartz_block', 0xece6df],
  ['chiseled_quartz_block', 0xe7e2d9],
  ['smooth_quartz', 0xebe5de],
  ['quartz_bricks', 0xeae5dd],
  ['iron_block', 0xdcdcdc],
  ['gold_block', 0xf6d03d],
  ['emerald_block', 0x2acb57],
  ['diamond_block', 0x62ede4],
  ['oak_planks', 0xa2834f],
  ['spruce_planks', 0x725430],
  ['birch_planks', 0xc0af79],
  ['dark_oak_planks', 0x422b14],
];
for (const [id, color] of SOLIDS) defineBlock({ id, color, glyph: '#' });

// Logs and wood: full blocks along an axis.
for (const [id, color] of [['oak_log', 0x6d5432], ['oak_wood', 0x6d5432], ['spruce_log', 0x3b2611], ['birch_log', 0xd8d7d2], ['dark_oak_log', 0x3c2e1a]]) {
  defineBlock({ id, color, glyph: '#', properties: { axis: ['y', 'x', 'z'] } });
}

// Target block: conductive, and emits its stored power (set by projectile hits, not simulated).
defineBlock({
  id: 'target',
  color: 0xe6c9b4,
  glyph: '#',
  properties: { power: [...Array(16).keys()] },
  isSignalSource() { return true; },
  getSignal(world, pos, state) { return state.props.power; },
});

defineBlock({ id: 'obsidian', color: 0x15101f, glyph: '#', pushReaction() { return 'block'; } });
defineBlock({ id: 'bedrock', color: 0x555555, glyph: '#', unbreakable: true });

// Glass: full, sturdy, but never a redstone conductor.
for (const [id, color] of [['glass', 0xc8e6f0], ['white_stained_glass', 0xf5f5f5]]) {
  defineBlock({ id, color, glyph: 'g', transparent: true, isConductor() { return false; } });
}

// Slabs are not conductors; only the full face is sturdy.
for (const [id, color] of [['smooth_stone_slab', 0xa8a8a8], ['stone_slab', 0x8f8f8f]]) {
  defineBlock({
    id,
    color,
    glyph: 's',
    properties: { type: ['bottom', 'top', 'double'], waterlogged: [false, true] },
    isConductor(state) { return state.props.type === 'double'; },
    faceSturdy(state, dir) {
      if (state.props.type === 'double') return true;
      if (state.props.type === 'top') return dir === UP;
      return dir === DOWN;
    },
  });
}

// Slime: conductive full block, sticky. Honey: sticky, not conductive, nothing sturdy.
defineBlock({ id: 'slime_block', color: 0x6fc05a, glyph: 'S', transparent: true, sticky: 'slime' });
defineBlock({
  id: 'honey_block',
  color: 0xf5a623,
  glyph: 'H',
  transparent: true,
  sticky: 'honey',
  isConductor() { return false; },
  faceSturdy() { return false; },
});
