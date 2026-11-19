// End-to-end: spawns the MCP server over stdio and drives it like Claude Code would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
};

test('MCP server: build a repeater line and probe it', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server', 'index.js')],
    cwd: ROOT,
    env: { ...process.env, REDSTONE_SIM_PORT: '3790' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['world_info', 'set_blocks', 'view_region', 'run_ticks', 'interact', 'save_design']) {
      assert.ok(names.includes(n), `tool ${n} exists`);
    }

    await call(client, 'clear_world', { floor: 16 });
    await call(client, 'sim_control', { action: 'pause' });
    const placed = await call(client, 'set_blocks', {
      blocks: [
        { x: 1, y: 1, z: 1, block: 'lever' },
        { x: 2, y: 1, z: 1, block: 'repeater[out=east,delay=3]' },
        { x: 3, y: 1, z: 1, block: 'redstone_wire' },
        { x: 4, y: 1, z: 1, block: 'redstone_lamp' },
        { x: 5, y: 1, z: 5, block: 'redstone_torch' }, // fine: on the floor
        { x: 6, y: 3, z: 1, block: 'redstone_wire' }, // no support: must fail
      ],
    });
    assert.match(placed.text, /placed 5\/6/);
    assert.match(placed.text, /cannot survive/);

    const run = await call(client, 'run_ticks', {
      ticks: 10,
      probes: [{ x: 4, y: 1, z: 1, label: 'lamp' }],
      actions: [{ at: 0, x: 1, y: 1, z: 1 }],
    });
    // repeater delay 3 = 6 gt, then dust and lamp react in the same tick
    assert.match(run.text, /lamp: \.\.\.\.\.\.ffff/);

    const view = await call(client, 'view_region', { from: [0, 1, 0], to: [6, 1, 2] });
    assert.match(view.text, /R→3/);
    assert.match(view.text, /O\+/);

    const bad = await call(client, 'set_blocks', { blocks: [{ x: 0, y: 1, z: 0, block: 'banana' }] });
    assert.match(bad.text, /Unknown block/);
  } finally {
    await client.close();
  }
});
