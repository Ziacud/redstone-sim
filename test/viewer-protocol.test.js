// The viewer's WebSocket protocol on the Simulation: placing and breaking blocks, the signal graph
// samples, and the palette in snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../server/sim.js';

function sim() {
  const s = new Simulation({ designsDir: 'unused' });
  clearInterval(s._timer);
  s.setRunning(false);
  s.newWorld({ floor: 8 });
  return s;
}

test('place and break like a player', () => {
  const s = sim();
  s.handleMessage({ type: 'place', x: 2, y: 1, z: 2, block: 'repeater[out=east]' });
  assert.equal(s.world.getBlockState({ x: 2, y: 1, z: 2 }).id, 'repeater');
  assert.throws(() => s.handleMessage({ type: 'place', x: 2, y: 3, z: 2, block: 'sugar_cane' }), /cannot survive/);
  s.handleMessage({ type: 'break', x: 2, y: 1, z: 2 });
  assert.equal(s.world.getBlockState({ x: 2, y: 1, z: 2 }).id, 'air');
});

test('signal graph samples every tick and resets with the world', () => {
  const s = sim();
  s.setBlock(1, 1, 1, 'lever');
  s.setBlock(2, 1, 1, 'redstone_wire');
  const sent = [];
  s.subscribe((text) => sent.push(JSON.parse(text)));
  s.handleMessage({ type: 'probe', x: 2, y: 1, z: 1 });
  s.use(1, 1, 1);
  s.step(3);
  const samples = sent.filter((m) => m.samples).flatMap((m) => m.samples);
  assert.deepEqual(samples.map(([, v]) => v[0]), [15, 15, 15]);
  assert.deepEqual(sent.at(-1).probes, [[2, 1, 1]]);
  s.handleMessage({ type: 'probe', x: 2, y: 1, z: 1 });
  assert.deepEqual(s.status().probes, []);
  s.handleMessage({ type: 'probe', x: 2, y: 1, z: 1 });
  s.newWorld({ floor: 4 });
  assert.deepEqual(s.status().probes, []);
});

test('snapshot lists the placeable blocks', () => {
  const p = sim().snapshot().palette;
  assert.ok(p.includes('redstone_wire') && p.includes('hopper') && p.includes('oak_door'));
  assert.ok(!p.includes('piston_head') && !p.includes('moving_piston') && !p.includes('air'));
});
