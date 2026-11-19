// Browser stand-in for the few node:fs calls server/sim.js makes (design files). Files live in
// memory and, when they fit, in localStorage, so saved designs survive a reload of the page.
// Mapped to "node:fs" by the import map in index.html when there is no server.

const PREFIX = 'redstone-sim:file:';
const files = new Map(); // path -> { data, mtimeMs }

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');

try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith(PREFIX)) continue;
    const v = JSON.parse(localStorage.getItem(key));
    files.set(key.slice(PREFIX.length), v);
  }
} catch {
  // storage blocked (private window, settings): files then last until the tab closes
}

const persist = (p) => {
  try {
    if (files.has(p)) localStorage.setItem(PREFIX + p, JSON.stringify(files.get(p)));
    else localStorage.removeItem(PREFIX + p);
  } catch {
    // full or blocked: keep the file in memory only
  }
};

const missing = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

/** Puts a shipped file (e.g. the demo design) in place without storing it. */
export function seed(p, data) {
  files.set(norm(p), { data, mtimeMs: 0 });
}

export function readFileSync(p) {
  const f = files.get(norm(p));
  if (!f) throw missing(p);
  return f.data;
}

export function writeFileSync(p, data) {
  p = norm(p);
  files.set(p, { data: String(data), mtimeMs: Date.now() });
  persist(p);
}

export function existsSync(p) {
  p = norm(p).replace(/\/$/, '');
  if (files.has(p)) return true;
  for (const k of files.keys()) if (k.startsWith(p + '/')) return true;
  return false;
}

export function mkdirSync() {}

export function readdirSync(dir) {
  const d = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) if (k.startsWith(d)) out.add(k.slice(d.length).split('/')[0]);
  return [...out];
}

export function statSync(p) {
  const f = files.get(norm(p));
  if (!f) throw missing(p);
  return { size: f.data.length, mtimeMs: f.mtimeMs, isFile: () => true, isDirectory: () => false };
}

export function unlinkSync(p) {
  p = norm(p);
  if (!files.delete(p)) throw missing(p);
  persist(p);
}

export default { seed, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync };
