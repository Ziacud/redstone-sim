// Containers, note blocks and doors (the conformance captures check their exact update order;
// these check the visible results and the simulator API around them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { floorWorld, place, state, record, pos } from './helpers.js';
import { ItemStack } from '../engine/items.js';
import { cloneWorld } from '../engine/clone.js';

const fill = (w, x, y, z, items) => {
  const be = w.getBlockEntity(pos(x, y, z));
  for (const [slot, id, count] of items) be.setItem(slot, ItemStack.of(id, count));
  return be;
};

test('hopper chain moves one item per 8 gt into a chest; a comparator reads the chest', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'chest', { facing: 'north' });
  place(w, 1, 1, 0, 'hopper', { facing: 'west' });
  place(w, 2, 1, 0, 'hopper', { facing: 'west' });
  place(w, -1, 1, 0, 'comparator', { out: 'west' });
  fill(w, 2, 1, 0, [[0, 'stone', 10]]);
  record(w, 200, () => 0);
  const chest = w.getBlockEntity(pos(0, 1, 0));
  assert.deepEqual(chest.save().items, [[0, 'stone', 10]]);
  assert.equal(w.powerLevel(pos(-1, 1, 0)), 1, '10 of 27*64 = signal 1');
  assert.ok(w.getBlockEntity(pos(1, 1, 0)).isEmpty());
});

test('a powered hopper is locked', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'chest', { facing: 'north' });
  place(w, 1, 1, 0, 'hopper', { facing: 'west' });
  place(w, 1, 2, 0, 'redstone_block');
  assert.equal(state(w, 1, 1, 0).props.enabled, false);
  fill(w, 1, 1, 0, [[0, 'stone', 3]]);
  record(w, 40, () => 0);
  assert.ok(w.getBlockEntity(pos(0, 1, 0)).isEmpty());
});

test('a non-stackable item counts as a full stack for comparators', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'hopper', { facing: 'down' });
  place(w, 1, 1, 0, 'comparator', { out: 'east' });
  fill(w, 0, 1, 0, [[0, 'shulker_box', 1]]).setChanged(); // a hopper's setItem does not wake comparators
  record(w, 3, () => 0);
  assert.equal(w.powerLevel(pos(1, 1, 0)), 3, 'one non-stackable in 5 slots: 1/5 -> 3');
});

test('a dropper pushes one item into the container it faces on a rising edge', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'dropper', { facing: 'east' });
  place(w, 1, 1, 0, 'barrel');
  place(w, -1, 1, 0, 'lever', { face: 'floor' });
  fill(w, 0, 1, 0, [[4, 'redstone', 3]]);
  w.useBlock(pos(-1, 1, 0));
  record(w, 6, () => 0);
  assert.deepEqual(w.getBlockEntity(pos(1, 1, 0)).save().items, [[0, 'redstone', 1]]);
  assert.deepEqual(w.getBlockEntity(pos(0, 1, 0)).save().items, [[4, 'redstone', 2]]);
});

test('note block plays (block event) on a rising edge, use tunes it', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'note_block');
  assert.equal(state(w, 0, 1, 0).props.instrument, 'basedrum', 'stone below');
  w.useBlock(pos(0, 1, 0));
  assert.equal(state(w, 0, 1, 0).props.note, 1);
  place(w, 1, 1, 0, 'lever', { face: 'floor' });
  w.useBlock(pos(1, 1, 0));
  assert.equal(state(w, 0, 1, 0).props.powered, true);
  // the tune and the power edge queue the same block event; vanilla's event set keeps one
  assert.equal(w.blockEvents.size, 1);
  w.tick();
  assert.equal(w.blockEvents.size, 0);
});

test('doors: two halves, power opens both, breaking the bottom drops the top', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'oak_door', { facing: 'north' });
  assert.equal(state(w, 0, 2, 0).props.half, 'upper');
  place(w, 1, 2, 0, 'redstone_block');
  assert.equal(state(w, 0, 1, 0).props.open, true);
  assert.equal(state(w, 0, 2, 0).props.open, true);
  w.breakBlock(pos(0, 1, 0));
  assert.equal(state(w, 0, 2, 0).id, 'air');
});

test('a world copy keeps item stacks separate', () => {
  const w = floorWorld();
  place(w, 0, 1, 0, 'chest', { facing: 'north' });
  fill(w, 0, 1, 0, [[0, 'stone', 5]]);
  const c = cloneWorld(w);
  w.getBlockEntity(pos(0, 1, 0)).getItem(0).shrink(2);
  assert.equal(c.getBlockEntity(pos(0, 1, 0)).getItem(0).count, 5);
  assert.equal(c.getBlockEntity(pos(0, 1, 0)).world, c);
});
