#!/usr/bin/env node
// MCP server (stdio) + live 3D viewer (HTTP/WebSocket) for the redstone simulator.
// stdout belongs to the MCP transport: log only to stderr.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Simulation, blockCatalog } from './sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error('[redstone-sim]', ...a);
const viewerOnly = process.argv.includes('--viewer-only');
const BASE_PORT = Number(process.env.REDSTONE_SIM_PORT || 3700);

const sim = new Simulation({ designsDir: path.join(ROOT, 'designs') });
let viewerUrl = null;

const loadArg = process.argv.indexOf('--load');
if (loadArg > 0 && process.argv[loadArg + 1]) {
  try {
    sim.load(process.argv[loadArg + 1]);
  } catch (e) {
    log('could not load design:', e.message);
  }
}

// ------------------------------------------------------------------ HTTP + WebSocket viewer

const STATIC = {
  '/': path.join(ROOT, 'public', 'index.html'),
  '/viewer.js': path.join(ROOT, 'public', 'viewer.js'),
  '/i18n.js': path.join(ROOT, 'public', 'i18n.js'),
  '/three.module.js': path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'),
  '/three.core.js': path.join(ROOT, 'node_modules', 'three', 'build', 'three.core.js'),
  '/OrbitControls.js': path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// JSON API for the page: designs (list, load, save, delete, download), importing a file from the
// user's computer (.json design or .mcfunction), exporting the world, a new empty world.
const MAX_BODY = 64 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('file too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const sendJson = (res, code, data) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
const sendFile = (res, name, type, text) =>
  res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${encodeURIComponent(name)}"` }).end(text);

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
  switch (route) {
    case 'GET /api/designs':
      return sendJson(res, 200, sim.listDesignFiles());
    case 'POST /api/designs/load':
      sim.load(body.name);
      return sendJson(res, 200, { ok: true });
    case 'POST /api/designs/save':
      sim.save(body.name);
      return sendJson(res, 200, { ok: true });
    case 'POST /api/designs/delete':
      sim.deleteDesign(body.name);
      return sendJson(res, 200, { ok: true });
    case 'GET /api/designs/file': {
      const name = url.searchParams.get('name');
      return sendFile(res, `${name}.json`, 'application/json', fs.readFileSync(sim.designPath(name)));
    }
    case 'GET /api/world.json':
      return sendFile(res, `${sim.designName ?? 'world'}.json`, 'application/json', JSON.stringify(sim.serialize()));
    case 'GET /api/world.mcfunction':
      return sendFile(res, `${sim.designName ?? 'world'}.mcfunction`, 'text/plain; charset=utf-8', sim.exportMcfunction());
    case 'POST /api/new':
      sim.newWorld({ floor: 32 });
      return sendJson(res, 200, { ok: true });
    case 'POST /api/import': {
      const { filename = '', text = '', save = false } = body;
      const base = filename.replace(/\.[^.]*$/, '').replace(/[^\w\-. ]/g, '_') || 'imported';
      let info = {};
      if (/\.mcfunction$/i.test(filename)) info = sim.importMcfunction(text);
      else {
        const data = JSON.parse(text);
        if (data.format !== 'redstone-sim/1') throw new Error('not a redstone-sim design file');
        sim.deserialize(data);
      }
      if (save) sim.save(base);
      return sendJson(res, 200, { ok: true, name: save ? base : null, ...info });
    }
    default:
      return sendJson(res, 404, { error: 'not found' });
  }
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => sendJson(res, 400, { error: e.message }));
    return;
  }
  const file = STATIC[url.pathname];
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', ...sim.snapshot() }));
  const unsubscribe = sim.subscribe((text) => ws.readyState === 1 && ws.send(text));
  ws.on('close', unsubscribe);
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'use') sim.use(m.x, m.y, m.z);
      else if (m.type === 'pause') sim.setRunning(false);
      else if (m.type === 'resume') sim.setRunning(true);
      else if (m.type === 'step') sim.step(Math.max(1, Math.min(10000, m.n | 0 || 1)));
      else if (m.type === 'tps') sim.setTps(m.tps);
      else if (m.type === 'restart') sim.restart();
      else if (m.type === 'chunk') sim.toggleChunk(m.cx | 0, m.cz | 0);
      else if (m.type === 'thaw') sim.thawAll();
      else if (m.type === 'trap') sim.setTrap(m);
      else if (m.type === 'untrap') sim.clearTrap();
      else if (m.type === 'paper') sim.setPaper(m.on);
      sim.flush();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

function listen(port, attemptsLeft) {
  httpServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) listen(port + 1, attemptsLeft - 1);
    else log('viewer disabled:', err.message);
  });
  httpServer.listen(port, '127.0.0.1', () => {
    viewerUrl = `http://localhost:${port}/`;
    log(`viewer at ${viewerUrl}`);
  });
}
listen(BASE_PORT, 9);

// ------------------------------------------------------------------ MCP tools

const coord = z.number().int();
const xyz = { x: coord, y: coord, z: coord };
const triple = z.tuple([coord, coord, coord]);

function text(t) {
  return { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] };
}

function tool(server, name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const out = await handler(args ?? {});
      sim.flush();
      return text(out);
    } catch (e) {
      sim.flush();
      return { ...text(`Error: ${e.message}`), isError: true };
    }
  });
}

function waveform(values) {
  return values.map((v) => (v === null ? '_' : v === 0 ? '.' : v.toString(16))).join('');
}

function buildMcpServer() {
  const server = new McpServer({ name: 'redstone-sim', version: '0.1.0' });

  tool(
    server,
    'world_info',
    'Simulator status: game time, running/paused, ticks per second, viewer URL, occupied bounds, block count. ' +
      'The simulator emulates Minecraft Java Edition 26.3 redstone (redstone experiments off) at game-tick (gt) resolution; 1 redstone tick = 2 gt. ' +
      'Its update order is verified against real-game captures (tickwright fixtures).',
    {},
    () => ({
      ...sim.status(),
      viewer: viewerUrl ?? 'unavailable (port in use)',
      bounds: sim.world.bounds(),
      blocks: sim.world.blocks.size,
      pendingScheduledTicks: sim.world.pendingTicks.size,
    }),
  );

  tool(server, 'list_blocks', 'Supported blocks, their properties and the facing conventions. Read this before building.', {}, () =>
    blockCatalog(),
  );

  tool(
    server,
    'set_blocks',
    'Place or remove blocks, in order. Each block is a Minecraft block-state string, e.g. "stone", ' +
      '"repeater[out=east,delay=2]", "redstone_wall_torch[facing=north]", "lever[face=wall,facing=west]", "air" (= break). ' +
      'mode "place" (default) behaves like a player: support is required (dust/torches/repeaters need a block under them, place supports first) ' +
      'and the usual block updates fire. mode "setblock" behaves like /setblock. Errors are reported per entry; later entries still run.',
    {
      blocks: z
        .array(z.object({ ...xyz, block: z.string() }))
        .min(1)
        .max(5000),
      mode: z.enum(['place', 'setblock']).optional(),
    },
    ({ blocks, mode }) => {
      const errors = [];
      let ok = 0;
      for (const b of blocks) {
        try {
          sim.setBlock(b.x, b.y, b.z, b.block, mode ?? 'place');
          ok++;
        } catch (e) {
          errors.push(`(${b.x},${b.y},${b.z}) ${b.block}: ${e.message}`);
        }
      }
      return `placed ${ok}/${blocks.length}${errors.length ? `\nerrors:\n${errors.join('\n')}` : ''}`;
    },
  );

  tool(
    server,
    'fill',
    'Fill a box (inclusive corners) with one block, like /fill. Use "air" to clear. Iterates y from bottom to top so supports come first.',
    { from: triple, to: triple, block: z.string(), mode: z.enum(['place', 'setblock']).optional() },
    ({ from, to, block, mode }) => {
      const [x1, x2] = [Math.min(from[0], to[0]), Math.max(from[0], to[0])];
      const [y1, y2] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
      const [z1, z2] = [Math.min(from[2], to[2]), Math.max(from[2], to[2])];
      const n = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
      if (n > 50000) throw new Error(`fill of ${n} blocks is too large (max 50000)`);
      const errors = [];
      for (let y = y1; y <= y2; y++)
        for (let zz = z1; zz <= z2; zz++)
          for (let x = x1; x <= x2; x++) {
            try {
              sim.setBlock(x, y, zz, block, mode ?? 'place');
            } catch (e) {
              if (errors.length < 20) errors.push(`(${x},${y},${zz}): ${e.message}`);
            }
          }
      return `filled ${n} positions${errors.length ? `\nerrors (first 20):\n${errors.join('\n')}` : ''}`;
    },
  );

  tool(
    server,
    'view_region',
    'Text view of a box, one top-down grid per y layer (top layer first, empty layers skipped). Rows = z (north at top), columns = x. ' +
      'Cells: " . " air, "###" solid (#NN = solid powered at NN), "XXX" obsidian, "ggg" glass, "wNN" dust at power NN, "[R]" redstone block, ' +
      '"t+ "/"t- " torch lit/unlit, "t→+" wall torch pointing east, "Lf+" floor lever on (Lc = ceiling, L→ = wall lever facing east), "b.." button, ' +
      '"r→2" repeater outputting east delay 2 (R = powered, x instead of delay = locked), "c→c"/"c→s" comparator compare/subtract (C = powered), ' +
      '"O+ "/"o- " lamp, "U*+" copper bulb (* lit / o unlit, + powered), "TTT" soil, "~~~" water, " | " sugar cane, "v→+" observer WATCHING east (outputs west), "p→-" piston facing east (P = sticky, + extended), "h→=" head, "m→~" moving block, "BNN" barrel output. ' +
      'Arrows: ↑ north, ↓ south, → east, ← west, U up, D down. Omit from/to to view everything.',
    { from: triple.optional(), to: triple.optional() },
    ({ from, to }) => {
      if (!from || !to) {
        const b = sim.world.bounds();
        if (!b) return '(world is empty)';
        from = from ?? b.min;
        to = to ?? b.max;
      }
      return sim.renderRegion(from, to);
    },
  );

  tool(
    server,
    'inspect',
    'Full detail for one position: block state, displayed power, conductor/source flags, pending scheduled ticks, signal received from each side, block entity data.',
    xyz,
    ({ x, y, z: zz }) => sim.inspect(x, y, zz),
  );

  tool(
    server,
    'interact',
    'Act on a block like a player between ticks. action "use" (default): flip lever, press button, cycle repeater delay, toggle comparator mode, toggle dust dot/cross. ' +
      'action "set_signal": set a barrel\'s comparator output to value (0-15).',
    { ...xyz, action: z.enum(['use', 'set_signal']).optional(), value: z.number().int().min(0).max(15).optional() },
    ({ x, y, z: zz, action, value }) =>
      action === 'set_signal' ? sim.setSignal(x, y, zz, value ?? 0) : sim.use(x, y, zz),
  );

  tool(
    server,
    'run_ticks',
    'Pause real time and run N game ticks deterministically, recording probes after every tick. ' +
      'Waveforms use one char per sample (first sample = before the first tick): "." = 0, 1-9/a-f = power 1-15, "_" = air/not a power holder. ' +
      'Probe values: dust = power, torch/lamp/lever/observer = 0 or 15, repeater/comparator = output, piston = 15 when extended, solid block = how strongly it is powered. ' +
      'actions run between ticks: at=k runs before tick k+1 (at=0 = before the first tick). Action kinds: use (default), set_signal (value), place (block), break. ' +
      'Real time stays paused afterwards if it was paused before.',
    {
      ticks: z.number().int().min(1).max(100000),
      probes: z.array(z.object({ ...xyz, label: z.string().optional() })).max(32).optional(),
      actions: z
        .array(
          z.object({
            at: z.number().int().min(0),
            ...xyz,
            action: z.enum(['use', 'set_signal', 'place', 'break']).optional(),
            value: z.number().int().optional(),
            block: z.string().optional(),
          }),
        )
        .max(1000)
        .optional(),
    },
    ({ ticks, probes = [], actions = [] }) => {
      const r = sim.runTicks(ticks, probes, actions);
      const lines = [`ran ${ticks} gt: time ${r.start} -> ${r.end}`];
      probes.forEach((p, i) => {
        const vals = r.series[i];
        const changes = [];
        for (let t = 1; t < vals.length; t++) if (vals[t] !== vals[t - 1]) changes.push(`+${t}:${vals[t - 1] ?? '_'}→${vals[t] ?? '_'}`);
        const name = p.label ?? `(${p.x},${p.y},${p.z})`;
        const wave = vals.length <= 400 ? waveform(vals) : `${waveform(vals.slice(0, 400))}… (truncated)`;
        lines.push(`${name}: ${wave}`, `  edges: ${changes.slice(0, 60).join(' ') || 'none'}${changes.length > 60 ? ' …' : ''}`);
      });
      if (r.log.length) lines.push('actions:', ...r.log);
      return lines.join('\n');
    },
  );

  tool(
    server,
    'sim_control',
    'Control real-time simulation shown in the viewer: pause, resume, step (value = ticks), set_tps (value = ticks per second, vanilla = 20).',
    { action: z.enum(['pause', 'resume', 'step', 'set_tps']), value: z.number().optional() },
    ({ action, value }) => {
      if (action === 'pause') sim.setRunning(false);
      else if (action === 'resume') sim.setRunning(true);
      else if (action === 'step') sim.step(Math.max(1, Math.min(100000, value ?? 1)));
      else if (action === 'set_tps') sim.setTps(value ?? 20);
      return sim.status();
    },
  );

  tool(
    server,
    'chunk_control',
    'Simulate server conditions. action "restart": save + reload (queued block events are lost; scheduled ticks and moving pistons survive). ' +
      'action "freeze": chunks stop ticking (lazy/unloaded: no scheduled ticks, block events or moving pistons there). action "thaw": chunks tick again. ' +
      'chunks = [[cx, cz], ...] chunk coordinates (block x >> 4, z >> 4); thaw without chunks thaws all. Use with run_ticks to stress-test machines.',
    {
      action: z.enum(['restart', 'freeze', 'thaw']),
      chunks: z.array(z.tuple([coord, coord])).optional(),
    },
    ({ action, chunks }) => {
      const w = sim.world;
      if (action === 'restart') w.simulateRestart();
      else if (action === 'freeze') for (const [cx, cz] of chunks ?? []) w.frozenChunks.add(`${cx},${cz}`);
      else if (chunks?.length) for (const [cx, cz] of chunks) w.frozenChunks.delete(`${cx},${cz}`);
      else w.frozenChunks.clear();
      return { action, frozenChunks: [...w.frozenChunks] };
    },
  );

  tool(
    server,
    'clear_world',
    'Start a fresh empty world. Optionally lay a square floor of `floor` x `floor` blocks at y=floorY from (0,floorY,0). Unsaved work is lost.',
    { floor: z.number().int().min(0).max(256).optional(), floorBlock: z.string().optional(), floorY: coord.optional() },
    ({ floor, floorBlock, floorY }) => {
      sim.newWorld({ floor: floor ?? 32, floorBlock: floorBlock ?? 'smooth_stone', floorY: floorY ?? 0 });
      return `new world, floor ${floor ?? 32}x${floor ?? 32} at y=${floorY ?? 0}`;
    },
  );

  tool(server, 'save_design', 'Save the whole world (blocks, block entities, pending ticks) to designs/<name>.json.', { name: z.string() }, ({ name }) =>
    `saved to ${sim.save(name)}`,
  );

  tool(server, 'load_design', 'Replace the world with designs/<name>.json.', { name: z.string() }, ({ name }) => {
    sim.load(name);
    return `loaded ${name}: ${sim.world.blocks.size} blocks, time ${sim.world.time}`;
  });

  tool(server, 'list_designs', 'List saved designs.', {}, () => sim.listDesigns().join('\n') || '(none)');

  tool(
    server,
    'export_mcfunction',
    'Export the world as Minecraft /setblock commands (relative ~ coordinates from origin) and write designs/<name>.mcfunction. ' +
      'Supports go first. Paste into a datapack function or run line by line in a real world.',
    { name: z.string(), origin: triple.optional() },
    ({ name, origin }) => {
      const body = sim.exportMcfunction(origin ?? [0, 0, 0]);
      const file = sim.designPath(name).replace(/\.json$/, '.mcfunction');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return `wrote ${file} (${body.split('\n').length - 1} commands)`;
    },
  );

  return server;
}

if (!viewerOnly) {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  process.stdin.on('end', () => process.exit(0));
  await server.connect(transport);
  log('MCP server ready on stdio');
} else {
  log('viewer-only mode (no MCP)');
}
