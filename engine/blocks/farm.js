// Copper bulbs (CopperBulbBlock) and the farming blocks a sugar cane farm needs.
// Water is a static source block: fluid flow is not simulated.

import { defineBlock, COMPONENT } from './base.js';
import { withProp, getBlock } from '../state.js';
import { HORIZONTAL, UP, Pos } from '../dir.js';
import { F } from '../world.js';

// ------------------------------------------------------------------ copper bulb

/** checkAndFlip: a rising edge of neighbor power toggles `lit`; no delay in 26.3. */
function checkAndFlip(world, pos, state) {
  const powered = world.hasNeighborSignal(pos);
  if (powered === state.props.powered) return;
  let s = state;
  if (!state.props.powered) s = withProp(s, 'lit', !s.props.lit);
  world.setBlock(pos, withProp(s, 'powered', powered), F.ALL);
}

const BULBS = [
  ['copper_bulb', 0xc7714a],
  ['exposed_copper_bulb', 0xa97f5c],
  ['weathered_copper_bulb', 0x6c9e72],
  ['oxidized_copper_bulb', 0x4fa58f],
];
for (const [id, color] of BULBS) {
  for (const prefix of ['', 'waxed_']) {
    defineBlock({
      id: prefix + id,
      glyph: 'U',
      color,
      isCopperBulb: true,
      properties: { lit: [false, true], powered: [false, true] },
      isConductor() { return false; },
      hasAnalogOutput() { return true; },
      getAnalogOutput(world, pos, state) { return state.props.lit ? 15 : 0; },
      reportPower(world, pos, state) { return state.props.lit ? 15 : 0; },
      onPlace(world, pos, state, oldState) {
        if (oldState.id !== state.id) checkAndFlip(world, pos, state);
      },
      neighborChanged(world, pos, state) {
        checkAndFlip(world, pos, state);
      },
    });
  }
}

// ------------------------------------------------------------------ soil and water

for (const [id, color] of [['dirt', 0x86603e], ['grass_block', 0x6a9a3c], ['sand', 0xdbcf96]]) {
  defineBlock({ id, color, glyph: '#', soil: true });
}

defineBlock({
  id: 'water',
  glyph: '~',
  color: 0x3060d0,
  properties: { level: [...Array(16).keys()] },
  isConductor() { return false; },
  faceSturdy() { return false; },
  pushReaction() { return 'destroy'; },
  reportPower() { return null; },
});

// ------------------------------------------------------------------ sugar cane

const cane = defineBlock({
  id: 'sugar_cane',
  glyph: '|',
  color: 0x8ac46a,
  ...COMPONENT,
  properties: { age: [...Array(16).keys()] },
  reportPower() { return null; },
  canSurvive(world, pos) {
    const below = world.getBlockState(pos.below());
    if (below.id === 'sugar_cane') return true;
    if (!below.block.soil) return false;
    return HORIZONTAL.some((d) => world.getBlockState(pos.below().rel(d)).id === 'water');
  },
  /** SugarCaneBlock.updateShape: losing support schedules a 1 gt tick instead of popping at once. */
  updateShape(world, pos, state) {
    if (!this.canSurvive(world, pos, state)) world.scheduleTick(pos, cane, 1);
    return state;
  },
  tick(world, pos, state) {
    if (!this.canSurvive(world, pos, state)) world.destroyBlock(pos, true);
  },
  /** SugarCaneBlock.randomTick: grows a block on the 16th tick, up to 3 tall. */
  randomTick(world, pos, state) {
    if (!world.getBlockState(pos.above()).block.isAir) return;
    let h = 1;
    while (world.getBlockState(pos.below(h)).id === 'sugar_cane') h++;
    if (h >= 3) return;
    const age = state.props.age;
    if (age === 15) {
      world.setBlock(pos.above(), cane.defaultState, F.ALL);
      world.setBlock(pos, withProp(state, 'age', 0), F.INVISIBLE);
    } else world.setBlock(pos, withProp(state, 'age', age + 1), F.INVISIBLE);
  },
});

// ------------------------------------------------------------------ melons and pumpkins
// Gourds and stems are destroyed when pushed (PushReaction.DESTROY); gourds are full conductive
// blocks, stems and farmland are not conductors (farmland is 15/16 high). Random ticks (World:
// randomTickSpeed > 0) grow stems and place gourds as StemBlock does; the simulator has no light
// engine, so stems see world.assumedBrightness.

const DIRT_TAG = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'moss_block', 'mud']);

/** FarmBlock.isNearWater: water within 4 blocks, at the farmland's level or one above. */
function nearWater(world, pos) {
  for (let dx = -4; dx <= 4; dx++)
    for (let dz = -4; dz <= 4; dz++)
      for (let dy = 0; dy <= 1; dy++)
        if (world.getBlockState(new Pos(pos.x + dx, pos.y + dy, pos.z + dz)).id === 'water') return true;
  return false;
}
const farmlandOk = (world, pos) => {
  const above = world.getBlockState(pos.above());
  // FarmBlock.canSurvive: nothing solid on top (a moving piston or a fence gate is fine)
  const solid = !above.block.isAir && (above.block.isConductor(above, world, pos.above()) || above.block.faceSturdy(above, UP));
  return !solid || above.id === 'moving_piston';
};
const farmland = defineBlock({
  id: 'farmland',
  glyph: '=',
  color: 0x5a3a1c,
  soil: true,
  properties: { moisture: [...Array(8).keys()] },
  isConductor() { return false; },
  faceSturdy(state, dir) { return dir !== UP; },
  updateShape(world, pos, state, dir) {
    if (dir === UP && !farmlandOk(world, pos)) world.scheduleTick(pos, farmland, 1);
    return state;
  },
  tick(world, pos) {
    if (!farmlandOk(world, pos)) world.setBlock(pos, getBlock('dirt').defaultState, F.ALL);
  },
  /** FarmBlock.randomTick: wet near water, otherwise dries; bare dry farmland turns to dirt. */
  randomTick(world, pos, state) {
    const m = state.props.moisture;
    if (!nearWater(world, pos)) {
      if (m > 0) world.setBlock(pos, withProp(state, 'moisture', m - 1), F.CLIENTS);
      else if (!world.getBlockState(pos.above()).block.maintainsFarmland) world.setBlock(pos, getBlock('dirt').defaultState, F.ALL);
    } else if (m < 7) world.setBlock(pos, withProp(state, 'moisture', 7), F.CLIENTS);
  },
});

for (const [id, color] of [['melon', 0x7fb238], ['pumpkin', 0xe38a1d]]) {
  defineBlock({ id, color, glyph: 'O', pushReaction() { return 'destroy'; } });
}

/** CropBlock.getGrowthSpeed: farmland under and around (wet 3, dry 1, neighbours a quarter), halved
 * by the same crop on two sides (a row both ways) or on a diagonal. */
export function growthSpeed(world, pos, id) {
  let f = 1;
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) {
      const s = world.getBlockState(new Pos(pos.x + i, pos.y - 1, pos.z + j));
      let g = 0;
      if (s.id === 'farmland') g = s.props.moisture > 0 ? 3 : 1;
      if (i !== 0 || j !== 0) g /= 4;
      f += g;
    }
  const is = (dx, dz) => world.getBlockState(new Pos(pos.x + dx, pos.y, pos.z + dz)).id === id;
  const ew = is(-1, 0) || is(1, 0);
  const ns = is(0, -1) || is(0, 1);
  if (ew && ns) f /= 2;
  else if (is(-1, -1) || is(1, -1) || is(1, 1) || is(-1, 1)) f /= 2;
  return f;
}

for (const [kind, color] of [['melon', 0x6b8f30], ['pumpkin', 0x8f7a30]]) {
  const stemId = `${kind}_stem`;
  const attachedId = `attached_${kind}_stem`;
  defineBlock({
    id: stemId, color, glyph: 't', ...COMPONENT, maintainsFarmland: true,
    properties: { age: [...Array(8).keys()] },
    reportPower() { return null; },
    /** StemBlock.randomTick: grow to age 7, then try a random side for a gourd. */
    randomTick(world, pos, state) {
      if (world.assumedBrightness < 9) return;
      const f = growthSpeed(world, pos, stemId);
      if (world.random.nextInt(Math.floor(25 / f) + 1) !== 0) return;
      const age = state.props.age;
      if (age < 7) {
        world.setBlock(pos, withProp(state, 'age', age + 1), F.CLIENTS);
        return;
      }
      const dir = HORIZONTAL[world.random.nextInt(4)];
      const p = pos.rel(dir);
      const below = world.getBlockState(p.below());
      if (world.getBlockState(p).block.isAir && (below.id === 'farmland' || DIRT_TAG.has(below.id))) {
        world.setBlock(p, getBlock(kind).defaultState, F.ALL);
        world.setBlock(pos, withProp(getBlock(attachedId).defaultState, 'facing', dir.name), F.ALL);
        world.gourdsGrown = (world.gourdsGrown ?? 0) + 1;
      }
    },
  });
  defineBlock({
    id: attachedId, color, glyph: 't', ...COMPONENT, maintainsFarmland: true,
    properties: { facing: ['north', 'south', 'west', 'east'] },
    reportPower() { return null; },
    /** AttachedStemBlock.updateShape: without its gourd it is a full-grown stem again. */
    updateShape(world, pos, state, dir, neighborState) {
      if (dir.name === state.props.facing && neighborState.id !== kind) return withProp(getBlock(stemId).defaultState, 'age', 7);
      return state;
    },
  });
}
