// Sculk sensors beyond the tickwright captures: amethyst resonance, block placing, a vibration in
// flight surviving save/load and world copies, and the calibrated sensor's frequency filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, pos, getBlock, makeState, parseBlockString } from '../engine/index.js';
import { cloneWorld } from '../engine/clone.js';
import { Simulation } from '../server/sim.js';

const st = (s) => {
  const { id, props } = parseBlockString(s);
  return makeState(getBlock(id), props);
};

function floor(w, n = 24) {
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) w.setBlock(pos(x, 0, z), st('stone'), 2 | 16);
}

const phase = (w, p) => w.getBlockState(p).props.sculk_sensor_phase;

test('a lever is heard 3 blocks away: power 10 for 30 gt, then 10 gt of cooldown', () => {
  const w = new World();
  floor(w);
  const s = pos(2, 1, 2);
  w.setBlock(s, st('sculk_sensor'), 3);
  w.setBlock(pos(5, 1, 2), st('lever[face=floor,facing=north]'), 3);
  w.useBlock(pos(5, 1, 2));
  let on = -1;
  for (let t = 1; t <= 60; t++) {
    w.tick();
    if (on < 0 && phase(w, s) === 'active') on = t;
  }
  assert.equal(on, 3); // selected next tick, then floor(3.0) ticks of travel
  assert.equal(phase(w, s), 'inactive');
});

test('amethyst repeats the frequency to a sensor out of the source range', () => {
  const w = new World();
  floor(w);
  const a = pos(2, 1, 2);
  const b = pos(17, 1, 2); // 15 blocks from the lever: too far for a plain sensor
  w.setBlock(a, st('sculk_sensor'), 3);
  w.setBlock(pos(10, 1, 2), st('amethyst_block'), 3);
  w.setBlock(pos(9, 1, 2), st('sculk_sensor'), 3); // hears the lever at x=2..., touches the amethyst
  w.setBlock(b, st('sculk_sensor'), 3);
  w.setBlock(pos(2, 1, 4), st('lever[face=floor,facing=north]'), 3);
  w.useBlock(pos(2, 1, 4));
  let bOn = false;
  for (let t = 0; t < 40; t++) {
    w.tick();
    if (phase(w, b) === 'active') bOn = true;
  }
  assert.ok(bOn, 'the far sensor heard resonate_10 from the amethyst');
  const be = w.getBlockEntity(b);
  assert.equal(be.lastVibrationFrequency, 10);
});

test('placing a block is a vibration (frequency 13); the sensor ignores its own placement', () => {
  const w = new World();
  floor(w);
  const s = pos(2, 1, 2);
  w.placeBlock(s, 'sculk_sensor');
  for (let t = 0; t < 5; t++) w.tick();
  assert.equal(phase(w, s), 'inactive');
  w.placeBlock(pos(4, 1, 2), 'stone');
  for (let t = 0; t < 5; t++) w.tick();
  assert.equal(phase(w, s), 'active');
  assert.equal(w.getBlockEntity(s).lastVibrationFrequency, 13);
});

test('breaking wool is not heard (wool dampens its own destruction)', () => {
  const w = new World();
  floor(w);
  const s = pos(2, 1, 2);
  w.setBlock(s, st('sculk_sensor'), 3);
  w.setBlock(pos(6, 1, 2), st('white_wool'), 3);
  w.destroyBlock(pos(6, 1, 2), false); // dampened: wool is the affected state
  for (let t = 0; t < 12; t++) w.tick();
  assert.equal(phase(w, s), 'inactive');
});

test('the calibrated sensor only hears the frequency on its back input', () => {
  const w = new World();
  floor(w);
  const c = pos(5, 1, 5);
  // facing east: input from the west side
  w.setBlock(c, st('calibrated_sculk_sensor[facing=east]'), 3);
  w.setBlock(pos(4, 1, 5), st('redstone_wire'), 3);
  w.setBlock(pos(4, 1, 6), st('redstone_block'), 3); // wire at 15: only frequency 15 passes
  w.setBlock(pos(8, 1, 5), st('lever[face=floor,facing=north]'), 3);
  w.useBlock(pos(8, 1, 5));
  for (let t = 0; t < 8; t++) w.tick();
  assert.equal(phase(w, c), 'inactive');
});

test('a vibration in flight survives a world copy and save/load', () => {
  const sim = new Simulation({ designsDir: 'unused' });
  clearInterval(sim._timer);
  sim.setRunning(false);
  sim.newWorld({ floor: 16 });
  sim.setBlock(2, 1, 2, 'sculk_sensor');
  sim.setBlock(9, 1, 2, 'lever[face=floor,facing=north]');
  sim.use(9, 1, 2);
  sim.step(2); // selected, 7 ticks of travel left after the decrement... still travelling
  const w = sim.world;
  const be = w.getBlockEntity(pos(2, 1, 2));
  assert.ok(be.vibration, 'in flight');
  const copy = cloneWorld(w);
  const saved = sim.serialize();
  sim.deserialize(saved);
  const runs = [w, copy, sim.world].map((world) => {
    let on = -1;
    for (let t = 1; t <= 20; t++) {
      world.tick();
      if (on < 0 && phase(world, pos(2, 1, 2)) === 'active') on = t;
    }
    return on;
  });
  assert.ok(runs[0] > 0);
  assert.deepEqual(runs, [runs[0], runs[0], runs[0]]);
});
