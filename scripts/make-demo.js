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

sim.step(4);
console.log('saved', sim.save('demo'));
process.exit(0);
