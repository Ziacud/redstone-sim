// Engine entry point: registers every block, then exposes the world API.

import './blocks/basic.js';
import './blocks/wire.js';
import './blocks/components.js';
import './blocks/piston.js';
import './blocks/farm.js';
import './blocks/trapdoor.js';
import './blocks/noteblock.js';
import './blocks/containers.js';

export { World, F, PRIORITY, MIN_Y, MAX_Y } from './world.js';
export { Pos, pos, dirByName, ALL, HORIZONTAL } from './dir.js';
export { getBlock, hasBlock, allBlocks, makeState, parseBlockString, withProp } from './state.js';
export { PistonMovingBlockEntity } from './blocks/piston.js';
