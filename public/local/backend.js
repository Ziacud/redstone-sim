// Runs the simulator inside the page when there is no server (e.g. GitHub Pages): the same
// Simulation class server/index.js uses, behind a WebSocket-like object and the viewer's /api
// routes. Loaded only in that mode (see index.html and viewer.js), so the Node-served viewer never
// pulls in the engine.

import { Simulation } from '../../server/sim.js';
import { seed } from 'node:fs';

const SHIPPED = [
  'demo', 'example-flying-machine', 'example-item-sorter', 'example-hopper-clock', 'example-auto-crafter',
  'example-t-flip-flop',
];

const pipe = async (bytes, stream) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function start() {
  // the shipped designs (not stored: a newer version of the page brings newer ones)
  const texts = await Promise.all(
    SHIPPED.map(async (name) => {
      try {
        const r = await fetch(new URL(`../../designs/${name}.json`, import.meta.url));
        return r.ok ? await r.text() : null;
      } catch {
        return null; // missing: leave it out
      }
    }),
  );
  // seeded in SHIPPED order, so the design list shows them in that order
  SHIPPED.forEach((name, i) => texts[i] !== null && seed(`designs/${name}.json`, texts[i]));
  const sim = new Simulation({
    designsDir: 'designs',
    gzip: (b) => pipe(b, new CompressionStream('gzip')),
    gunzip: (b) => pipe(b, new DecompressionStream('gzip')),
  });
  try {
    sim.load('demo');
  } catch {
    // keep the empty floor
  }

  async function call(href, body) {
    const url = new URL(href, location.href);
    const method = body === undefined ? 'GET' : 'POST';
    const out = await sim.handleApi(method, url.pathname.replace(/^.*(?=\/api\/)/, ''), url.searchParams, body ?? {});
    if (!out) throw new Error('not found');
    return out;
  }

  return {
    sim,

    /** Same contract as the server's api(): the JSON answer, or an Error with the message. */
    async api(href, body) {
      const out = await call(href, body);
      if (out.json === undefined) throw new Error('not a JSON route');
      return out.json;
    },

    /** A file route (downloads): { name, type, data }. */
    async file(href) {
      const out = await call(href);
      if (!out.file) throw new Error('not a file route');
      return out.file;
    },

    /** A WebSocket look-alike, wired like the server's 'connection' handler. */
    socket() {
      const ws = { readyState: 0, onopen: null, onmessage: null, onclose: null };
      const deliver = (text) => ws.readyState === 1 && ws.onmessage?.({ data: text });
      ws.send = (text) => {
        try {
          sim.handleMessage(JSON.parse(text));
        } catch (e) {
          deliver(JSON.stringify({ type: 'error', message: e.message }));
        }
      };
      ws.close = () => {};
      queueMicrotask(() => {
        ws.readyState = 1;
        ws.onopen?.();
        deliver(JSON.stringify({ type: 'snapshot', ...sim.snapshot() }));
        sim.subscribe(deliver);
      });
      return ws;
    },
  };
}
