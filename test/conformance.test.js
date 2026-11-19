// Regression guard: every supported tickwright capture (real Minecraft 26.3) must match at the
// state, phase and order levels. Skipped when vendor/tickwright has not been fetched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTraces, readTrace, runTrace, compare } from '../conformance/run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const have = fs.existsSync(path.join(ROOT, 'vendor', 'tickwright', 'traces'));

test('matches real-game captures at every level', { skip: !have && 'run node scripts/fetch-tickwright.js' }, () => {
  const failures = [];
  let ran = 0;
  for (const file of loadTraces()) {
    const trace = readTrace(file);
    let run;
    try {
      run = runTrace(trace);
    } catch (e) {
      if (e.constructor.name === 'Unsupported') continue;
      failures.push(`${trace.fixture}: ${e.message}`);
      continue;
    }
    ran++;
    const diff = compare(trace, run);
    for (const level of ['state', 'phase', 'order']) {
      if (diff[level]) failures.push(`${trace.fixture} [${level}]`);
    }
  }
  assert.ok(ran >= 600, `expected at least 600 supported captures, ran ${ran}`);
  assert.deepEqual(failures, []);
});
