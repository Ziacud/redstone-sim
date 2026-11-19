// Checks the simulator against well-known vanilla Java Edition timings and behaviors.
// Player actions (useBlock/placeBlock) happen between ticks, like packets do in vanilla.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorWorld, place, state, record, pos } from './helpers.js';

test('dust decays by one per block: 15 lit dust from a lever', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'lever');
  for (let x = 1; x <= 17; x++) place(w, x, 1, 0, 'redstone_wire');
  place(w, 18, 1, 0, 'redstone_lamp');
  w.useBlock(pos(0, 1, 0));
  const powers = [];
  for (let x = 1; x <= 17; x++) powers.push(state(w, x, 1, 0).props.power);
  assert.deepEqual(powers, [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
  assert.equal(state(w, 18, 1, 0).props.lit, false);
});

test('a lever beside a block does not power it, a lever attached to it does', () => {
  const w = floorWorld();
  place(w, 3, 1, 2, 'stone');
  place(w, 4, 1, 2, 'redstone_wall_torch', { facing: 'east' });
  place(w, 3, 1, 1, 'lever'); // floor lever next to the block
  w.useBlock(pos(3, 1, 1));
  record(w, 4, () => 0);
  assert.equal(state(w, 4, 1, 2).props.lit, true);
  place(w, 2, 1, 2, 'lever', { face: 'wall', facing: 'west' }); // attached to the block
  w.useBlock(pos(2, 1, 2));
  const lit = record(w, 3, () => state(w, 4, 1, 2).props.lit);
  assert.deepEqual(lit, [true, false, false], 'torch turns off 2 gt after its block is powered');
});

for (const delay of [1, 2, 3, 4]) {
  test(`repeater delay ${delay} = ${delay * 2} gt (rising and falling edge)`, () => {
    const w = floorWorld();
    place(w, 0, 1, 0, 'lever');
    place(w, 1, 1, 0, 'repeater', { out: 'east', delay });
    place(w, 2, 1, 0, 'redstone_lamp');
    w.useBlock(pos(0, 1, 0));
    const on = record(w, delay * 2 + 1, () => state(w, 1, 1, 0).props.powered);
    assert.equal(on.indexOf(true), delay * 2 - 1, 'powered on tick 2*delay');
    assert.equal(state(w, 2, 1, 0).props.lit, true, 'lamp turns on in the same tick');
    w.useBlock(pos(0, 1, 0));
    const off = record(w, delay * 2 + 1, () => state(w, 1, 1, 0).props.powered);
    assert.equal(off.indexOf(false), delay * 2 - 1, 'unpowered on tick 2*delay');
  });
}

test('lamp turns on instantly and off after 4 gt', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'lever');
  place(w, 1, 1, 0, 'redstone_lamp');
  w.useBlock(pos(0, 1, 0));
  assert.equal(state(w, 1, 1, 0).props.lit, true);
  w.useBlock(pos(0, 1, 0));
  const lit = record(w, 5, () => state(w, 1, 1, 0).props.lit);
  assert.deepEqual(lit, [true, true, true, false, false]);
});

test('a powered side repeater locks a repeater', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'lever');
  place(w, 1, 1, 0, 'repeater', { out: 'east' });
  place(w, 2, 1, 0, 'redstone_lamp');
  // locking repeater pointing south into (1,1,0)
  place(w, 1, 1, -2, 'lever');
  place(w, 1, 1, -1, 'repeater', { out: 'south' });
  w.useBlock(pos(1, 1, -2));
  record(w, 3, () => 0);
  assert.equal(state(w, 1, 1, 0).props.locked, true);
  w.useBlock(pos(0, 1, 0));
  record(w, 6, () => 0);
  assert.equal(state(w, 1, 1, 0).props.powered, false, 'locked repeater ignores its input');
  assert.equal(state(w, 2, 1, 0).props.lit, false);
  w.useBlock(pos(1, 1, -2));
  record(w, 6, () => 0);
  assert.equal(state(w, 1, 1, 0).props.locked, false);
  assert.equal(state(w, 1, 1, 0).props.powered, true, 'unlocked repeater picks up its input');
});

test('comparator compare and subtract modes', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'barrel');
  w.getBlockState(pos(0, 1, 0)).block.setSignal(w, pos(0, 1, 0), 10);
  place(w, 1, 1, 0, 'comparator', { out: 'east' });
  record(w, 3, () => 0);
  assert.equal(w.powerLevel(pos(1, 1, 0)), 10);
  // side input of strength 3: lever then 12 dust ending at the comparator's side
  place(w, 1, 1, 13, 'lever');
  for (let z = 12; z >= 1; z--) place(w, 1, 1, z, 'redstone_wire');
  w.useBlock(pos(1, 1, 13));
  assert.equal(state(w, 1, 1, 1).props.power, 4);
  record(w, 3, () => 0);
  assert.equal(w.powerLevel(pos(1, 1, 0)), 10, 'compare: side 4 < back 10 passes 10');
  w.useBlock(pos(1, 1, 0));
  record(w, 3, () => 0);
  assert.equal(w.powerLevel(pos(1, 1, 0)), 6, 'subtract: 10 - 4');
});

test('torch burnout: 8 toggles within 60 gt, then stays off until updated', () => {
  const w = floorWorld();
  // torch on the east side of block S at (5,1,5); dust loops back and points into S
  place(w, 5, 1, 5, 'stone');
  for (const [x, z] of [[7, 5], [7, 4], [7, 3], [6, 3], [5, 3], [5, 4]]) place(w, x, 1, z, 'redstone_wire');
  place(w, 6, 1, 5, 'redstone_wall_torch', { facing: 'east' });
  let offs = 0;
  let prev = true;
  const lit = record(w, 120, () => {
    const l = state(w, 6, 1, 5).props.lit;
    if (prev && !l) offs++;
    prev = l;
    return l;
  });
  assert.equal(offs, 8, 'burns out on the 8th toggle');
  assert.equal(lit.slice(60).some(Boolean), false, 'stays off while burnt out');
  // The depowering loop schedules a 2 gt tick first, so the 160 gt relight tick is
  // deduplicated away: a burnt-out torch needs a block update to relight.
  const still = record(w, 200, () => state(w, 6, 1, 5).props.lit);
  assert.equal(still.some(Boolean), false, 'no spontaneous relight');
  place(w, 6, 1, 6, 'stone');
  const relit = record(w, 3, () => state(w, 6, 1, 5).props.lit);
  assert.ok(relit.some(Boolean), 'relights after a block update');
});

test('observer emits a 2 gt pulse 2 gt after the change it sees', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'lever');
  place(w, 1, 1, 0, 'observer', { facing: 'west' });
  w.useBlock(pos(0, 1, 0));
  const p = record(w, 6, () => state(w, 1, 1, 0).props.powered);
  assert.deepEqual(p, [false, true, true, false, false, false]);
});

test('two facing observers alternate 2 gt pulses (6 gt period each)', () => {
  // Each observer schedules its off-tick after setBlock, so the partner's tick sorts first;
  // the result is A on 2 gt, B on 2 gt, both off 2 gt.
  const w = floorWorld();
  place(w, 0, 1, 0, 'observer', { facing: 'east' });
  place(w, 1, 1, 0, 'observer', { facing: 'west' });
  const a = record(w, 13, () => `${state(w, 0, 1, 0).props.powered ? 1 : 0}${state(w, 1, 1, 0).props.powered ? 1 : 0}`);
  assert.deepEqual(a.slice(1), ['10', '10', '01', '01', '00', '00', '10', '10', '01', '01', '00', '00']);
});

function pistonRow(n) {
  const w = floorWorld();
  place(w, 0, 1, 0, 'piston', { facing: 'east' });
  for (let x = 1; x <= n; x++) place(w, x, 1, 0, 'white_concrete');
  place(w, -1, 1, 0, 'lever', { face: 'floor' });
  w.useBlock(pos(-1, 1, 0));
  record(w, 4, () => 0);
  return w;
}

test('piston pushes 12 blocks', () => {
  const w = pistonRow(12);
  assert.equal(state(w, 0, 1, 0).props.extended, true);
  assert.equal(state(w, 1, 1, 0).id, 'piston_head');
  assert.equal(state(w, 13, 1, 0).id, 'white_concrete');
});

test('piston cannot push 13 blocks', () => {
  const w = pistonRow(13);
  assert.equal(state(w, 0, 1, 0).props.extended, false);
  assert.equal(state(w, 1, 1, 0).id, 'white_concrete');
});

test('piston extension timing: event next tick, block lands 2 gt later', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'piston', { facing: 'east' });
  place(w, 1, 1, 0, 'white_concrete');
  place(w, -1, 1, 0, 'lever');
  w.useBlock(pos(-1, 1, 0));
  const ids = record(w, 4, () => state(w, 2, 1, 0).id);
  assert.deepEqual(ids, ['moving_piston', 'moving_piston', 'white_concrete', 'white_concrete']);
});

test('quasi-connectivity: power above the piston needs a block update (BUD)', () => {
  const w = floorWorld();
  place(w, 5, 1, 5, 'piston', { facing: 'north' });
  place(w, 6, 2, 5, 'redstone_block'); // diagonally above: powers the space above the piston
  record(w, 5, () => 0);
  assert.equal(state(w, 5, 1, 5).props.extended, false, 'not updated, stays retracted');
  place(w, 4, 1, 5, 'stone'); // any block update
  record(w, 4, () => 0);
  assert.equal(state(w, 5, 1, 5).props.extended, true, 'extends once updated');
});

test('sticky piston drops its block on a 2 gt pulse and pulls it on a long pulse', () => {
  const run = (pulse) => {
    const w = floorWorld();
    place(w, 5, 1, 5, 'sticky_piston', { facing: 'east' });
    place(w, 6, 1, 5, 'white_concrete');
    if (pulse === 'short') {
      place(w, 3, 1, 5, 'lever');
      place(w, 4, 1, 5, 'observer', { facing: 'west' });
      w.useBlock(pos(3, 1, 5));
    } else {
      place(w, 4, 1, 5, 'lever');
      w.useBlock(pos(4, 1, 5));
      record(w, 6, () => 0);
      w.useBlock(pos(4, 1, 5));
    }
    record(w, 10, () => 0);
    return w;
  };
  const s = run('short');
  assert.equal(state(s, 5, 1, 5).props.extended, false);
  assert.equal(state(s, 6, 1, 5).id, 'air');
  assert.equal(state(s, 7, 1, 5).id, 'white_concrete', 'block left behind');
  const l = run('long');
  assert.equal(state(l, 6, 1, 5).id, 'white_concrete', 'block pulled back');
  assert.equal(state(l, 7, 1, 5).id, 'air');
});

test('slime block drags attached blocks (but not when stuck to the floor)', () => {
  const w = floorWorld();
  place(w, 0, 3, 0, 'piston', { facing: 'east' });
  place(w, 1, 3, 0, 'slime_block');
  place(w, 1, 4, 0, 'white_concrete');
  place(w, 1, 3, 1, 'white_concrete');
  place(w, -1, 3, 0, 'redstone_block');
  record(w, 4, () => 0);
  assert.equal(state(w, 2, 3, 0).id, 'slime_block');
  assert.equal(state(w, 2, 4, 0).id, 'white_concrete');
  assert.equal(state(w, 2, 3, 1).id, 'white_concrete');

  const g = floorWorld();
  place(g, 0, 1, 0, 'piston', { facing: 'east' });
  place(g, 1, 1, 0, 'slime_block'); // sticks to the 44x44 floor: over the push limit
  place(g, -1, 1, 0, 'redstone_block');
  record(g, 4, () => 0);
  assert.equal(state(g, 0, 1, 0).props.extended, false);
});

test('pistons break dust in front of them', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'piston', { facing: 'east' });
  place(w, 1, 1, 0, 'redstone_wire');
  place(w, -1, 1, 0, 'lever');
  w.useBlock(pos(-1, 1, 0));
  record(w, 4, () => 0);
  assert.equal(state(w, 1, 1, 0).id, 'piston_head');
});
