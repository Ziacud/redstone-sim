// Rewind must give back exactly the world of that tick (blocks, pending ticks, block events,
// moving pistons, ticker order, random state), and an edit made after the target is undone.
// Also checks the material list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../server/sim.js';
import { cloneWorld } from '../engine/clone.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function digest(w) {
  const h = createHash('sha256');
  h.update(`t${w.time}|s${w.subTickCount}|r${w.random.a}|v${w.randValue}|f${[...w.frozenChunks].sort()}`);
  h.update(`|tt${w.torchToggles.map((t) => `${t.pos.key}@${t.when}`).join(';')}`);
  h.update('\n' + [...w.blocks].map(([k, s]) => `${k}=${s.key}`).sort().join('\n'));
  h.update('\nT' + [...w.pendingTicks.values()].map((t) => `${t.pos.key}|${t.id}|${t.trigger}|${t.priority}|${t.sub}`).sort().join('\n'));
  h.update('\nE' + [...w.blockEvents.values()].map((e) => `${e.pos.key}|${e.id}|${e.a}|${e.b}`).join('\n'));
  const be = (b) =>
    b
      ? [b.type, b.pos.key, b.state?.key, b.removed, b.movedState?.key, b.direction?.name, b.extending, b.progress, b.progressO, b.lastTicked, b.output, b.signal].join(',')
      : 'null';
  h.update('\nB' + [...w.blockEntities].map(([k, b]) => `${k}:${be(b)}`).sort().join('\n'));
  h.update('\nK' + w.tickers.map((t) => `${t.pos.key}:${be(t.be)}`).join('\n'));
  return h.digest('hex');
}

function newSim() {
  const sim = new Simulation({ designsDir: path.join(ROOT, 'designs') });
  clearInterval(sim._timer);
  sim.running = false;
  return sim;
}

test('a cloned world runs on exactly like the original', () => {
  const sim = newSim();
  sim.load('demo');
  sim.step(37);
  const copy = cloneWorld(sim.world);
  assert.equal(digest(copy), digest(sim.world));
  for (let i = 0; i < 400; i++) {
    sim.world.tick();
    copy.tick();
    assert.equal(digest(copy), digest(sim.world), `differs after ${i + 1} ticks`);
  }
  // independent: ticking the copy leaves the original alone
  const before = digest(sim.world);
  copy.tick();
  assert.equal(digest(sim.world), before);
});

test('rewind restores the exact world of the target tick', () => {
  const sim = newSim();
  sim.load('demo');
  const seen = new Map([[sim.world.time, digest(sim.world)]]);
  for (let i = 0; i < 300; i++) {
    sim.step(1);
    seen.set(sim.world.time, digest(sim.world));
  }
  const end = sim.world.time;
  for (const back of [1, 5, 31, 32, 33, 150]) {
    const r = sim.rewind(back);
    assert.equal(r.reached, end - back);
    assert.equal(digest(sim.world), seen.get(sim.world.time), `rewind ${back}`);
    sim.step(back); // forward again: same ticks as before
    assert.equal(digest(sim.world), seen.get(end), `forward again after rewind ${back}`);
  }
  // as far back as the history goes, then forward tick by tick
  sim.rewind(1e6);
  assert.equal(sim.world.time, sim.historyStart());
  while (sim.world.time < end) {
    sim.step(1);
    assert.equal(digest(sim.world), seen.get(sim.world.time), `replay at ${sim.world.time}`);
  }
});

test('rewinding past an edit undoes it', () => {
  const sim = newSim();
  sim.load('demo');
  const ref = newSim();
  ref.load('demo');
  sim.step(60);
  ref.step(60);
  const t60 = digest(sim.world);
  sim.use(2, 1, 2); // the demo's first lever
  sim.step(50);
  ref.step(50);
  assert.notEqual(digest(sim.world), digest(ref.world), 'the lever changed the world');
  sim.rewind(50);
  assert.equal(digest(sim.world), t60, 'back before the lever');
  sim.step(50);
  assert.equal(digest(sim.world), digest(ref.world), 'without the lever, like the reference');
});

test('material list counts items, stacks and shulker boxes', () => {
  const sim = newSim();
  sim.newWorld({ floor: 0 });
  for (let x = 0; x < 70; x++) sim.setBlock(x, 0, 0, 'stone');
  for (let x = 0; x < 3; x++) sim.setBlock(x, 1, 0, 'redstone_wire');
  sim.setBlock(0, 0, 1, 'stone');
  sim.setBlock(0, 0, 2, 'redstone_wall_torch[facing=south]', 'setblock');
  sim.setBlock(5, 0, 5, 'stone_slab[type=double]', 'setblock');
  sim.setBlock(6, 0, 5, 'water', 'setblock');
  const m = Object.fromEntries(sim.materials().map((e) => [e.item, e]));
  assert.equal(m.stone.count, 71);
  assert.equal(m.stone.stacks, 1);
  assert.equal(m.stone.rest, 7);
  assert.equal(m.redstone.count, 3);
  assert.equal(m.redstone_torch.count, 1);
  assert.equal(m.stone_slab.count, 2);
  assert.equal(m.water_bucket.stackSize, 1);
  assert.equal(sim.materials([0, 0, 0], [9, 0, 0]).find((e) => e.item === 'stone').count, 10);
});
