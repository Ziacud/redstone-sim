// Sculk sensors and the vibration system (SculkSensorBlock, CalibratedSculkSensorBlock,
// SculkSensorBlockEntity, VibrationSystem.Listener/Ticker, VibrationSelector), plus the amethyst
// block they resonate through. Game events reach the sensors through World.gameEvent; only the
// events blocks emit are simulated (no entities: no steps, projectiles, eating...).

import { defineBlock } from './base.js';
import { makeState, withProp } from '../state.js';
import { F } from '../world.js';
import { ALL, dirByName, pos as blockPos } from '../dir.js';

// GameEventTags.VIBRATIONS (data/minecraft/tags/game_event/vibrations.json)
const VIBRATIONS = new Set([
  'block_attach', 'block_change', 'block_close', 'block_destroy', 'block_detach', 'block_open',
  'block_place', 'block_activate', 'block_deactivate', 'container_close', 'container_open', 'drink',
  'eat', 'elytra_glide', 'entity_damage', 'entity_die', 'entity_dismount', 'entity_interact',
  'entity_mount', 'entity_place', 'entity_action', 'equip', 'explode', 'fluid_pickup', 'fluid_place',
  'hit_ground', 'instrument_play', 'item_interact_finish', 'lightning_strike', 'note_block_play',
  'prime_fuse', 'projectile_land', 'projectile_shoot', 'shear', 'splash', 'step', 'swim', 'teleport',
  'unequip', 'flap',
  ...Array.from({ length: 15 }, (_, i) => `resonate_${i + 1}`),
]);

// VibrationSystem.VIBRATION_FREQUENCY_FOR_EVENT (0 for anything else)
const FREQUENCY = {
  step: 1, swim: 1, flap: 1,
  projectile_land: 2, hit_ground: 2, splash: 2,
  item_interact_finish: 3, projectile_shoot: 3, instrument_play: 3,
  entity_action: 4, elytra_glide: 4, unequip: 4,
  entity_dismount: 5, equip: 5,
  entity_interact: 6, shear: 6, entity_mount: 6,
  entity_damage: 7,
  drink: 8, eat: 8,
  container_close: 9, block_close: 9, block_deactivate: 9, block_detach: 9,
  container_open: 10, block_open: 10, block_activate: 10, block_attach: 10, prime_fuse: 10, note_block_play: 10,
  block_change: 11,
  block_destroy: 12, fluid_pickup: 12,
  block_place: 13, fluid_place: 13,
  entity_place: 14, lightning_strike: 14, teleport: 14,
  entity_die: 15, explode: 15,
};
for (let i = 1; i <= 15; i++) FREQUENCY[`resonate_${i}`] = i;
export const frequencyOf = (event) => FREQUENCY[event] ?? 0;

const WOOLS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOOL = new Set(WOOLS.map((c) => `${c}_wool`)); // BlockTags.OCCLUDES_VIBRATION_SIGNALS
const DAMPENS = new Set([...WOOL, ...WOOLS.map((c) => `${c}_carpet`)]); // BlockTags.DAMPENS_VIBRATIONS
const RESONATORS = new Set(['amethyst_block']); // BlockTags.VIBRATION_RESONATORS

/** VibrationSystem.getRedstoneStrengthForDistance */
function strengthForDistance(distance, radius) {
  return Math.max(1, 15 - Math.floor((15.0 / radius) * distance));
}

const frac = (v) => v - Math.floor(v);
const lerp = (d, a, b) => a + d * (b - a);

/** BlockGetter.isBlockInLine with a state predicate (BlockGetter.traverseBlocks). */
function blockInLine(world, from, to, test) {
  if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2]) return false;
  const tx = lerp(-1.0e-7, to[0], from[0]);
  const ty = lerp(-1.0e-7, to[1], from[1]);
  const tz = lerp(-1.0e-7, to[2], from[2]);
  const fx = lerp(-1.0e-7, from[0], to[0]);
  const fy = lerp(-1.0e-7, from[1], to[1]);
  const fz = lerp(-1.0e-7, from[2], to[2]);
  let x = Math.floor(fx);
  let y = Math.floor(fy);
  let z = Math.floor(fz);
  const hit = () => test(world.getBlockState(blockPos(x, y, z)));
  if (hit()) return true;
  const dx = tx - fx;
  const dy = ty - fy;
  const dz = tz - fz;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  const ddx = sx === 0 ? Number.MAX_VALUE : sx / dx;
  const ddy = sy === 0 ? Number.MAX_VALUE : sy / dy;
  const ddz = sz === 0 ? Number.MAX_VALUE : sz / dz;
  let px = ddx * (sx > 0 ? 1.0 - frac(fx) : frac(fx));
  let py = ddy * (sy > 0 ? 1.0 - frac(fy) : frac(fy));
  let pz = ddz * (sz > 0 ? 1.0 - frac(fz) : frac(fz));
  while (px <= 1.0 || py <= 1.0 || pz <= 1.0) {
    if (px < py) {
      if (px < pz) {
        x += sx;
        px += ddx;
      } else {
        z += sz;
        pz += ddz;
      }
    } else if (py < pz) {
      y += sy;
      py += ddy;
    } else {
      z += sz;
      pz += ddz;
    }
    if (hit()) return true;
  }
  return false;
}

const NUDGE = Math.fround(1.0e-5); // Vec3.relative(direction, 1.0E-5f)

/** VibrationSystem.Listener.isOccluded: blocked only if all 6 nudged lines hit wool. */
function isOccluded(world, origin, dest) {
  const from = [Math.floor(origin[0]) + 0.5, Math.floor(origin[1]) + 0.5, Math.floor(origin[2]) + 0.5];
  const to = [Math.floor(dest[0]) + 0.5, Math.floor(dest[1]) + 0.5, Math.floor(dest[2]) + 0.5];
  for (const d of ALL) {
    const nudged = [from[0] + d.x * NUDGE, from[1] + d.y * NUDGE, from[2] + d.z * NUDGE];
    if (!blockInLine(world, nudged, to, (s) => WOOL.has(s.id))) return false;
  }
  return true;
}

// ------------------------------------------------------------------ block entity

/**
 * SculkSensorBlockEntity with its VibrationSystem.Data (current vibration, travel time) and
 * VibrationSelector (the candidate of one game tick). Registered with the world as a game event
 * listener while it exists.
 */
export class SculkSensorBlockEntity {
  constructor(pos, state) {
    this.type = state.id;
    this.pos = pos;
    this.state = state;
    this.removed = false;
    this.lastVibrationFrequency = 0;
    this.vibration = null; // { event, distance, origin: [x, y, z] }
    this.travelTime = 0;
    this.candidate = null; // { vibration, tick }
  }

  get listensToVibrations() { return true; }
  get calibrated() { return this.state.id === 'calibrated_sculk_sensor'; }
  get radius() { return this.calibrated ? 16 : 8; }
  isValid(state) { return state.id === this.state.id; }

  /** BlockEntity.setChanged (VibrationUser.onDataChanged): wakes comparators. */
  setChanged(world) {
    world.changed.add(this.pos.key);
    if (!this.state.block.isAir) world.updateNeighbourForOutputSignal(this.pos, this.state.block);
  }

  /** CalibratedSculkSensorBlockEntity.VibrationUser.getBackSignal */
  backSignal(world) {
    const d = dirByName(this.state.props.facing).opposite;
    return world.getSignal(this.pos.rel(d), d);
  }

  /** VibrationUser.canReceiveVibration (the calibrated sensor first checks its frequency input) */
  canReceive(world, src, event) {
    if (this.calibrated) {
      const want = this.backSignal(world);
      if (want !== 0 && frequencyOf(event) !== want) return false;
    }
    if (src.x === this.pos.x && src.y === this.pos.y && src.z === this.pos.z && (event === 'block_destroy' || event === 'block_place')) return false;
    if (frequencyOf(event) === 0) return false;
    return canActivate(this.state);
  }

  /** GameEventDispatcher range check + VibrationSystem.Listener.handleGameEvent */
  handleGameEvent(world, event, src, affected) {
    const dx = this.pos.x - src.x;
    const dy = this.pos.y - src.y;
    const dz = this.pos.z - src.z;
    if (dx * dx + dy * dy + dz * dz > this.radius * this.radius) return;
    if (this.vibration) return;
    // isValidVibration (no entities: only the affected block state can dampen)
    if (!VIBRATIONS.has(event)) return;
    if (affected && DAMPENS.has(affected.id)) return;
    if (!this.canReceive(world, src, event)) return;
    const origin = [src.x + 0.5, src.y + 0.5, src.z + 0.5];
    const dest = [this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5];
    if (isOccluded(world, origin, dest)) return;
    const distance = Math.fround(Math.hypot(origin[0] - dest[0], origin[1] - dest[1], origin[2] - dest[2]));
    this.addCandidate({ event, distance, origin }, world.time);
  }

  /** VibrationSelector.addCandidate */
  addCandidate(v, tick) {
    const c = this.candidate;
    let replace;
    if (!c) replace = true;
    else if (tick !== c.tick) replace = false;
    else if (v.distance < c.vibration.distance) replace = true;
    else if (v.distance > c.vibration.distance) replace = false;
    else replace = frequencyOf(v.event) > frequencyOf(c.vibration.event);
    if (replace) this.candidate = { vibration: v, tick };
  }

  /** VibrationSystem.Ticker.tick */
  tick(world) {
    if (!this.vibration && this.candidate && this.candidate.tick < world.time) {
      this.vibration = this.candidate.vibration;
      this.travelTime = Math.floor(this.vibration.distance);
      this.setChanged(world);
      this.candidate = null;
    }
    if (!this.vibration) return;
    let changed = this.travelTime > 0;
    this.travelTime = Math.max(0, this.travelTime - 1);
    if (this.travelTime <= 0) changed = this.receive(world);
    if (changed) this.setChanged(world);
  }

  /** Ticker.receiveVibration + VibrationUser.onReceiveVibration */
  receive(world) {
    const v = this.vibration;
    // requiresAdjacentChunksToBeTicking: waits while a chunk around the sensor is not ticking
    const cx = this.pos.x >> 4;
    const cz = this.pos.z >> 4;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let z = cz - 1; z <= cz + 1; z++) {
        if (world.frozenChunks.has(`${x},${z}`)) return false;
      }
    }
    const ox = Math.floor(v.origin[0]);
    const oy = Math.floor(v.origin[1]);
    const oz = Math.floor(v.origin[2]);
    const state = this.state;
    if (canActivate(state)) {
      const freq = frequencyOf(v.event);
      this.lastVibrationFrequency = freq;
      const dist = Math.fround(Math.sqrt((ox - this.pos.x) ** 2 + (oy - this.pos.y) ** 2 + (oz - this.pos.z) ** 2));
      state.block.activate(world, this.pos, state, strengthForDistance(dist, this.radius), freq);
    }
    this.vibration = null;
    return true;
  }

  save() {
    const v = this.vibration;
    const c = this.candidate;
    return {
      lastVibrationFrequency: this.lastVibrationFrequency,
      vibration: v ? { event: v.event, distance: v.distance, origin: v.origin } : null,
      travelTime: this.travelTime,
      candidate: c ? { event: c.vibration.event, distance: c.vibration.distance, origin: c.vibration.origin, tick: c.tick } : null,
    };
  }

  load(data) {
    this.lastVibrationFrequency = data?.lastVibrationFrequency ?? 0;
    const v = data?.vibration;
    this.vibration = v ? { event: v.event, distance: v.distance, origin: [...v.origin] } : null;
    this.travelTime = data?.travelTime ?? 0;
    const c = data?.candidate;
    this.candidate = c ? { vibration: { event: c.event, distance: c.distance, origin: [...c.origin] }, tick: c.tick } : null;
  }
}

// ------------------------------------------------------------------ blocks

const canActivate = (state) => state.props.sculk_sensor_phase === 'inactive';

const sensorBehavior = {
  glyph: 'k',
  isConductor() { return false; },
  /** an 8/16 tall slab on the floor */
  faceSturdy(state, dir) { return dir.name === 'down'; },
  isSignalSource() { return true; },
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new SculkSensorBlockEntity(pos, state); },
  activeTicks: 30,
  reportPower(world, pos, state) { return state.props.power; },

  getSignal(world, pos, state) { return state.props.power; },
  getDirectSignal(world, pos, state, dir) {
    return dir.name === 'up' ? this.getSignal(world, pos, state, dir) : 0;
  },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos, state) {
    const be = world.getBlockEntity(pos);
    if (!(be instanceof SculkSensorBlockEntity)) return 0;
    return state.props.sculk_sensor_phase === 'active' ? be.lastVibrationFrequency : 0;
  },

  tick(world, pos, state) {
    const phase = state.props.sculk_sensor_phase;
    if (phase === 'active') this.deactivate(world, pos, state);
    else if (phase === 'cooldown') world.setBlock(pos, withProp(state, 'sculk_sensor_phase', 'inactive'), F.ALL);
  },
  onPlace(world, pos, state, oldState) {
    if (state.block === oldState.block) return;
    if (state.props.power > 0 && !world.hasScheduledTick(pos, this)) {
      world.setBlock(pos, withProp(state, 'power', 0), F.CLIENTS | F.KNOWN_SHAPE);
    }
  },
  affectNeighborsAfterRemoval(world, pos, state) {
    if (state.props.sculk_sensor_phase === 'active') this.updateNeighbours(world, pos);
  },
  updateNeighbours(world, pos) {
    world.updateNeighborsAt(pos, this);
    world.updateNeighborsAt(pos.below(), this);
  },
  deactivate(world, pos, state) {
    world.setBlock(pos, withProp(withProp(state, 'sculk_sensor_phase', 'cooldown'), 'power', 0), F.ALL);
    world.scheduleTick(pos, this, 10);
    this.updateNeighbours(world, pos);
  },
  activate(world, pos, state, power, frequency) {
    world.setBlock(pos, withProp(withProp(state, 'sculk_sensor_phase', 'active'), 'power', power), F.ALL);
    world.scheduleTick(pos, this, this.activeTicks);
    this.updateNeighbours(world, pos);
    // tryResonateVibration: amethyst next to it repeats the frequency
    for (const d of ALL) {
      const rp = pos.rel(d);
      const rs = world.getBlockState(rp);
      if (RESONATORS.has(rs.id)) world.gameEvent(`resonate_${frequency}`, rp, rs);
    }
  },
};

const sensorProps = {
  sculk_sensor_phase: ['inactive', 'active', 'cooldown'],
  power: [...Array(16).keys()],
  waterlogged: [false, true],
};

defineBlock({
  ...sensorBehavior,
  id: 'sculk_sensor',
  color: 0x0d5f6e,
  properties: sensorProps,
});

defineBlock({
  ...sensorBehavior,
  id: 'calibrated_sculk_sensor',
  color: 0x6b3fa0,
  properties: { facing: ['north', 'south', 'west', 'east'], ...sensorProps },
  activeTicks: 10,
  /** the face it takes the frequency from gives no signal */
  getSignal(world, pos, state, dir) {
    return dir.name !== state.props.facing ? state.props.power : 0;
  },
  getStateForPlacement(world, pos, props) {
    return makeState(this, props);
  },
});

defineBlock({ id: 'amethyst_block', color: 0x8561c5, glyph: '#' });
