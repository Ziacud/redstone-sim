// Browser stand-in for node:path (only what server/sim.js uses), with "/" separators.

export const sep = '/';

export function join(...parts) {
  const out = [];
  for (const seg of parts.join('/').split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/') || '.';
}

export const resolve = join;
export const basename = (p, ext = '') => {
  const b = String(p).split(/[\\/]/).pop();
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};

export default { sep, join, resolve, basename };
