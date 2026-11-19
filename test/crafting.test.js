// Crafter recipes and the composter's hopper interface, beyond the tickwright captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, pos, getBlock, makeState, parseBlockString } from '../engine/index.js';
import { ItemStack, EMPTY } from '../engine/items.js';
import { findRecipe } from '../engine/blocks/crafting.js';

const st = (s) => {
  const { id, props } = parseBlockString(s);
  return makeState(getBlock(id), props);
};

/** CraftingInput-like 3x3 grid from a 9-character pattern and a key. */
function grid(rows, key) {
  const items = [...rows.join('')].map((c) => (c === ' ' ? EMPTY : ItemStack.of(key[c], 1)));
  // trimmed like CraftingInput.of
  let l = 2, r = 0, t = 2, b = 0;
  items.forEach((s, i) => {
    if (s.isEmpty()) return;
    l = Math.min(l, i % 3); r = Math.max(r, i % 3); t = Math.min(t, (i / 3) | 0); b = Math.max(b, (i / 3) | 0);
  });
  const out = [];
  for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) out.push(items[x + y * 3]);
  return { width: r - l + 1, height: b - t + 1, items: out, count: out.filter((s) => !s.isEmpty()).length };
}

test('recipes: tags, mirrored shapes, positions, transmute', () => {
  assert.equal(findRecipe(grid(['   ', ' L ', '   '], { L: 'stripped_oak_wood' }))[1], 'oak_planks');
  assert.equal(findRecipe(grid(['P  ', 'PP ', 'PPP'], { P: 'oak_planks' }))[1], 'oak_stairs');
  assert.equal(findRecipe(grid(['  P', ' PP', 'PPP'], { P: 'oak_planks' }))[1], 'oak_stairs'); // mirrored
  assert.equal(findRecipe(grid(['   ', ' P ', ' P '], { P: 'birch_planks' }))[1], 'stick');
  assert.equal(findRecipe(grid(['S  ', '   ', '  D'], { S: 'shulker_box', D: 'red_dye' }))[1], 'red_shulker_box');
  assert.equal(findRecipe(grid(['S  ', '   ', '  D'], { S: 'red_shulker_box', D: 'red_dye' })), null); // same colour
  assert.equal(findRecipe(grid(['PP ', 'PP ', '   '], { P: 'stone' }))[1], 'stone_bricks');
  assert.equal(findRecipe(grid(['P P', '   ', '   '], { P: 'stone' })), null);
});

test('a crafter turns a log into planks in the chest it faces; the comparator counts filled slots', () => {
  const w = new World();
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) w.setBlock(pos(x, 0, z), st('stone'), 2 | 16);
  const c = pos(2, 1, 2);
  w.setBlock(c, st('crafter[orientation=east_up]'), 3);
  w.setBlock(pos(3, 1, 2), st('chest[facing=west]'), 3);
  const be = w.getBlockEntity(c);
  be.setItem(4, ItemStack.of('oak_log', 2));
  assert.equal(getBlock('crafter').getAnalogOutput(w, c, w.getBlockState(c)), 1);
  w.setBlock(pos(2, 1, 1), st('redstone_block'), 3);
  for (let t = 0; t < 10; t++) w.tick();
  const chest = w.getBlockEntity(pos(3, 1, 2));
  assert.equal(chest.getItem(0).id, 'oak_planks');
  assert.equal(chest.getItem(0).count, 4);
  assert.equal(be.getItem(4).count, 1);
  assert.equal(w.getBlockState(c).props.crafting, false); // 6 gt of "crafting" are over
});

test('a hopper fills a composter; when ready, a hopper below takes the bone meal and empties it', () => {
  const w = new World();
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) w.setBlock(pos(x, 0, z), st('stone'), 2 | 16);
  const k = pos(2, 2, 2);
  w.setBlock(pos(2, 1, 2), st('hopper[facing=east]'), 3); // below: pulls the bone meal
  w.setBlock(k, st('composter'), 3);
  w.setBlock(pos(2, 3, 2), st('hopper[facing=down]'), 3);
  w.getBlockEntity(pos(2, 3, 2)).setItem(0, ItemStack.of('pumpkin_pie', 10)); // chance 1: one level each
  let seven = -1;
  for (let t = 1; t <= 120; t++) {
    w.tick();
    if (seven < 0 && w.getBlockState(k).props.level === 7) seven = t;
  }
  assert.ok(seven > 0, 'reached level 7');
  // 7 pies to level 7, ready 20 gt later, emptied by the hopper below in that same tick, then 3 more
  assert.equal(w.getBlockEntity(pos(2, 3, 2)).getItem(0).count, 0);
  assert.equal(w.getBlockEntity(pos(2, 1, 2)).getItem(0).id, 'bone_meal');
  assert.equal(w.getBlockState(k).props.level, 3);
});
