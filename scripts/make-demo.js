// Builds designs/demo.json: a small showcase of every component.
// Run: node scripts/make-demo.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../server/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sim = new Simulation({ designsDir: path.join(ROOT, 'designs') });
sim.setRunning(false);
sim.newWorld({ floor: 24 });
const put = (x, y, z, b) => sim.setBlock(x, y, z, b);

// 1) lever -> dust -> repeater (delay 4) -> dust -> lamp
put(2, 1, 2, 'lever');
for (let x = 3; x <= 6; x++) put(x, 1, 2, 'redstone_wire');
put(7, 1, 2, 'repeater[out=east,delay=4]');
for (let x = 8; x <= 10; x++) put(x, 1, 2, 'redstone_wire');
put(11, 1, 2, 'redstone_lamp');

// 2) torch inverter driving a lamp
put(2, 1, 6, 'lever');
put(3, 1, 6, 'stone');
put(4, 1, 6, 'redstone_wall_torch[facing=east]');
put(5, 1, 6, 'redstone_wire');
put(6, 1, 6, 'redstone_lamp');

// 3) observer clock driving a sticky piston that moves a slime block
put(2, 1, 10, 'observer[facing=east]');
put(3, 1, 10, 'observer[facing=west]');
put(4, 1, 10, 'redstone_wire');
put(5, 1, 10, 'sticky_piston[facing=east]');
put(6, 1, 10, 'white_concrete');

// 4) comparator subtracting a side input from a container
put(2, 1, 14, 'barrel');
sim.setSignal(2, 1, 14, 12);
put(3, 1, 14, 'comparator[out=east,mode=subtract]');
for (let x = 4; x <= 8; x++) put(x, 1, 14, 'redstone_wire');
put(3, 1, 16, 'lever');
put(3, 1, 15, 'repeater[out=north,delay=1]');

// 5) piston pushing a row of blocks via a button
put(2, 1, 19, 'stone_button[face=floor]');
put(3, 1, 19, 'piston[facing=east]');
for (let x = 4; x <= 8; x++) put(x, 1, 19, ['red_concrete', 'orange_concrete', 'yellow_concrete', 'lime_concrete', 'light_blue_concrete'][x - 4]);

// 6) a chest drained by two hoppers into another chest; a comparator reads it into a lamp
put(14, 1, 3, 'hopper[facing=east]');
put(14, 2, 3, 'chest[facing=south]');
sim.setItems(14, 2, 3, [{ slot: 0, id: 'cobblestone', count: 64 }, { slot: 1, id: 'cobblestone', count: 64 }]);
put(15, 1, 3, 'hopper[facing=east]');
put(16, 1, 3, 'chest[facing=south]');
put(17, 1, 3, 'comparator[out=east]');
put(18, 1, 3, 'redstone_lamp');

// 7) a lever fires a dropper into a hopper that fills a chest
put(13, 1, 7, 'lever');
put(14, 1, 7, 'dropper[facing=east]');
sim.setItems(14, 1, 7, [{ slot: 4, id: 'redstone', count: 16 }]);
put(15, 1, 7, 'hopper[facing=east]');
put(16, 1, 7, 'chest[facing=south]');

// 8) note blocks: a button plays one (basedrum: stone below it), use tunes it
put(13, 1, 11, 'stone_button[face=floor]');
put(14, 1, 11, 'note_block');
put(16, 1, 11, 'oak_button[face=floor]');
put(17, 1, 11, 'note_block[note=12]');

// 9) doors: a lever opens an oak door, a button an iron door
put(13, 1, 15, 'lever');
put(14, 1, 15, 'oak_door[facing=east]');
put(17, 1, 15, 'stone_button[face=floor]');
put(16, 1, 15, 'iron_door[facing=east]');

sim.step(4);
console.log('saved', sim.save('demo'));
process.exit(0);
