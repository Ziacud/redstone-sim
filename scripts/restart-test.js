// Stress test: run Engine B (flat, 2 observers), then at every tick of its cycle
//  - restart the server (block events lost),
//  - freeze the chunk ahead while the machine crosses its border (player walking away),
//    then thaw it with or without a restart in between,
//  - restart and load the two chunks one after the other (player logging back in),
// and check the machine keeps flying in one piece.
// Run: node scripts/restart-test.js

import { World, pos, getBlock, makeState } from '../engine/index.js';
import { signature, atRest, minX } from './stress.js';

const Y = 100;
const S = (id, props = {}) => makeState(getBlock(id), props);

/** Engine B: flies east one block per 10 gt. */
export function engineB(w, x0 = 0, z0 = 0) {
  const put = (x, z, id, props) => w.setBlock(pos(x0 + x, Y, z0 + z), S(id, props), 2 | 16);
  put(1, 0, 'observer', { facing: 'west' });
  put(2, 0, 'slime_block');
  put(3, 0, 'sticky_piston', { facing: 'west' });
  put(2, 1, 'sticky_piston', { facing: 'east' });
  put(3, 1, 'slime_block');
  put(4, 1, 'observer', { facing: 'east' });
  return w;
}

/** The capture's kick: a redstone block above the east-facing sticky piston for 2 gt. */
export function kick(w, x0 = 0, z0 = 0) {
  w.setBlock(pos(x0 + 2, Y + 1, z0 + 1), S('redstone_block'), 3);
  w.tick();
  w.tick();
  w.setBlock(pos(x0 + 2, Y + 1, z0 + 1), w.air, 3);
}

function restSignature(w) {
  for (let i = 0; i < 40 && !atRest(w); i++) w.tick();
  return signature(w);
}

/** Runs on, then reports 'ok' (flying, intact), 'stopped' (intact, not moving) or 'broken'. */
function outcome(w, ref) {
  const x = minX(w);
  for (let i = 0; i < 150; i++) w.tick();
  const moved = minX(w) - x;
  // sample the shape at the next rest point
  let sig = null;
  for (let i = 0; i < 40; i++) {
    if (atRest(w)) {
      sig = signature(w);
      break;
    }
    w.tick();
  }
  if (sig !== ref) return 'broken';
  return moved >= 10 ? 'ok' : 'stopped';
}

if (process.argv[1]?.endsWith('restart-test.js')) {
  const refW = engineB(new World());
  kick(refW);
  for (let i = 0; i < 30; i++) refW.tick();
  const ref = restSignature(refW);

  const tally = {};
  const note = (name, r) => {
    tally[name] ??= { ok: 0, stopped: 0, broken: 0 };
    tally[name][r]++;
  };

  for (let at = 0; at < 40; at++) {
    // A: full restart at any tick
    {
      const w = engineB(new World());
      kick(w);
      for (let i = 0; i < 20 + at; i++) w.tick();
      w.simulateRestart();
      note('full restart', outcome(w, ref));
    }
    // B/C: chunk x>=16 freezes while the machine is near the border, then thaws (B) or restarts (C)
    for (const restart of [false, true]) {
      for (const hold of [5, 40]) {
        const w = engineB(new World(), 4, 0);
        kick(w, 4, 0);
        for (let i = 0; i < 40 + at; i++) w.tick();
        w.frozenChunks.add(World.chunkKey(16, 0));
        for (let i = 0; i < hold; i++) w.tick();
        if (restart) w.simulateRestart();
        w.frozenChunks.clear();
        note(`border freeze ${hold}gt${restart ? ' + restart' : ''}`, outcome(w, ref));
      }
    }
    // D: restart, then the two chunks load one after the other (either order)
    for (const first of ['west', 'east']) {
      const w = engineB(new World(), 4, 0);
      kick(w, 4, 0);
      for (let i = 0; i < 60 + at; i++) w.tick();
      w.simulateRestart();
      w.frozenChunks.add(World.chunkKey(first === 'west' ? 16 : 0, 0));
      for (let i = 0; i < 7; i++) w.tick();
      w.frozenChunks.clear();
      note(`restart, ${first} chunk ticks 7gt first`, outcome(w, ref));
    }
  }
  console.log('Engine B, 40 tick offsets per scenario:');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(40)} ok ${v.ok}  stopped ${v.stopped}  broken ${v.broken}`);
}
