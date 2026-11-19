// Tripwire hooks, cake and lectern behaviour beyond the tickwright captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, pos, getBlock, makeState, parseBlockString } from '../engine/index.js';

const st = (s) => {
  const { id, props } = parseBlockString(s);
  return makeState(getBlock(id), props);
};
function floor(w) {
  for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) w.setBlock(pos(x, 0, z), st('stone'), 2 | 16);
}
/** World.placeBlock: placed like a player (onPlace + setPlacedBy) */
const put = (w, p, s) => {
  const { id, props } = parseBlockString(s);
  w.placeBlock(p, id, props);
};
const run = (w, n) => { for (let i = 0; i < n; i++) w.tick(); };

test('two tripwire hooks with string between them attach; breaking the string trips them', () => {
  const w = new World();
  floor(w);
  w.setBlock(pos(1, 1, 2), st('stone'), 3);
  w.setBlock(pos(6, 1, 2), st('stone'), 3);
  put(w, pos(2, 1, 2), 'tripwire_hook[facing=east]');
  for (let x = 3; x <= 4; x++) put(w, pos(x, 1, 2), 'tripwire[east=true,west=true]');
  put(w, pos(5, 1, 2), 'tripwire_hook[facing=west]');
  run(w, 2);
  assert.equal(w.getBlockState(pos(2, 1, 2)).props.attached, true);
  assert.equal(w.getBlockState(pos(5, 1, 2)).props.attached, true);
  assert.equal(w.getBlockState(pos(3, 1, 2)).props.attached, true);
  // breaking the string (no shears) trips the hooks first; their 10 gt recheck then detaches them
  w.removeBlock(pos(4, 1, 2), false);
  assert.equal(w.getBlockState(pos(2, 1, 2)).props.powered, true);
  run(w, 12);
  assert.equal(w.getBlockState(pos(2, 1, 2)).props.powered, false);
  assert.equal(w.getBlockState(pos(2, 1, 2)).props.attached, false);
  assert.equal(w.getBlockState(pos(5, 1, 2)).props.attached, false);
});

test('a comparator reads a cake: 14 whole, 2 less per slice', () => {
  const w = new World();
  floor(w);
  const c = pos(2, 1, 2);
  w.setBlock(c, st('cake'), 3);
  put(w, pos(3, 1, 2), 'comparator[facing=west]');
  run(w, 4);
  assert.equal(w.getBlockEntity(pos(3, 1, 2)).output, 14);
  w.useBlock(c);
  w.useBlock(c);
  run(w, 4);
  assert.equal(w.getBlockState(c).props.bites, 2);
  assert.equal(w.getBlockEntity(pos(3, 1, 2)).output, 10);
});

test('a lectern with a book: comparator follows the page, a page turn pulses it for 2 gt', () => {
  const w = new World();
  floor(w);
  const l = pos(2, 1, 2);
  w.setBlock(l, st('lectern[facing=north,has_book=true]'), 3);
  put(w, pos(3, 1, 2), 'comparator[facing=west]');
  run(w, 4);
  const be = w.getBlockEntity(l);
  assert.equal(be.pageCount, 15);
  assert.equal(w.getBlockEntity(pos(3, 1, 2)).output, 1); // page 1 of 15
  w.useBlock(l);
  assert.equal(w.getBlockState(l).props.powered, true);
  run(w, 2);
  assert.equal(w.getBlockState(l).props.powered, false);
  be.setPage(14);
  run(w, 4);
  assert.equal(w.getBlockEntity(pos(3, 1, 2)).output, 15);
});
