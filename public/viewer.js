// Live 3D view of the simulator. Receives snapshots/updates over WebSocket. Each block's model is
// built as a THREE.Group occupying [x, x+1]^3, then flattened into its parts (geometry, material,
// matrix), which are drawn as instances (see "world state").

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { t, locale, lang, setLang, applyStatic, onLangChange } from './i18n.js';

// No server (static hosting): the simulator runs in this tab, see local/backend.js.
const LOCAL = window.REDSTONE_LOCAL ? await (await import('./local/backend.js')).start() : null;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1e25);
scene.fog = new THREE.Fog(0x1b1e25, 80, 260);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 1000);
camera.position.set(-10, 22, 38);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(16, 0, 16);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ materials

const edgeTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 30, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
})();

const matCache = new Map();
function mat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color,
      map: opts.edges ? edgeTexture : null,
      transparent: !!opts.opacity,
      opacity: opts.opacity ?? 1,
      depthWrite: !opts.opacity,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    matCache.set(key, m);
  }
  return m;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/** Adds a w*h*d box centered at (cx, cy, cz) in block-local coordinates. */
function box(group, w, h, d, cx, cy, cz, material) {
  const m = new THREE.Mesh(boxGeo, material);
  m.scale.set(w, h, d);
  m.position.set(cx, cy, cz);
  group.add(m);
  return m;
}

const lerpColor = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();

const DIRV = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
};
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };

/** Rotates a model built pointing +Y so that it points toward `dir`, pivoting on the block center. */
function orient(model, dir) {
  const pivot = new THREE.Group();
  pivot.position.set(0.5, 0.5, 0.5);
  model.position.set(-0.5, -0.5, -0.5);
  pivot.add(model);
  const r = {
    up: [0, 0, 0], down: [Math.PI, 0, 0], north: [-Math.PI / 2, 0, 0], south: [Math.PI / 2, 0, 0],
    east: [0, 0, -Math.PI / 2], west: [0, 0, Math.PI / 2],
  }[dir];
  pivot.rotation.set(r[0], r[1], r[2]);
  return pivot;
}

// ------------------------------------------------------------------ block models

const SOLID_COLORS = {
  stone: 0x8a8a8a, smooth_stone: 0xa3a3a3, cobblestone: 0x7a7a7a, white_concrete: 0xdfe3e4, gray_concrete: 0x45494d,
  black_concrete: 0x16191d, red_concrete: 0x922424, orange_concrete: 0xe06101, yellow_concrete: 0xf1af15,
  lime_concrete: 0x5ea819, green_concrete: 0x495b24, cyan_concrete: 0x157788, light_blue_concrete: 0x2389c7,
  blue_concrete: 0x2d2f8f, purple_concrete: 0x64209c, magenta_concrete: 0xa9309f, pink_concrete: 0xd5658f,
  brown_concrete: 0x603c20, white_wool: 0xeaeded, target: 0xe6c9b4, obsidian: 0x1b1428, bedrock: 0x555555,
  dirt: 0x86603e, grass_block: 0x6a9a3c, sand: 0xdbcf96,
};
// engine colours of every block (sent with each snapshot): blocks without a model of their own
let BLOCK_COLORS = {};
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const BULB_COLORS = { copper: 0xc7714a, exposed: 0xa97f5c, weathered: 0x6c9e72, oxidized: 0x4fa58f };

const dustColor = (p) => lerpColor(0x4a0303, 0xff2412, p / 15);
const torchHead = (lit) => (lit ? mat(0xff3b1f, { emissive: 0xff2000, emissiveIntensity: 0.9 }) : mat(0x4a1410));
const STICK = 0x7a5a32;

function torchModel(g, lit, wallFacing) {
  if (!wallFacing) {
    box(g, 0.13, 0.55, 0.13, 0.5, 0.275, 0.5, mat(STICK));
    box(g, 0.19, 0.19, 0.19, 0.5, 0.6, 0.5, torchHead(lit));
    return;
  }
  const [fx, , fz] = DIRV[wallFacing];
  const stick = box(g, 0.13, 0.55, 0.13, 0.5 - fx * 0.3, 0.42, 0.5 - fz * 0.3, mat(STICK));
  stick.rotation.set(fz * 0.4, 0, -fx * 0.4);
  box(g, 0.19, 0.19, 0.19, 0.5 - fx * 0.18, 0.72, 0.5 - fz * 0.18, torchHead(lit));
}

function wireModel(g, p, power) {
  const m = mat(dustColor(power), power ? { emissive: 0x550000, emissiveIntensity: power / 15 } : {});
  const t = 0.035;
  box(g, 0.32, t, 0.32, 0.5, t / 2, 0.5, m);
  for (const d of ['north', 'south', 'east', 'west']) {
    const side = p[d];
    if (side === 'none') continue;
    const [dx, , dz] = DIRV[d];
    const len = 0.5;
    box(g, dx ? len : 0.22, t, dz ? len : 0.22, 0.5 + dx * 0.25, t / 2, 0.5 + dz * 0.25, m);
    if (side === 'up') box(g, dx ? t : 0.22, 1, dz ? t : 0.22, 0.5 + dx * (0.5 - t / 2), 0.5, 0.5 + dz * (0.5 - t / 2), m);
  }
}

// one shared arrow (pointing +x in its own frame), turned and placed per block
const arrowGeo = (() => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0.45, 0, 0, 0.1, 0, 0.2, 0.1, 0, -0.2], 3));
  geo.computeVertexNormals();
  return geo;
})();
const arrowMats = new Map();
function arrowMesh(g, outDir, y, color) {
  const [ox, , oz] = DIRV[outDir];
  if (!arrowMats.has(color)) arrowMats.set(color, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  const m = new THREE.Mesh(arrowGeo, arrowMats.get(color));
  m.position.set(0.5, y, 0.5);
  m.rotation.y = Math.atan2(-oz, ox);
  g.add(m);
}

function diodeModel(g, id, p, extra) {
  const out = OPP[p.facing];
  const [ox, , oz] = DIRV[out];
  const at = (u, v) => [0.5 + u * ox + v * -oz, 0.5 + u * oz + v * ox];
  box(g, 1, 0.125, 1, 0.5, 0.0625, 0.5, mat(0xb4b4b4, { edges: true }));
  const torch = (u, v, lit) => {
    const [x, z] = at(u, v);
    box(g, 0.12, 0.22, 0.12, x, 0.2, z, torchHead(lit));
  };
  if (id === 'repeater') {
    torch(0.25, 0, p.powered);
    torch(-0.0625 - (p.delay - 1) * 0.125, 0, p.powered);
    if (p.locked) {
      const [x, z] = at(-0.0625 - (p.delay - 1) * 0.125, 0);
      box(g, ox ? 0.12 : 0.75, 0.1, oz ? 0.12 : 0.75, x, 0.17, z, mat(0x2b2b2b));
    }
    arrowMesh(g, out, 0.128, p.powered ? 0xff6a50 : 0x6f6f6f);
  } else {
    torch(-0.3, 0.25, p.powered);
    torch(-0.3, -0.25, p.powered);
    torch(0.32, 0, p.mode === 'subtract');
    arrowMesh(g, out, 0.128, p.powered ? 0xff6a50 : 0x6f6f6f);
  }
}

function attachedModel(g, id, p) {
  const model = new THREE.Group();
  if (id === 'lever') {
    box(model, 0.38, 0.12, 0.55, 0.5, 0.06, 0.5, mat(0x8a8a8a, { edges: true }));
    const h = box(model, 0.08, 0.5, 0.08, 0.5, 0.3, 0.5, mat(STICK));
    h.rotation.x = p.powered ? -0.65 : 0.65;
    h.position.z = 0.5 + (p.powered ? -0.1 : 0.1);
    box(model, 0.12, 0.12, 0.12, 0.5, 0.52, 0.5 + (p.powered ? -0.25 : 0.25), p.powered ? torchHead(true) : mat(0x5a4a3a));
  } else {
    const color = id === 'oak_button' ? 0xa2834f : 0x8f8f8f;
    box(model, 0.375, p.powered ? 0.06 : 0.125, 0.25, 0.5, p.powered ? 0.03 : 0.0625, 0.5, mat(color, { edges: true }));
  }
  const dir = p.face === 'floor' ? 'up' : p.face === 'ceiling' ? 'down' : p.facing;
  g.add(orient(model, dir));
}

function pistonBaseModel(sticky, extended) {
  const m = new THREE.Group();
  box(m, 1, 0.75, 1, 0.5, 0.375, 0.5, mat(0x8d8574, { edges: true }));
  if (!extended) {
    box(m, 1, 0.25, 1, 0.5, 0.875, 0.5, mat(0xb59b6b, { edges: true }));
    if (sticky) box(m, 0.8, 0.02, 0.8, 0.5, 1.0, 0.5, mat(0x7fbf5a));
  } else {
    box(m, 0.3, 0.02, 0.3, 0.5, 0.76, 0.5, mat(0x3a3a3a));
  }
  return m;
}

function pistonHeadModel(sticky) {
  const m = new THREE.Group();
  box(m, 1, 0.25, 1, 0.5, 0.875, 0.5, mat(0xb59b6b, { edges: true }));
  if (sticky) box(m, 0.8, 0.02, 0.8, 0.5, 1.0, 0.5, mat(0x7fbf5a));
  box(m, 0.25, 1, 0.25, 0.5, 0.25, 0.5, mat(0xa58b5b));
  return m;
}

function observerModel(g, p) {
  const model = new THREE.Group();
  box(model, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x626262, { edges: true }));
  box(model, 0.7, 0.02, 0.3, 0.5, 1.0, 0.5, mat(0x2c2c2c)); // face (top of the +Y model = watched side)
  box(model, 0.18, 0.02, 0.18, 0.5, 0.0, 0.5, p.powered ? torchHead(true) : mat(0x3b1a16)); // output
  g.add(orient(model, p.facing));
}

function buildModel(id, p, extra) {
  const g = new THREE.Group();
  if (SOLID_COLORS[id] !== undefined) {
    box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(SOLID_COLORS[id], { edges: true }));
    if (extra?.power) box(g, 1.02, 1.02, 1.02, 0.5, 0.5, 0.5, mat(0xff2a10, { opacity: 0.08 + 0.12 * (extra.power / 15) }));
    return g;
  }
  if (id.endsWith('copper_bulb')) {
    const kind = id.replace('waxed_', '').replace('_copper_bulb', '').replace('copper_bulb', 'copper');
    box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(BULB_COLORS[kind] ?? 0xc7714a, { edges: true }));
    box(g, 0.6, 0.6, 0.6, 0.5, 0.5, 0.5, p.lit ? mat(0xfff0b0, { emissive: 0xffc040, emissiveIntensity: 1 }) : mat(0x3a2a20));
    if (p.powered) box(g, 0.16, 0.02, 0.16, 0.5, 1.0, 0.5, torchHead(true));
    return g;
  }
  if (id.endsWith('_door')) {
    // the panel hugs the side opposite its facing; an open door turns towards its hinge
    const m = mat(id === 'iron_door' ? 0xcfcfcf : 0x9c7a4a, { edges: true });
    const t = 3 / 16;
    const d = p.open ? (p.hinge === 'right' ? CCW[p.facing] : CW[p.facing]) : p.facing;
    const [dx, , dz] = DIRV[OPP[d]];
    box(g, dx ? t : 1, 1, dz ? t : 1, 0.5 + dx * (0.5 - t / 2), 0.5, 0.5 + dz * (0.5 - t / 2), m);
    return g;
  }
  if (id.endsWith('shulker_box')) {
    box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(BLOCK_COLORS[id] ?? 0x8b5f8b, { edges: true }));
    box(g, 1.01, 0.08, 1.01, 0.5, 0.5, 0.5, mat(0x2a2a2a));
    return g;
  }
  if (id.endsWith('_trapdoor')) {
    const m = mat(id === 'iron_trapdoor' ? 0xcfcfcf : 0x9c7a4a, { edges: true });
    const t = 3 / 16;
    if (!p.open) box(g, 1, t, 1, 0.5, p.half === 'top' ? 1 - t / 2 : t / 2, 0.5, m);
    else {
      // an open trapdoor hugs the side opposite its facing
      const side = { north: [0.5, 1 - t / 2], south: [0.5, t / 2], west: [1 - t / 2, 0.5], east: [t / 2, 0.5] }[p.facing];
      const alongX = p.facing === 'west' || p.facing === 'east';
      box(g, alongX ? t : 1, 1, alongX ? 1 : t, side[0], 0.5, side[1], m);
    }
    return g;
  }
  switch (id) {
    case 'water':
      box(g, 1, 0.88, 1, 0.5, 0.44, 0.5, mat(0x3a6fd8, { opacity: 0.6 }));
      break;
    case 'sugar_cane':
      for (const [dx, dz] of [[0.3, 0.3], [0.7, 0.35], [0.45, 0.7]]) box(g, 0.12, 1, 0.12, dx, 0.5, dz, mat(0x8ac46a));
      break;
    case 'farmland':
      box(g, 1, 0.94, 1, 0.5, 0.47, 0.5, mat(0x4a2e14));
      break;
    case 'melon':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x7fb238, { edges: true }));
      break;
    case 'pumpkin':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xe38a1d, { edges: true }));
      break;
    case 'melon_stem':
    case 'pumpkin_stem':
    case 'attached_melon_stem':
    case 'attached_pumpkin_stem':
      box(g, 0.12, 0.7, 0.12, 0.5, 0.35, 0.5, mat(id.includes('melon') ? 0x5f8a2a : 0x8a7a2a));
      box(g, 0.5, 0.06, 0.5, 0.5, 0.62, 0.5, mat(id.includes('melon') ? 0x4f7a22 : 0x7a6a22));
      break;
    case 'glass':
    case 'white_stained_glass':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xbfe3ef, { opacity: 0.28 }));
      break;
    case 'smooth_stone_slab':
    case 'stone_slab':
      if (p.type === 'double') box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xa8a8a8, { edges: true }));
      else box(g, 1, 0.5, 1, 0.5, p.type === 'top' ? 0.75 : 0.25, 0.5, mat(0xa8a8a8, { edges: true }));
      break;
    case 'slime_block':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x76c95f, { opacity: 0.7 }));
      box(g, 0.6, 0.6, 0.6, 0.5, 0.5, 0.5, mat(0x5aa846));
      break;
    case 'honey_block':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xf2a42a, { opacity: 0.75 }));
      break;
    case 'redstone_block':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xb3140a, { edges: true, emissive: 0x500000 }));
      break;
    case 'redstone_lamp':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, p.lit ? mat(0xffd27a, { edges: true, emissive: 0xffa630, emissiveIntensity: 0.85 }) : mat(0x6b4a2a, { edges: true }));
      break;
    case 'chest':
      box(g, 0.875, 0.875, 0.875, 0.5, 0.4375, 0.5, mat(0xa06a2c, { edges: true }));
      {
        const [fx, , fz] = DIRV[p.facing];
        box(g, fx ? 0.06 : 0.14, 0.22, fz ? 0.06 : 0.14, 0.5 + fx * 0.46, 0.55, 0.5 + fz * 0.46, mat(0xc8c8c8));
      }
      break;
    case 'hopper': {
      const m = mat(0x4a4a4e, { edges: true });
      box(g, 1, 0.375, 1, 0.5, 0.8125, 0.5, m);
      box(g, 0.5, 0.375, 0.5, 0.5, 0.4375, 0.5, m);
      if (p.facing === 'down') box(g, 0.25, 0.25, 0.25, 0.5, 0.125, 0.5, m);
      else {
        const [fx, , fz] = DIRV[p.facing];
        box(g, fx ? 0.25 : 0.25, 0.25, 0.25, 0.5 + fx * 0.375, 0.375, 0.5 + fz * 0.375, m);
      }
      if (!p.enabled) box(g, 0.3, 0.02, 0.3, 0.5, 1.0, 0.5, torchHead(true));
      break;
    }
    case 'dispenser':
    case 'dropper': {
      const model = new THREE.Group();
      box(model, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x6e6e6e, { edges: true }));
      box(model, 0.5, 0.02, id === 'dispenser' ? 0.5 : 0.3, 0.5, 1.0, 0.5, p.triggered ? torchHead(true) : mat(0x262626));
      g.add(orient(model, p.facing));
      break;
    }
    case 'note_block':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x6b4630, { edges: true }));
      box(g, 0.5, 0.02, 0.5, 0.5, 1.0, 0.5, p.powered ? torchHead(true) : mat(0x2e1d12));
      break;
    case 'barrel':
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0x7a5530, { edges: true }));
      box(g, 0.6, 0.02, 0.6, 0.5, 1.0, 0.5, mat(extra?.power ? lerpColor(0x3a2a1a, 0xff4020, extra.power / 15) : 0x3a2a1a));
      break;
    case 'redstone_wire':
      wireModel(g, p, p.power);
      break;
    case 'redstone_torch':
      torchModel(g, p.lit, null);
      break;
    case 'redstone_wall_torch':
      torchModel(g, p.lit, p.facing);
      break;
    case 'lever':
    case 'stone_button':
    case 'oak_button':
      attachedModel(g, id, p);
      break;
    case 'repeater':
    case 'comparator':
      diodeModel(g, id, p, extra);
      break;
    case 'observer':
      observerModel(g, p);
      break;
    case 'piston':
    case 'sticky_piston':
      g.add(orient(pistonBaseModel(id === 'sticky_piston', p.extended), p.facing));
      break;
    case 'piston_head':
      g.add(orient(pistonHeadModel(p.type === 'sticky'), p.facing));
      break;
    case 'moving_piston':
      if (extra?.moving) {
        const inner = buildModel(extra.moving.id, extra.moving.props, null);
        const [dx, dy, dz] = DIRV[extra.dir];
        const k = (extra.extending ? -1 : 1) * (1 - extra.progress);
        inner.position.set(dx * k, dy * k, dz * k);
        g.add(inner);
      }
      break;
    default:
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(BLOCK_COLORS[id] ?? 0xff00ff, { edges: true }));
      if (extra?.power) box(g, 1.02, 1.02, 1.02, 0.5, 0.5, 0.5, mat(0xff2a10, { opacity: 0.08 + 0.12 * (extra.power / 15) }));
  }
  return g;
}

// ------------------------------------------------------------------ world state

// Every box of every block is one instance in a pool: one InstancedMesh per (32^3 section,
// geometry, material). A changed block frees its slots (zero matrix) and takes new ones, so the
// work per tick follows the number of changes, not the size of the world.
const blocks = new Map(); // "x,y,z" -> { x, y, z, id, props, extra, parts, slots }
let cutY = Infinity;
const SECTION = 32;
const pools = new Map(); // "section|geo|mat" -> { mesh, free: number[], cap }
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function pool(x, y, z, geo, material) {
  const key = `${Math.floor(x / SECTION)},${Math.floor(y / SECTION)},${Math.floor(z / SECTION)}|${geo.id}|${material.id}`;
  let p = pools.get(key);
  if (!p) {
    p = { key, mesh: null, free: [], cap: 0 };
    pools.set(key, p);
    grow(p, geo, material, 64);
  }
  if (!p.free.length) grow(p, geo, material, p.cap * 2);
  return p;
}

function grow(p, geo, material, cap) {
  const mesh = new THREE.InstancedMesh(geo, material, cap);
  mesh.frustumCulled = false; // instances move around; sections are few
  if (p.mesh) {
    mesh.instanceMatrix.array.set(p.mesh.instanceMatrix.array);
    scene.remove(p.mesh);
    p.mesh.dispose();
  }
  for (let i = p.cap; i < cap; i++) {
    mesh.setMatrixAt(i, ZERO);
    p.free.push(i);
  }
  p.free.reverse(); // hand out low slots first
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  p.mesh = mesh;
  p.cap = cap;
}

function show(b) {
  b.slots = [];
  if (b.y > cutY) return;
  for (const [geo, material, matrix] of b.parts) {
    const p = pool(b.x, b.y, b.z, geo, material);
    const i = p.free.pop();
    p.mesh.setMatrixAt(i, matrix);
    p.mesh.instanceMatrix.needsUpdate = true;
    b.slots.push([p, i]);
  }
}

function hide(b) {
  for (const [p, i] of b.slots) {
    p.mesh.setMatrixAt(i, ZERO);
    p.mesh.instanceMatrix.needsUpdate = true;
    p.free.push(i);
  }
  b.slots = [];
}

function setBlock([x, y, z, id, props, extra]) {
  const key = `${x},${y},${z}`;
  const old = blocks.get(key);
  if (old) {
    hide(old);
    blocks.delete(key);
  }
  if (!id) return;
  const model = buildModel(id, props, extra);
  model.position.set(x, y, z);
  model.updateMatrixWorld(true);
  const parts = [];
  model.traverse((o) => {
    if (o.isMesh) parts.push([o.geometry, o.material, o.matrixWorld.clone()]);
  });
  const b = { x, y, z, id, props, extra, parts, slots: [] };
  blocks.set(key, b);
  show(b);
}

function clearWorld() {
  for (const p of pools.values()) {
    scene.remove(p.mesh);
    p.mesh.dispose();
  }
  pools.clear();
  blocks.clear();
}

let yRange = [0, 1];
function frame() {
  if (!blocks.size) return;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of blocks.values()) {
    [b.x, b.y, b.z].forEach((v, i) => {
      min[i] = Math.min(min[i], v);
      max[i] = Math.max(max[i], v + 1);
    });
  }
  yRange = [min[1], max[1]];
  const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const r = Math.max(max[0] - min[0], max[2] - min[2], 8);
  controls.target.copy(c);
  camera.position.set(c.x - r * 0.35, c.y + r * 0.75, c.z + r * 0.95);
  const cut = $('cut');
  cut.min = String(min[1] - 1);
  cut.max = String(max[1]);
  if (cutY === Infinity) cut.value = String(max[1]);
}

// ------------------------------------------------------------------ status / controls

let status = { time: 0, running: true, tps: 20 };
function showStatus(s) {
  status = { ...status, ...s };
  $('time').textContent = status.time;
  $('secs').textContent = t('bar.secs', { s: (status.time / 20).toFixed(1) });
  $('dot').className = `dot ${status.running ? 'live' : 'paused'}`;
  $('play').textContent = status.running ? t('bar.pause') : t('bar.run');
  document.querySelectorAll('[data-tps]').forEach((b) => b.classList.toggle('on', Number(b.dataset.tps) === status.tps));
  const canBack = status.historyStart !== undefined && status.time > status.historyStart;
  for (const id of ['back1', 'back10']) {
    $(id).disabled = !canBack;
    $(id).title = canBack ? t(id === 'back1' ? 'bar.back1Title' : 'bar.back10Title') : t('bar.backLimit', { t: status.historyStart ?? status.time });
  }
  if ('design' in s) {
    $('dname').textContent = status.design ?? t('world.unsaved');
    $('dname').classList.toggle('muted', !status.design);
    if (status.design && document.activeElement !== $('savename')) $('savename').value = status.design;
    markCurrent();
  }
  if ('frozen' in s) showFrozen(status.frozen ?? []);
  if ('trap' in s) showTrap(status.trap);
  if ('paper' in s) $('paper').checked = !!status.paper;
}

let ws;
let connState = ['conn.connecting'];
const showConn = (key, vars) => {
  connState = [key, vars];
  $('conn').textContent = t(key, vars);
};
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function connect() {
  ws = LOCAL ? LOCAL.socket() : new WebSocket(`ws://${location.host}`);
  ws.onopen = () => showConn(LOCAL ? 'conn.local' : 'conn.ok');
  ws.onclose = () => {
    showConn('conn.lost');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') {
      if (m.colors) BLOCK_COLORS = m.colors;
      if (m.palette) setPalette(m.palette);
      clearWorld();
      m.blocks.forEach(setBlock);
      frame(); // a new world: show all of it
      loadDesigns();
    } else if (m.type === 'update') {
      m.changes.forEach(setBlock);
    } else if (m.type === 'error') {
      toast(m.message, true);
    }
    if ('time' in m) showStatus(m);
    if (m.probes) setProbes(m.probes);
    if ('time' in m) trimTraces(m.time);
    if (m.samples) addSamples(m.samples);
    if (probeList.length && ('time' in m || m.samples)) drawGraph();
  };
}

// ------------------------------------------------------------------ signal graph

// Blocks added with G are sampled by the simulator after every tick ("samples" in updates); each
// gets a row with its value 0..15 over the last graphSpan game ticks.
const GRAPH_COLORS = ['#ff5a4f', '#5fd068', '#5aa9ff', '#e6b13a', '#c77dff', '#4dd4c6', '#ff8fc7', '#c0c4cc'];
const SPANS = [50, 100, 200, 400];
let graphSpan = 100;
let probeList = [];
const traces = new Map(); // "x,y,z" -> [[time, value]]

function setProbes(list) {
  probeList = list;
  const keys = new Set(list.map((p) => p.join(',')));
  for (const k of [...traces.keys()]) if (!keys.has(k)) traces.delete(k);
  for (const k of keys) if (!traces.has(k)) traces.set(k, []);
  document.body.classList.toggle('graph', list.length > 0);
}
/** Forgets samples after `time` (after a rewind). */
function trimTraces(time) {
  for (const tr of traces.values()) while (tr.length && tr[tr.length - 1][0] > time) tr.pop();
}
function addSamples(samples) {
  for (const [t, vals] of samples) {
    probeList.forEach((p, i) => {
      const tr = traces.get(p.join(','));
      if (!tr) return;
      while (tr.length && tr[tr.length - 1][0] >= t) tr.pop();
      tr.push([t, vals[i]]);
      if (tr.length > 4000) tr.splice(0, tr.length - 4000);
    });
  }
}
function drawGraph() {
  const cv = $('gcanvas');
  if (!probeList.length || !cv.clientWidth) return;
  const rowH = 24, top = 2, axisH = 15, labelW = 190;
  const w = cv.clientWidth;
  const h = top + probeList.length * rowH + axisH;
  const dpr = devicePixelRatio || 1;
  cv.style.height = `${h}px`;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const now = status.time ?? 0;
  const t0 = now + 1 - graphSpan; // the window covers ticks t0 .. now, each one wide
  const plotW = w - labelW - 6;
  const X = (t) => labelW + ((t - t0) / graphSpan) * plotW;
  g.font = '11px ui-monospace, Consolas, monospace';
  g.textBaseline = 'middle';
  const every = graphSpan <= 100 ? 10 : graphSpan <= 200 ? 20 : 50;
  g.textAlign = 'center';
  for (let t = Math.ceil(t0 / every) * every; t <= now; t += every) {
    const x = Math.round(X(t)) + 0.5;
    g.strokeStyle = '#2c313c';
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, h - axisH);
    g.stroke();
    g.fillStyle = '#9aa1ad';
    g.fillText(String(t), Math.min(Math.max(x, labelW + 12), w - 14), h - axisH / 2);
  }
  probeList.forEach((p, i) => {
    const key = p.join(',');
    const y0 = top + i * rowH;
    const base = y0 + rowH - 4;
    const amp = rowH - 8;
    const color = GRAPH_COLORS[i % GRAPH_COLORS.length];
    const tr = traces.get(key) ?? [];
    const last = tr.length ? tr[tr.length - 1][1] : null;
    g.textAlign = 'left';
    g.fillStyle = color;
    const label = `${blocks.get(key)?.id ?? 'air'} ${p.join(' ')}`;
    let text = label;
    while (text.length > 4 && g.measureText(`${text} ${last ?? ''}`).width > labelW - 10) text = text.slice(0, -2);
    g.fillText(text === label ? `${text}  ${last ?? ''}` : `${text}…  ${last ?? ''}`, 2, y0 + rowH / 2);
    g.strokeStyle = '#232731';
    g.beginPath();
    g.moveTo(labelW, base + 0.5);
    g.lineTo(w, base + 0.5);
    g.stroke();
    g.beginPath();
    let first = true;
    for (const [t, v] of tr) {
      if (t + 1 <= t0) continue;
      const y = base - (v / 15) * amp;
      const xa = X(Math.max(t, t0));
      if (first) g.moveTo(xa, y);
      else g.lineTo(xa, y);
      g.lineTo(X(t + 1), y);
      first = false;
    }
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.stroke();
    g.lineWidth = 1;
  });
}
$('gspan').onclick = () => {
  graphSpan = SPANS[(SPANS.indexOf(graphSpan) + 1) % SPANS.length];
  $('gspan').textContent = `${graphSpan} gt`;
  drawGraph();
};
$('gclear').onclick = () => send({ type: 'probes_clear' });
addEventListener('resize', drawGraph);

connect();

$('play').onclick = () => send({ type: status.running ? 'pause' : 'resume' });
$('step1').onclick = () => send({ type: 'step', n: 1 });
$('step10').onclick = () => send({ type: 'step', n: 10 });
$('back1').onclick = () => send({ type: 'rewind', n: 1 });
$('back10').onclick = () => send({ type: 'rewind', n: 10 });
document.querySelectorAll('[data-tps]').forEach((b) => (b.onclick = () => send({ type: 'tps', tps: Number(b.dataset.tps) })));
$('cut').oninput = (e) => {
  const v = Number(e.target.value);
  cutY = v >= Number(e.target.max) ? Infinity : v;
  $('cutv').textContent = cutY === Infinity ? '∞' : cutY;
  for (const b of blocks.values()) {
    hide(b);
    show(b);
  }
};
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') {
    e.preventDefault();
    send({ type: status.running ? 'pause' : 'resume' });
  } else if (e.key === '.') send({ type: 'step', n: 1 });
  else if (e.key === ',') send({ type: 'rewind', n: 1 });
  else if (k === 'f') frame();
  else if (k === 'c') setChunkMode(!chunkMode);
  else if (k === 't') setTrapMode(!trapMode);
  else if (k === 'b') setBuildMode(!buildMode);
  else if (k === 'g' && hovered) send({ type: 'probe', x: hovered.x, y: hovered.y, z: hovered.z });
  else if (/^[1-9]$/.test(e.key) && recent[Number(e.key) - 1]) selectBlock(recent[Number(e.key) - 1]);
  else if (k === 'p') document.body.classList.toggle('collapsed');
  else if (e.key === 'Escape') {
    setChunkMode(false);
    setTrapMode(false);
    setBuildMode(false);
    document.body.classList.remove('mats');
  }
});

// ------------------------------------------------------------------ hover & click

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hovered = null;
const INTERACTIVE_IDS = new Set(['lever', 'stone_button', 'oak_button', 'repeater', 'comparator', 'redstone_wire', 'note_block']);
const INTERACTIVE = { has: (id) => INTERACTIVE_IDS.has(id) || /_(door|trapdoor)$/.test(id) && !id.startsWith('iron_') };

let pickHit = null; // { face: outward normal of the face the ray entered through, point } of the last pick

/** The first visible block cell the mouse ray enters (a grid walk, cheap for any world size). */
function pick(ev) {
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const { origin: o, direction: d } = raycaster.ray;
  const cell = [Math.floor(o.x), Math.floor(o.y), Math.floor(o.z)];
  const step = [Math.sign(d.x), Math.sign(d.y), Math.sign(d.z)];
  const p = [o.x, o.y, o.z];
  const v = [d.x, d.y, d.z];
  const tMax = [0, 1, 2].map((i) => (v[i] ? ((step[i] > 0 ? cell[i] + 1 : cell[i]) - p[i]) / v[i] : Infinity));
  const tDelta = [0, 1, 2].map((i) => (v[i] ? Math.abs(1 / v[i]) : Infinity));
  let face = null;
  let tHit = 0;
  for (let n = 0; n < 1500; n++) {
    const b = blocks.get(`${cell[0]},${cell[1]},${cell[2]}`);
    if (b && b.y <= cutY && b.id !== 'water') {
      pickHit = { face, point: [o.x + d.x * tHit, o.y + d.y * tHit, o.z + d.z * tHit] };
      return b;
    }
    const i = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    tHit = tMax[i];
    cell[i] += step[i];
    face = [0, 0, 0];
    face[i] = -step[i];
    tMax[i] += tDelta[i];
  }
  pickHit = null;
  return null;
}

const tip = $('tip');
let lastMove = null;
renderer.domElement.addEventListener('pointermove', (ev) => (lastMove = ev));
function hover(ev) {
  hovered = pick(ev);
  const target = buildMode && hovered ? placeTarget(hovered) : null;
  ghost.visible = !!target;
  if (target) ghost.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  if (!hovered) {
    tip.style.display = 'none';
    renderer.domElement.style.cursor = '';
    return;
  }
  const props = Object.entries(hovered.props).map(([k, v]) => `${k}=${v}`).join(', ');
  const power = hovered.extra?.power;
  tip.innerHTML =
    `<b>${hovered.id}</b> (${hovered.x}, ${hovered.y}, ${hovered.z})` +
    (props ? `<br><span class="muted">${props}</span>` : '') +
    (power !== undefined ? `<br>${t('tip.power')}: <b>${power}</b>` : '') +
    (hovered.extra?.items
      ? `<br>${t('tip.items')}: ${hovered.extra.items.length ? hovered.extra.items.map(([slot, item, n]) => `${n}× ${item}`).join(', ') : `<span class="muted">${t('tip.empty')}</span>`}`
      : '') +
    (chunkMode
      ? `<br>chunk <b>${hovered.x >> 4}, ${hovered.z >> 4}</b> <span class="muted">${t('tip.chunkClick')}</span>`
      : buildMode
        ? `<br><span class="muted">${t('tip.build', { block: buildBlock })}</span>`
        : INTERACTIVE.has(hovered.id) ? `<br><span class="muted">${t('tip.use')}</span>` : '');
  tip.style.display = 'block';
  tip.style.left = `${Math.min(ev.clientX + 16, innerWidth - 360)}px`;
  tip.style.top = `${ev.clientY + 16}px`;
  renderer.domElement.style.cursor = buildMode ? 'crosshair' : chunkMode || trapMode || INTERACTIVE.has(hovered.id) ? 'pointer' : '';
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY, ev.button]));
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || downAt[2] !== ev.button) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;
  const b = pick(ev);
  if (buildMode && !trapMode && !chunkMode) return b && buildClick(ev, b);
  if (ev.button !== 0) return;
  if (b && trapMode) {
    send({
      type: 'trap',
      border: Math.round((b.x + 0.5) / 16) * 16,
      mode: $('trapmode').value,
      hold: Math.max(1, Math.round(Number($('traphold').value) * 20)),
      reload: $('trapreload').checked,
    });
    setTrapMode(false);
  } else if (b && chunkMode) send({ type: 'chunk', cx: b.x >> 4, cz: b.z >> 4 });
  else if (b && INTERACTIVE.has(b.id)) send({ type: 'use', x: b.x, y: b.y, z: b.z });
});

// ------------------------------------------------------------------ build mode

// Right click places the selected block on the face under the mouse, left click breaks, middle
// click picks. Orientation follows the camera the way the game follows the player's view.
let buildMode = false;
let buildBlock = 'redstone_wire';
let PALETTE = [];
let recent = [];
const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(1.02, 1.02, 1.02),
  new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.28, depthWrite: false }),
);
ghost.visible = false;
scene.add(ghost);

const DIRS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };
const dirOf = (v) => Object.keys(DIRS).find((k) => DIRS[k].every((c, i) => c === v[i]));

/** The player's nearest looking direction (3D) and horizontal facing, from the camera. */
function lookDirs() {
  const d = camera.getWorldDirection(new THREE.Vector3());
  const v = [d.x, d.y, d.z];
  const i = v.map(Math.abs).indexOf(Math.max(...v.map(Math.abs)));
  const n = [0, 0, 0];
  n[i] = Math.sign(v[i]);
  return { look: dirOf(n), horiz: Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 'east' : 'west') : d.z > 0 ? 'south' : 'north' };
}

/** The block string a player would place: face = clicked face, fy = hit height on that face (0..1). */
function placement(id, face, fy) {
  const { look, horiz } = lookDirs();
  const side = face !== 'up' && face !== 'down';
  if (id === 'redstone_torch') return side ? `redstone_wall_torch[facing=${face}]` : id;
  if (/^(lever|\w+_button)$/.test(id))
    return side ? `${id}[face=wall,facing=${face}]` : `${id}[face=${face === 'up' ? 'floor' : 'ceiling'},facing=${horiz}]`;
  if (id === 'repeater' || id === 'comparator') return `${id}[out=${horiz}]`;
  if (id === 'observer') return `${id}[facing=${look}]`;
  if (/^((sticky_)?piston|dispenser|dropper)$/.test(id)) return `${id}[facing=${OPP[look]}]`;
  if (id === 'hopper') return `${id}[facing=${side ? OPP[face] : 'down'}]`;
  if (id === 'chest') return `${id}[facing=${OPP[horiz]}]`;
  if (/_door$/.test(id)) return `${id}[facing=${horiz}]`;
  if (/_trapdoor$/.test(id))
    return side
      ? `${id}[facing=${face},half=${fy > 0.5 ? 'top' : 'bottom'}]`
      : `${id}[facing=${OPP[horiz]},half=${face === 'down' ? 'top' : 'bottom'}]`;
  if (/_slab$/.test(id)) return `${id}[type=${face === 'down' || (side && fy > 0.5) ? 'top' : 'bottom'}]`;
  if (/_(log|wood)$/.test(id)) return `${id}[axis=${side ? (face === 'east' || face === 'west' ? 'x' : 'z') : 'y'}]`;
  if (/shulker_box$/.test(id)) return `${id}[facing=${face}]`;
  return id;
}

/** The cell a right click on block b would place into (from the last pick). */
function placeTarget(b) {
  if (!pickHit?.face) return null;
  const n = pickHit.face;
  return { x: b.x + n[0], y: b.y + n[1], z: b.z + n[2] };
}

function buildClick(ev, b) {
  if (ev.button === 0) return send({ type: 'break', x: b.x, y: b.y, z: b.z });
  if (ev.button === 1) return selectBlock(b.id.replace('redstone_wall_torch', 'redstone_torch').replace(/^attached_/, ''));
  if (INTERACTIVE.has(b.id) && !ev.shiftKey) return send({ type: 'use', x: b.x, y: b.y, z: b.z });
  const target = placeTarget(b);
  if (!target) return;
  send({ type: 'place', ...target, block: placement(buildBlock, dirOf(pickHit.face), pickHit.point[1] - b.y) });
  recent = [buildBlock, ...recent.filter((id) => id !== buildBlock)].slice(0, 9);
  renderRecent();
}

function setBuildMode(on) {
  if (on) {
    setChunkMode(false);
    setTrapMode(false);
  }
  buildMode = on;
  if (!on) ghost.visible = false;
  document.body.classList.toggle('buildmode', on);
  $('buildmode').classList.toggle('on', on);
}

function selectBlock(id) {
  if (!PALETTE.includes(id)) return;
  buildBlock = id;
  setBuildMode(true);
  renderPalette();
  renderRecent();
}

const COMMON = [
  'redstone_wire', 'redstone_torch', 'repeater', 'comparator', 'lever', 'stone_button', 'oak_button', 'observer',
  'piston', 'sticky_piston', 'slime_block', 'honey_block', 'redstone_block', 'redstone_lamp', 'target', 'note_block',
  'copper_bulb', 'hopper', 'chest', 'barrel', 'dropper', 'dispenser', 'oak_door', 'iron_door', 'oak_trapdoor',
  'iron_trapdoor', 'stone', 'smooth_stone', 'glass', 'obsidian', 'smooth_stone_slab', 'white_concrete', 'white_wool',
];
const swatch = (id) => {
  const c = BLOCK_COLORS[id];
  return c === undefined ? '#8a8f99' : `#${c.toString(16).padStart(6, '0')}`;
};
const blockButton = (id) =>
  `<button data-block="${id}" class="${id === buildBlock ? 'on' : ''}" title="${id}"><span class="sw" style="background:${swatch(id)}"></span><span class="nm">${id.replace(/_/g, ' ')}</span></button>`;

function setPalette(ids) {
  const rank = (id) => (COMMON.includes(id) ? COMMON.indexOf(id) : COMMON.length);
  PALETTE = [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  renderPalette();
}
function renderPalette() {
  const q = $('bsearch').value.trim().toLowerCase().replace(/\s+/g, '_');
  $('palette').innerHTML = PALETTE.filter((id) => id.includes(q)).map(blockButton).join('');
}
function renderRecent() {
  $('recent').innerHTML = recent.map((id, i) => blockButton(id).replace('<span class="nm">', `<span class="nm"><kbd>${i + 1}</kbd> `)).join('');
}
for (const el of ['palette', 'recent'])
  $(el).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-block]');
    if (b) selectBlock(b.dataset.block);
  });
$('bsearch').oninput = renderPalette;
$('buildmode').onclick = () => setBuildMode(!buildMode);

// ------------------------------------------------------------------ side panel: files, tests

const toast = (msg, err = false) => {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
};
const busy = (on) => document.body.classList.toggle('busy', on);

async function api(path, body) {
  if (LOCAL) return LOCAL.api(path, body);
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
}

let designs = [];
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtDate = (ms) => new Date(ms).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Downloads an /api/... file: a plain navigation, or a Blob made in this tab without a server. */
function download(href) {
  if (!LOCAL) return void (location.href = href);
  LOCAL.file(href).then(
    ({ name, type, data }) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
    (e) => toast(e.message, true),
  );
}
if (LOCAL) {
  document.querySelectorAll('a[href^="/api/"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      download(a.getAttribute('href'));
    }),
  );
}

async function loadDesigns() {
  try {
    designs = await api('/api/designs');
    renderDesigns();
  } catch (e) {
    $('designs').innerHTML = `<div class="empty">${esc(t('designs.listError', { msg: e.message }))}</div>`;
  }
}

function renderDesigns() {
  const q = $('search').value.trim().toLowerCase();
  const shown = designs.filter((d) => d.name.toLowerCase().includes(q));
  $('dcount').textContent = designs.length ? String(designs.length) : '';
  $('designs').innerHTML = shown.length
    ? shown
        .map(
          (d) => `<div class="item" tabindex="0" data-name="${esc(d.name)}" title="${esc(t('designs.clickToLoad'))}">
        <div class="info"><div class="name">${esc(d.name)}</div>
        <div class="meta">${esc(t('designs.meta', { blocks: d.blocks.toLocaleString(locale()), size: fmtBytes(d.bytes), date: d.modified ? fmtDate(d.modified) : t('designs.shipped') }))}</div></div>
        <div class="acts"><button data-act="dl" title="${esc(t('designs.download'))}">⬇</button><button data-act="del" title="${esc(t('designs.delete'))}">🗑</button></div></div>`,
        )
        .join('')
    : `<div class="empty">${t(designs.length ? 'designs.noMatch' : 'designs.none')}</div>`;
  markCurrent();
}

function markCurrent() {
  document.querySelectorAll('#designs .item').forEach((el) => el.classList.toggle('current', el.dataset.name === status.design));
}

async function loadDesign(name) {
  busy(true);
  try {
    await api('/api/designs/load', { name });
    toast(t('designs.loaded', { name }));
  } catch (e) {
    toast(t('designs.loadFailed', { msg: e.message }), true);
  } finally {
    busy(false);
  }
}

$('designs').addEventListener('click', async (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const name = item.dataset.name;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'dl') download(`/api/designs/file?name=${encodeURIComponent(name)}`);
  else if (act === 'del') {
    if (!confirm(t('designs.confirmDelete', { name }))) return;
    try {
      await api('/api/designs/delete', { name });
      toast(t('designs.deleted', { name }));
      loadDesigns();
    } catch (err) {
      toast(t('designs.deleteFailed', { msg: err.message }), true);
    }
  } else loadDesign(name);
});
$('designs').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('item')) loadDesign(e.target.dataset.name);
});
$('search').oninput = renderDesigns;
$('refresh').onclick = loadDesigns;

async function importFile(file) {
  if (!/\.(json|mcfunction|txt|litematic)$/i.test(file.name)) return toast(t('import.onlyTypes'), true);
  busy(true);
  try {
    const lit = /\.litematic$/i.test(file.name);
    const body = { filename: file.name, save: $('keep').checked };
    if (lit) body.data = toBase64(new Uint8Array(await file.arrayBuffer()));
    else body.text = await file.text();
    const r = await api('/api/import', body);
    const skipped = !r.skipped
      ? ''
      : lit
        ? t('import.unsupported', { n: r.skipped, ids: r.unsupported.slice(0, 5).join(', ') + (r.unsupported.length > 5 ? ', …' : '') })
        : t('import.skipped', { n: r.skipped });
    const counts = r.placed !== undefined ? t('import.counts', { placed: r.placed.toLocaleString(locale()), skipped }) : '';
    toast(t('import.opened', { file: file.name, counts, saved: r.name ? t('import.savedAs', { name: r.name }) : '' }));
    loadDesigns();
  } catch (e) {
    toast(t('import.failed', { msg: e.message }), true);
  } finally {
    busy(false);
  }
}
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// ------------------------------------------------------------------ share links

// The world (redstone-sim JSON, deflated, base64url) rides in the address after "#d=", so a link
// to the browser demo carries the whole build. Opening such a link imports it.
const DEMO_URL = 'https://ziacud.github.io/redstone-sim/public/';
const pipeBytes = async (bytes, stream) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function worldJson() {
  if (LOCAL) return (await LOCAL.file('/api/world.json')).data;
  const r = await fetch('/api/world.json');
  if (!r.ok) throw new Error(r.statusText);
  return r.text();
}

async function shareLink() {
  const packed = await pipeBytes(new TextEncoder().encode(await worldJson()), new CompressionStream('deflate-raw'));
  const code = toBase64(packed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = LOCAL ? location.origin + location.pathname : DEMO_URL;
  return `${base}#d=${code}`;
}

$('share').onclick = async () => {
  try {
    const link = await shareLink();
    const kb = Math.max(1, Math.round(link.length / 1024));
    try {
      await navigator.clipboard.writeText(link);
      toast(t(kb > 60 ? 'share.long' : 'share.copied', { kb }), kb > 60);
    } catch {
      prompt(t('share.copyManually'), link);
    }
  } catch (e) {
    toast(e.message, true);
  }
};

async function openSharedLink() {
  const m = location.hash.match(/^#d=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const packed = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(await pipeBytes(packed, new DecompressionStream('deflate-raw')));
    await api('/api/import', { filename: 'shared.json', text });
    toast(t('share.loaded'));
  } catch (e) {
    toast(t('share.bad', { msg: e.message }), true);
  }
}
openSharedLink();
addEventListener('hashchange', openSharedLink);

$('open').onclick = () => $('file').click();
$('file').onchange = (e) => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
};
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) importFile(f);
});

$('save').onclick = async () => {
  const name = $('savename').value.trim();
  if (!name) return toast(t('world.needName'), true);
  if (name !== status.design && designs.some((d) => d.name === name) && !confirm(t('world.confirmOverwrite', { name }))) return;
  try {
    await api('/api/designs/save', { name });
    toast(t('world.saved', { name }));
    loadDesigns();
  } catch (e) {
    toast(t('world.saveFailed', { msg: e.message }), true);
  }
};
$('savename').addEventListener('keydown', (e) => e.key === 'Enter' && $('save').click());
$('newworld').onclick = async () => {
  if (!confirm(t('world.confirmNew'))) return;
  await api('/api/new', {});
  toast(t('world.newDone'));
};
$('collapse').onclick = () => document.body.classList.toggle('collapsed');

// material list
let mats = null;
function renderMats() {
  if (!mats) return;
  const total = mats.reduce((n, m) => n + m.count, 0);
  $('matsum').textContent = mats.length ? t('mats.summary', { total: total.toLocaleString(locale()), kinds: mats.length }) : '';
  const stacks = (m) => `${m.stacks} × ${m.stackSize}${m.rest ? ` + ${m.rest}` : ''}`;
  $('mattable').innerHTML = mats.length
    ? `<thead><tr><th>${esc(t('mats.item'))}</th><th class="n">${esc(t('mats.count'))}</th><th class="n">${esc(t('mats.stacks'))}</th><th class="n">${esc(t('mats.shulkers'))}</th></tr></thead><tbody>` +
      mats.map((m) => `<tr><td>${esc(m.item)}</td><td class="n">${m.count.toLocaleString(locale())}</td><td class="n">${stacks(m)}</td><td class="n">${m.shulkers.toLocaleString(locale())}</td></tr>`).join('') +
      '</tbody>'
    : `<tbody><tr><td class="empty">${esc(t('mats.empty'))}</td></tr></tbody>`;
}
$('mats').onclick = async () => {
  try {
    mats = await api('/api/materials');
    renderMats();
    document.body.classList.add('mats');
  } catch (e) {
    toast(t('mats.failed', { msg: e.message }), true);
  }
};
$('matclose').onclick = () => document.body.classList.remove('mats');
$('matcopy').onclick = async () => {
  if (!mats) return;
  const text = mats.map((m) => `${m.item}\t${m.count}\t${m.stacks} x ${m.stackSize}${m.rest ? ` + ${m.rest}` : ''}\t${m.shulkers}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(t('mats.copied'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('focus').onclick = frame;

// server tests
$('restart').onclick = () => {
  send({ type: 'restart' });
  toast(t('server.restartDone'));
};
let chunkMode = false;
function setChunkMode(on) {
  if (on) {
    setTrapMode(false);
    if (buildMode) setBuildMode(false);
  }
  chunkMode = on;
  document.body.classList.toggle('chunkmode', on);
  $('chunkmode').classList.toggle('on', on);
}
$('chunkmode').onclick = () => setChunkMode(!chunkMode);
$('thaw').onclick = () => send({ type: 'thaw' });

// frozen chunks: a translucent blue column over each
const frozenGroup = new THREE.Group();
scene.add(frozenGroup);
const frozenMat = new THREE.MeshBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.13, depthWrite: false });
const frozenEdge = new THREE.LineBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.7 });
let frozenKey = '';
function showFrozen(list) {
  const key = `${[...list].sort().join('|')}@${yRange}`;
  if (key === frozenKey) return;
  frozenKey = key;
  for (const o of frozenGroup.children) o.geometry.dispose();
  frozenGroup.clear();
  const h = Math.max(1, yRange[1] - yRange[0]) + 1;
  for (const k of list) {
    const [cx, cz] = k.split(',').map(Number);
    const geo = new THREE.BoxGeometry(16, h, 16);
    const m = new THREE.Mesh(geo, frozenMat);
    m.position.set(cx * 16 + 8, yRange[0] - 0.5 + h / 2, cz * 16 + 8);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), frozenEdge);
    e.position.copy(m.position);
    frozenGroup.add(m, e);
  }
  $('frozenlist').innerHTML = list.length
    ? esc(t('chunk.list', { n: list.length })) + list.map((k) => `<span class="frozen-tag">${esc(k)}</span>`).join('')
    : esc(t('chunk.none'));
}

// chunk-border trap: a red wall on the border; the side panel says how often it fired
let trapMode = false;
function setTrapMode(on) {
  trapMode = on;
  if (on) setChunkMode(false);
  document.body.classList.toggle('trapmode', on);
  $('trapset').classList.toggle('on', on);
}
$('trapset').onclick = () => setTrapMode(!trapMode);
$('trapclear').onclick = () => send({ type: 'untrap' });
$('paper').onchange = (e) => send({ type: 'paper', on: e.target.checked });
const trapGroup = new THREE.Group();
scene.add(trapGroup);
const trapMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
let trapKey = '';
function showTrap(trap) {
  const key = trap ? `${trap.border}@${yRange}` : '';
  if (key !== trapKey) {
    trapKey = key;
    for (const o of trapGroup.children) o.geometry.dispose();
    trapGroup.clear();
    if (trap) {
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const b of blocks.values()) {
        z0 = Math.min(z0, b.z);
        z1 = Math.max(z1, b.z + 1);
      }
      const h = Math.max(1, yRange[1] - yRange[0]) + 1;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(1, z1 - z0), h), trapMat);
      wall.rotation.y = Math.PI / 2;
      wall.position.set(trap.border, yRange[0] - 0.5 + h / 2, (z0 + z1) / 2);
      trapGroup.add(wall);
    }
  }
  $('trapinfo').innerHTML = trap
    ? t('trap.info', {
        border: trap.border,
        what: t(trap.mode === 'cancel' ? 'trap.whatCancel' : 'trap.whatFreeze'),
        hold: (trap.hold / 20).toFixed(0),
        reload: trap.reload ? t('trap.reloadAfter') : '',
        fired: trap.fired,
      }) + (trap.left > 0 ? t('trap.active', { left: (trap.left / 20).toFixed(1) }) : '')
    : esc(t('trap.none'));
}

// ------------------------------------------------------------------ language

$('lang').onclick = () => setLang(lang === 'tr' ? 'en' : 'tr');
onLangChange(() => {
  showStatus({ design: status.design });
  frozenKey = '';
  showFrozen(status.frozen ?? []);
  showTrap(status.trap);
  showConn(...connState);
  renderDesigns();
  renderMats();
});
applyStatic();
showStatus({ design: status.design });
showFrozen(status.frozen ?? []);
showTrap(status.trap);
showConn(...connState);

// ------------------------------------------------------------------ render loop

renderer.setAnimationLoop(() => {
  if (lastMove) {
    hover(lastMove);
    lastMove = null;
  }
  controls.update();
  renderer.render(scene, camera);
});

// for debugging from the browser console
window.__viewer = { renderer, scene, camera, controls, blocks, pools };
