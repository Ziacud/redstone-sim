// Live 3D view of the simulator. Receives snapshots/updates over WebSocket. Each block's model is
// built as a THREE.Group occupying [x, x+1]^3, then flattened into its parts (geometry, material,
// matrix), which are drawn as instances (see "world state").

import * as THREE from 'three';
import { OrbitControls } from '/OrbitControls.js';
import { t, locale, lang, setLang, applyStatic, onLangChange } from '/i18n.js';

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
      box(g, 1, 1, 1, 0.5, 0.5, 0.5, mat(0xff00ff, { edges: true }));
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
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => showConn('conn.ok');
  ws.onclose = () => {
    showConn('conn.lost');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') {
      clearWorld();
      m.blocks.forEach(setBlock);
      frame(); // a new world: show all of it
      loadDesigns();
    } else if (m.type === 'update') {
      m.changes.forEach(setBlock);
    } else if (m.type === 'error') {
      showConn('conn.error', { msg: m.message });
    }
    if ('time' in m) showStatus(m);
  };
}
connect();

$('play').onclick = () => send({ type: status.running ? 'pause' : 'resume' });
$('step1').onclick = () => send({ type: 'step', n: 1 });
$('step10').onclick = () => send({ type: 'step', n: 10 });
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
  else if (k === 'f') frame();
  else if (k === 'c') setChunkMode(!chunkMode);
  else if (k === 't') setTrapMode(!trapMode);
  else if (k === 'p') document.body.classList.toggle('collapsed');
  else if (e.key === 'Escape') {
    setChunkMode(false);
    setTrapMode(false);
  }
});

// ------------------------------------------------------------------ hover & click

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hovered = null;
const INTERACTIVE = new Set(['lever', 'stone_button', 'oak_button', 'repeater', 'comparator', 'redstone_wire']);

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
  for (let n = 0; n < 1500; n++) {
    const b = blocks.get(`${cell[0]},${cell[1]},${cell[2]}`);
    if (b && b.y <= cutY && b.id !== 'water') return b;
    const i = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    cell[i] += step[i];
    tMax[i] += tDelta[i];
  }
  return null;
}

const tip = $('tip');
let lastMove = null;
renderer.domElement.addEventListener('pointermove', (ev) => (lastMove = ev));
function hover(ev) {
  hovered = pick(ev);
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
    (chunkMode
      ? `<br>chunk <b>${hovered.x >> 4}, ${hovered.z >> 4}</b> <span class="muted">${t('tip.chunkClick')}</span>`
      : INTERACTIVE.has(hovered.id) ? `<br><span class="muted">${t('tip.use')}</span>` : '');
  tip.style.display = 'block';
  tip.style.left = `${Math.min(ev.clientX + 16, innerWidth - 360)}px`;
  tip.style.top = `${ev.clientY + 16}px`;
  renderer.domElement.style.cursor = chunkMode || trapMode || INTERACTIVE.has(hovered.id) ? 'pointer' : '';
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY, ev.button]));
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || downAt[2] !== 0) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;
  const b = pick(ev);
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
        <div class="meta">${esc(t('designs.meta', { blocks: d.blocks.toLocaleString(locale()), size: fmtBytes(d.bytes), date: fmtDate(d.modified) }))}</div></div>
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
  if (act === 'dl') location.href = `/api/designs/file?name=${encodeURIComponent(name)}`;
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
  if (!/\.(json|mcfunction|txt)$/i.test(file.name)) return toast(t('import.onlyTypes'), true);
  busy(true);
  try {
    const text = await file.text();
    const r = await api('/api/import', { filename: file.name, text, save: $('keep').checked });
    const counts =
      r.placed !== undefined
        ? t('import.counts', { placed: r.placed.toLocaleString(locale()), skipped: r.skipped ? t('import.skipped', { n: r.skipped }) : '' })
        : '';
    toast(t('import.opened', { file: file.name, counts, saved: r.name ? t('import.savedAs', { name: r.name }) : '' }));
    loadDesigns();
  } catch (e) {
    toast(t('import.failed', { msg: e.message }), true);
  } finally {
    busy(false);
  }
}
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
$('focus').onclick = frame;

// server tests
$('restart').onclick = () => {
  send({ type: 'restart' });
  toast(t('server.restartDone'));
};
let chunkMode = false;
function setChunkMode(on) {
  if (on) setTrapMode(false);
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
