// Block registry and interned (canonical) block states.
// Like vanilla, every distinct property combination maps to exactly one state object,
// so identity comparison (a === b) means "same block state".

const REGISTRY = new Map();
const INTERN = new Map();

export function registerBlock(block) {
  if (REGISTRY.has(block.id)) throw new Error(`Block ${block.id} registered twice`);
  block.properties ??= {};
  block.defaults ??= {};
  REGISTRY.set(block.id, block);
  block.defaultState = makeState(block, {});
  return block;
}

export function getBlock(id) {
  const b = REGISTRY.get(id);
  if (!b) throw new Error(`Unknown block "${id}"`);
  return b;
}

export function hasBlock(id) {
  return REGISTRY.has(id);
}

export function allBlocks() {
  return [...REGISTRY.values()];
}

// Sorted property names per block (for stateKey), recomputed if block.properties is replaced.
const NAMES = new Map();
function sortedNames(block) {
  const c = NAMES.get(block);
  if (c !== undefined && c.props === block.properties) return c.names;
  const names = Object.keys(block.properties).sort();
  NAMES.set(block, { props: block.properties, names });
  return names;
}

function stateKey(block, props) {
  const names = sortedNames(block);
  if (!names.length) return block.id;
  return `${block.id}[${names.map((n) => `${n}=${props[n]}`).join(',')}]`;
}

export function makeState(block, props) {
  const full = {};
  for (const [name, values] of Object.entries(block.properties)) {
    let v = name in props ? props[name] : block.defaults[name] ?? values[0];
    v = coerce(values, v, block.id, name);
    full[name] = v;
  }
  for (const k of Object.keys(props)) {
    if (!(k in block.properties)) throw new Error(`Block ${block.id} has no property "${k}"`);
  }
  const key = stateKey(block, full);
  let s = INTERN.get(key);
  if (!s) {
    s = { id: block.id, block, props: Object.freeze(full), key };
    // withProp cache: property name -> value -> resulting state (non-enumerable, stays mutable)
    Object.defineProperty(s, '_with', { value: new Map() });
    Object.freeze(s);
    INTERN.set(key, s);
  }
  return s;
}

function coerce(values, v, id, name) {
  for (const allowed of values) {
    if (String(allowed) === String(v)) return allowed;
  }
  throw new Error(`Invalid value "${v}" for ${id}.${name}; allowed: ${values.join(', ')}`);
}

/** Returns the state with one property changed (BlockState.setValue). */
export function withProp(state, name, value) {
  if (state.props[name] === value) return state;
  // Interning makes the result a pure function of (state, name, value); only successful results
  // are cached, so invalid names and values still throw every time.
  let byValue = state._with.get(name);
  if (byValue !== undefined) {
    const hit = byValue.get(value);
    if (hit !== undefined) return hit;
  }
  const next = makeState(state.block, { ...state.props, [name]: value });
  if (byValue === undefined) state._with.set(name, (byValue = new Map()));
  byValue.set(value, next);
  return next;
}

export function withProps(state, changes) {
  return makeState(state.block, { ...state.props, ...changes });
}

/** Parses "repeater[facing=east,delay=2]" into { id, props }. */
export function parseBlockString(str) {
  const m = /^\s*(?:minecraft:)?([a-z0-9_]+)\s*(?:\[(.*)\])?\s*$/i.exec(str);
  if (!m) throw new Error(`Cannot parse block "${str}"`);
  const props = {};
  if (m[2] && m[2].trim()) {
    for (const part of m[2].split(',')) {
      const [k, v] = part.split('=').map((s) => s.trim());
      if (!k || v === undefined) throw new Error(`Bad property "${part}" in "${str}"`);
      props[k.toLowerCase()] = v.toLowerCase();
    }
  }
  return { id: m[1].toLowerCase(), props };
}
