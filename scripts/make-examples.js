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

// ---- item sorter: items run east along a hopper line; under two of its hoppers a filter hopper
// holds 18 of its item plus one stick in each other slot (comparator 1). One more item makes it 2,
// which reaches the stone under the second dust: the repeater fills the side of a subtracting
// comparator, whose redstone-block input otherwise locks the hopper below the filter. That hopper
// then takes one item into the chest. No torch: a torch toggled once per item burns out when
// eight items of a kind come in a row.
const count = (x, y, z, id) => sim.world.getBlockEntity(posOf(x, y, z)).items.reduce((n, s) => n + (s.id === id ? s.count : 0), 0);
const sorter = () => {
  fresh();
  put(2, 4, 5, 'chest');
  for (let x = 2; x <= 9; x++) put(x, 3, 5, 'hopper[facing=east]');
  put(10, 3, 5, 'chest');
  const slice = (x, item) => {
    put(x, 2, 5, 'hopper[facing=west]'); // the filter: it only pulls, it points into air
    put(x, 1, 5, 'hopper[facing=south]');
    put(x, 1, 6, 'chest');
    put(x, 1, 4, 'stone');
    put(x, 2, 4, 'comparator[out=north]');
    put(x, 1, 3, 'stone');
    put(x, 2, 3, 'redstone_wire');
    put(x - 1, 1, 3, 'stone');
    put(x - 1, 2, 3, 'redstone_wire');
    put(x - 1, 1, 4, 'repeater[out=south]');
    put(x - 2, 1, 5, 'redstone_block');
    put(x - 1, 1, 5, 'comparator[out=east,mode=subtract]');
    sim.setItems(x, 2, 5, [{ slot: 0, id: item, count: 18 }, ...[1, 2, 3, 4].map((slot) => ({ slot, id: 'stick', count: 1 }))]);
  };
  slice(4, 'iron_ingot');
  slice(8, 'gold_ingot');
  sim.setItems(2, 4, 5, [
    { slot: 0, id: 'iron_ingot', count: 20 }, { slot: 1, id: 'cobblestone', count: 10 },
    { slot: 2, id: 'gold_ingot', count: 15 }, { slot: 3, id: 'iron_ingot', count: 5 },
  ]);
  sim.step(2);
};
sorter();
sim.step(1200);
assert.equal(count(4, 1, 6, 'iron_ingot') + count(4, 1, 5, 'iron_ingot'), 25, 'all iron sorted');
assert.equal(count(8, 1, 6, 'gold_ingot') + count(8, 1, 5, 'gold_ingot'), 15, 'all gold sorted');
assert.equal(count(10, 3, 5, 'cobblestone'), 10, 'the rest reaches the end chest');
assert.equal(count(4, 2, 5, 'iron_ingot'), 18, 'filter keeps 18');
assert.equal(count(8, 2, 5, 'gold_ingot'), 18, 'filter keeps 18');
sorter();
save('example-item-sorter');

// ---- auto crafter: a hopper fills the crafter one ingot per slot. A comparator reads the filled
// slots (0..9); after 9 dust only a 9 is left to power the stone beside the crafter, so it crafts
// once, when all nine slots hold an ingot (a clock would turn single ingots into nuggets).
const crafter = () => {
  fresh();
  put(5, 3, 5, 'chest');
  put(5, 2, 5, 'hopper[facing=down]');
  put(5, 1, 5, 'crafter[orientation=east_up]');
  put(6, 1, 5, 'chest');
  put(4, 1, 5, 'comparator[out=west]');
  for (const [x, z] of [[3, 5], [3, 4], [3, 3], [3, 2], [3, 1], [4, 1], [5, 1], [5, 2], [5, 3]]) put(x, 1, z, 'redstone_wire');
  put(5, 1, 4, 'stone');
  sim.setItems(5, 3, 5, [{ slot: 0, id: 'iron_ingot', count: 64 }, { slot: 1, id: 'iron_ingot', count: 20 }]);
  sim.step(2);
};
crafter();
sim.step(1200);
assert.equal(count(6, 1, 5, 'iron_block'), 9, '84 ingots make 9 iron blocks');
assert.equal(count(6, 1, 5, 'iron_nugget'), 0, 'never fired on a partial grid');
assert.equal(count(5, 1, 5, 'iron_ingot'), 3, 'three ingots wait for the next six');
crafter();
save('example-auto-crafter');

// ---- sculk wireless: a lever 6 blocks from a sculk sensor; the vibration lights the lamp beside
// it for 30 gt (power 4 at that distance). The second pair is the same, but a wool wall between
// them blocks the vibration.
const sculk = () => {
  fresh();
  put(2, 1, 5, 'lever');
  put(8, 1, 5, 'sculk_sensor');
  put(9, 1, 5, 'redstone_lamp');
  for (let y = 1; y <= 3; y++) for (let z = 11; z <= 15; z++) put(5, y, z, 'white_wool');
  put(2, 1, 13, 'lever');
  put(8, 1, 13, 'sculk_sensor');
  put(9, 1, 13, 'redstone_lamp');
  sim.step(80); // the sensors hear the build: let them settle
};
sculk();
assert.equal(prop(8, 1, 5, 'sculk_sensor_phase'), 'inactive');
sim.use(2, 1, 5);
sim.use(2, 1, 13);
sim.step(10);
assert.equal(prop(9, 1, 5, 'lit'), true, 'the open sensor lights its lamp');
assert.equal(prop(8, 1, 5, 'power'), 4);
assert.equal(prop(9, 1, 13, 'lit'), false, 'wool blocks the vibration');
sim.step(40);
assert.equal(prop(9, 1, 5, 'lit'), false, 'a 30 gt pulse');
sculk();
save('example-sculk-wireless');

// ---- hopper clock: two hoppers face each other with 8 items. A redstone block above one of them
// locks it, so the items flow one way; when the giving hopper is empty its comparator goes off,
// the torch under the far piston lights, and the piston pushes the block (and two stones) over the
// other hopper. Period 16 gt per item (128 gt here); each lamp blinks once per period.
const clock = () => {
  fresh();
  put(4, 1, 5, 'hopper[facing=east]');
  put(5, 1, 5, 'hopper[facing=west]');
  put(4, 1, 6, 'comparator[out=south]');
  put(4, 1, 7, 'repeater[out=south]');
  for (const [x, z] of [[4, 8], [5, 8], [6, 8], [7, 8]]) put(x, 1, z, 'redstone_wire');
  put(7, 1, 7, 'repeater[out=north]');
  put(7, 1, 6, 'stone');
  put(7, 1, 5, 'redstone_wall_torch[facing=north]');
  put(5, 1, 4, 'comparator[out=north]');
  put(5, 1, 3, 'repeater[out=north]');
  for (const [x, z] of [[5, 2], [4, 2], [3, 2], [2, 2]]) put(x, 1, z, 'redstone_wire');
  put(2, 1, 3, 'repeater[out=south]');
  put(2, 1, 4, 'stone');
  put(2, 1, 5, 'redstone_wall_torch[facing=south]');
  put(8, 1, 5, 'redstone_lamp');
  put(1, 1, 5, 'redstone_lamp');
  put(3, 2, 5, 'stone');
  put(4, 2, 5, 'redstone_block');
  put(5, 2, 5, 'stone');
  put(2, 2, 5, 'piston[facing=east]');
  put(7, 2, 5, 'piston[facing=west]');
  sim.setItems(4, 1, 5, [{ slot: 0, id: 'cobblestone', count: 8 }]);
};
clock();
const redstoneX = () => [3, 4, 5, 6].find((x) => id(x, 2, 5) === 'redstone_block');
let flips = 0;
let lastX;
for (let t = 0; t < 1000; t++) {
  sim.step(1);
  const x = redstoneX();
  if (x !== undefined && lastX !== undefined && x !== lastX) flips++;
  if (x !== undefined) lastX = x;
}
assert.ok(flips >= 14 && flips <= 16, `the block moves every 64 gt (${flips} moves in 1000 gt)`);
assert.equal(count(4, 1, 5, 'cobblestone') + count(5, 1, 5, 'cobblestone'), 8, 'no items lost');
clock();
save('example-hopper-clock');

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
