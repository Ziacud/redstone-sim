// Builds the small example designs (designs/example-*.json) and checks that each one works.
// Run: node scripts/make-examples.js

import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../server/sim.js';
import { pos as posOf, getBlock, parseBlockString, makeState } from '../engine/index.js';

const stateOf = (str) => {
  const { id, props } = parseBlockString(str);
  return makeState(getBlock(id), props);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sim = new Simulation({ designsDir: path.join(ROOT, 'designs') });
sim.setRunning(false);
const put = (x, y, z, b) => sim.setBlock(x, y, z, b);
const id = (x, y, z) => sim.world.getBlockState({ x, y, z }).id;
const prop = (x, y, z, k) => sim.world.getBlockState({ x, y, z }).props[k];
const fresh = () => sim.newWorld({ floor: 16 });
const save = (name) => console.log('saved', sim.save(name) ?? name);

// ---- T flip-flop: a copper bulb toggles on every rising edge; a comparator reads 15 when it is lit
fresh();
put(3, 1, 4, 'stone_button[face=floor,facing=east]');
put(4, 1, 4, 'copper_bulb');
put(5, 1, 4, 'comparator[out=east]');
for (let x = 6; x <= 8; x++) put(x, 1, 4, 'redstone_wire');
put(9, 1, 4, 'sticky_piston[facing=east]');
put(10, 1, 4, 'white_concrete');
put(9, 1, 6, 'redstone_lamp');
put(9, 1, 5, 'redstone_wire');
sim.step(2);
sim.use(3, 1, 4);
sim.step(30);
assert.equal(prop(4, 1, 4, 'lit'), true, 'bulb on after the first press');
assert.equal(prop(9, 1, 4, 'extended'), true, 'piston out');
sim.use(3, 1, 4);
sim.step(30);
assert.equal(prop(4, 1, 4, 'lit'), false, 'bulb off after the second press');
assert.equal(prop(9, 1, 4, 'extended'), false, 'piston back');
save('example-t-flip-flop');

// ---- quasi-connectivity: a lever beside the space above a piston powers it, but the piston only
// notices on its next block update (a BUD). Flip the lever, then place a block next to the piston.
const bud = () => {
  fresh();
  put(4, 1, 4, 'piston[facing=east]');
  put(4, 2, 5, 'stone');
  put(4, 3, 5, 'lever[face=floor,facing=east]');
  put(6, 1, 4, 'red_concrete');
  sim.step(2);
};
bud();
sim.use(4, 3, 5); // powers (4,2,5), so the piston counts as powered via QC, but it gets no update
sim.step(10);
assert.equal(prop(4, 1, 4, 'extended'), false, 'BUD: the lever alone does not fire the piston');
put(3, 1, 4, 'stone'); // a block update next to the piston
sim.step(10);
assert.equal(prop(4, 1, 4, 'extended'), true, 'the update fires it');
bud();
save('example-bud');

// ---- memory: a locked repeater keeps its output while the side repeater locks it
fresh();
put(2, 1, 4, 'lever');
for (let x = 3; x <= 4; x++) put(x, 1, 4, 'redstone_wire');
put(5, 1, 4, 'repeater[out=east,delay=1]');
for (let x = 6; x <= 7; x++) put(x, 1, 4, 'redstone_wire');
put(8, 1, 4, 'redstone_lamp');
put(5, 1, 7, 'lever');
put(5, 1, 6, 'redstone_wire');
put(5, 1, 5, 'repeater[out=north,delay=1]');
sim.step(2);
sim.use(2, 1, 4); // data on
sim.step(6);
assert.equal(prop(8, 1, 4, 'lit'), true);
sim.use(5, 1, 7); // lock
sim.step(6);
sim.use(2, 1, 4); // data off: the locked repeater keeps it
sim.step(10);
assert.equal(prop(8, 1, 4, 'lit'), true, 'locked repeater holds its output');
sim.use(5, 1, 7); // unlock: follows the input again
sim.step(10);
assert.equal(prop(8, 1, 4, 'lit'), false, 'unlocked repeater follows the input');
save('example-repeater-lock');

// ---- flying machine (found by a brute-force search in this simulator): two sticky pistons back to
// back, two observers, four slime blocks. A block placed in front of the west observer starts it;
// it flies east and stops, intact, at the obsidian wall. The design is saved with that observer's
// pulse already scheduled, so it starts as soon as it is loaded (load it again to restart).
sim.newWorld({ floor: 0 });
const FM = [
  [0, 0, 'slime_block'], [1, 0, 'sticky_piston[facing=west]'], [2, 0, 'slime_block'], [3, 0, 'slime_block'],
  [0, 1, 'observer[facing=west]'], [1, 1, 'sticky_piston[facing=east]'], [2, 1, 'observer[facing=east]'], [3, 1, 'slime_block'],
];
for (let x = 0; x < 48; x++) for (let z = 2; z <= 6; z++) put(x, 0, z, 'smooth_stone');
for (const [dx, dy, b] of FM) sim.world.setRaw(posOf(2 + dx, 2 + dy, 4), stateOf(b));
for (let y = 1; y <= 4; y++) put(44, y, 4, 'obsidian');
sim.world.scheduleTick(posOf(2, 3, 4), getBlock('observer'), 2);
sim.markEdited();
const flying = sim.serialize();
sim.step(600);
for (let i = 0; i < 400 && [...sim.world.blocks.values()].some((s) => s.id === 'moving_piston'); i++) sim.step(1);
const xs = [...sim.world.blocks].filter(([, s]) => s.id !== 'piston_head').map(([k]) => k.split(',').map(Number)).filter(([x, y]) => y >= 2 && x < 44);
console.log('  flying machine after 600 gt:', [...sim.world.blocks].filter(([k]) => Number(k.split(',')[1]) >= 2 && Number(k.split(',')[0]) < 44).map(([k, s]) => k + ' ' + s.id).join(' | '));
assert.equal(xs.length, 8, 'machine intact');
assert.ok(Math.min(...xs.map((a) => a[0])) >= 38, `machine reached the wall (min x ${Math.min(...xs.map((a) => a[0]))})`);
sim.deserialize(flying);
save('example-flying-machine');

process.exit(0);
