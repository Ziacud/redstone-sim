// Downloads tickwright's fixtures and real-game traces (Apache-2.0 OR MIT,
// https://github.com/httptim/tickwright) into vendor/tickwright for the conformance suite.
// Run: node scripts/fetch-tickwright.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor', 'tickwright');
const REPO = 'httptim/tickwright';
// Pinned to the commit the 688/688 conformance result was measured on; pass a ref to override.
const REF = process.argv[2] ?? '5ad71da4b5449da3605185c91049beb7459fe28a';
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}`;

const tree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`)).json();
if (!tree.tree) throw new Error(`could not list ${REPO}: ${JSON.stringify(tree).slice(0, 200)}`);
const wanted = tree.tree
  .filter((e) => e.type === 'blob')
  .map((e) => e.path)
  .filter((p) => (p.startsWith('fixtures/') && p.endsWith('.json')) || p.startsWith('traces/') || /^(LICENSE-MIT|LICENSE-APACHE|README\.md)$/.test(p));

let done = 0;
const queue = [...wanted];
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    const dest = path.join(OUT, p);
    if (fs.existsSync(dest)) {
      done++;
      continue;
    }
    const res = await fetch(`${RAW}/${p}`);
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    if (++done % 200 === 0) console.log(`${done}/${wanted.length}`);
  }
}
await Promise.all(Array.from({ length: 16 }, worker));
fs.writeFileSync(path.join(OUT, 'SOURCE.txt'), `https://github.com/${REPO} @ ${REF} (tree ${tree.sha})\nDual-licensed Apache-2.0 OR MIT (see LICENSE-*)\n`);
console.log(`done: ${wanted.length} files in ${OUT}`);
