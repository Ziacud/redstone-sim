# redstone-sim

A tick-exact simulator of Minecraft **Java Edition** redstone, with an MCP server (so an AI
assistant such as Claude can build and test circuits) and a live 3D web viewer.

[Türkçe](README.tr.md)

- Matches the real game, block change by block change, on **all 688** real Minecraft 26.3
  captures that use only supported blocks (another 1551 captures need blocks or features it does
  not have yet; see [Accuracy](#accuracy)).
- Pistons, sticky pistons, slime and honey, observers, quasi-connectivity and BUDs, 0-ticks,
  block dropping, update skipping, torch burnout, flying machines.
- **Server conditions:** frozen (unloaded or lazy) chunks, server restarts, and chunk-border
  traps that stop a flying machine the way a busy server does.
- Headless and deterministic: run thousands of what-if cases from a script, or watch one in 3D.
- Reads real Java worlds (Anvil region files) and writes `.mcfunction` files you can paste into
  the game.

## How it works

The simulator does not use a simplified component list. Vanilla's execution model was ported
to JavaScript (some engine files name the vanilla class they port, e.g. `engine/updater.js` ports
`CollectingNeighborUpdater`):

- scheduled ticks (by trigger time, then priority, then insertion order), deduplicated per block
- neighbour updates in vanilla order (W, E, D, U, N, S) through a depth-first collecting updater
- shape updates as a separate channel (observers see them)
- vanilla's phase order in every game tick: scheduled ticks → block events (pistons) → block
  entities (moving pistons)
- redstone dust's `HashSet` iteration order reproduced bucket for bucket, so location-dependent
  dust behaves as in game

## Supported blocks

Redstone dust, redstone torch (floor and wall, burnout), lever, stone and oak buttons, repeater
(delay, locking), comparator (compare / subtract, container reading), redstone lamp, observer,
piston and sticky piston (12-block push limit, quasi-connectivity, block dropping, slime and
honey), redstone block, copper bulbs (every oxidation stage, waxed or not), wooden and iron
trapdoors, glass, slabs, obsidian, concrete, wool, stone variants, and the farm blocks dirt,
grass, sand, farmland, water (a static source: flow is not simulated), sugar cane, melon,
pumpkin and their stems.

Not simulated (yet): entities, fluid flow, light, the redstone experiments, and blocks such as
hoppers, chests, note blocks, dispensers and droppers, composters, crafters, sculk sensors,
rails, doors, tripwire hooks, bells, lecterns, TNT and leaves.

## Install

Node.js 20 or newer.

```bash
npm install
```

### 3D viewer only

```bash
node server/index.js --viewer-only --load demo
```

Open http://localhost:3700/. The UI is in English or Turkish (button at the top of the side
panel; the default follows your browser language).

- **Designs:** saved worlds in `designs/` (click to load; download; delete). **Open file** or
  drag and drop a `.json` design or a `.mcfunction`: its `setblock` and `fill` commands run as
  they do in game.
- **This world:** save under a name, download as `.json` or `.mcfunction`, start an empty world.
- **Server test:** a vanilla-style restart, chunk freezing (`C`, then click a block: that chunk
  gets no ticks and shows blue), and a chunk-border trap (`T`): every time a machine tries to
  cross the border, the far side stops ticking (or a plugin cancels the piston move) for the
  time you set.
- **Paper piston behaviour:** Paper's piston move order (`allow-piston-duplication: false`).

### With Claude Code (MCP)

`.mcp.json` in the project root registers the server. Start Claude Code in this folder and
approve the `redstone-sim` server; the `world_info` tool tells you the viewer address (usually
http://localhost:3700/). Other MCP clients: run `node server/index.js` over stdio.

| Tool | What it does |
|---|---|
| `world_info` | Game time, running or paused, tps, viewer address, occupied bounds, block count |
| `list_blocks` | Blocks, properties and facing conventions |
| `set_blocks`, `fill` | Place and break blocks like a player or like `/setblock` |
| `view_region` | Layer-by-layer text map |
| `inspect` | One block: state, power, pending ticks, incoming signals |
| `interact` | Levers, buttons, repeater delay, comparator mode, barrel signal |
| `run_ticks` | Run a number of ticks; returns waveforms and edge lists from probes |
| `sim_control` | Pause, resume, step, set tps |
| `chunk_control` | Freeze / thaw chunks, simulate a server restart |
| `clear_world` | Start over |
| `save_design`, `load_design`, `list_designs` | Save to and load from `designs/` |
| `export_mcfunction` | `/setblock` commands for real Minecraft |

## Server conditions: restarts and unloaded chunks

`World.simulateRestart()` and `World.frozenChunks` model what a server does to a machine:

- **Restart:** queued block events are lost (MC-89146); scheduled ticks and moving pistons are
  saved. Measured on a real 26.1.2 server (paused right after loading, then stepped tick by
  tick against the simulator loading the same save): moving pistons come back with the saved
  progress of the previous tick, and saved scheduled ticks run one tick early.
- **Frozen chunk:** a lazy or unloaded chunk: no scheduled ticks, block events or moving
  pistons run there.

`scripts/restart-test.js` restarts a two-way flying machine at every tick of its cycle (and
freezes the chunk ahead of it, or loads its two chunks one after the other) and counts how
often it keeps flying, stops or breaks.

## Reading a real world

`scripts/mc-world.js` reads blocks, block entities, moving pistons and pending ticks from a
real Java world's region files and turns them into a simulator design:

```bash
node scripts/mc-world.js <world folder> x0 z0 x1 z1 [y0 y1] --save my-build
```

## Accuracy

The engine is checked against block-change traces that the
[tickwright](https://github.com/httptim/tickwright) project (Apache-2.0 OR MIT) recorded in real
Minecraft 26.3. Each fixture runs in all 8 orientations (4 rotations and their mirrors) and is
compared at three levels:

- `state`: every block's state at the end of every tick
- `phase`: each block's changes within a tick, and the tick phase they happened in
- `order`: every block change, neighbour and shape update, scheduled tick and block event, in
  the game's order

**All 688 captures built from supported blocks match at all three levels** (the runner prints
`ran 688 traces, skipped 1551 (unsupported)`). They include location-dependent dust, QC/BUD,
0-ticks, block dropping, update skipping, torch burnout, flying machines and piston doors. The
skipped captures use something the simulator does not have yet: mostly entities (796), the
redstone experiments (112) and water flow (80), the rest blocks such as hoppers, chests, note
blocks, droppers, dispensers and rails.

Two behaviours have no capture: dust and repeaters/comparators popping on the shape update
that removes their support. They were implemented from Pumpkin's 26.3 port and vanilla
1.21.2+ code.

```bash
node scripts/fetch-tickwright.js      # downloads the captures into vendor/tickwright (~14 MB)
node conformance/run.js --verbose     # summary and first differences
```

The fetch script is pinned to the tickwright commit the 688/688 result was measured on.

## Tests

```bash
npm test
```

Unit tests check known timings (repeater delays, lamp 4 gt, torch burnout, observers, piston
timing, QC/BUD, sticky piston block dropping, the 12-block limit), the MCP server end to end,
and every conformance capture (skipped until the captures are downloaded).

## Credits

- [tickwright](https://github.com/httptim/tickwright): real-game captures used for conformance.
- [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin): reference for two behaviours without captures.
- [three.js](https://threejs.org/) for the viewer, the
  [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) for the server.

## License

MIT, see [LICENSE](LICENSE). The tickwright captures that `scripts/fetch-tickwright.js`
downloads keep their own licence (Apache-2.0 OR MIT).

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
