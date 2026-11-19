// Directions and block positions, mirroring net.minecraft.core.Direction / BlockPos.
// Coordinate system is Minecraft's: +x = east, +y = up, +z = south (north = -z).

export class Dir {
  constructor(name, data3d, x, y, z, axis) {
    this.name = name;
    this.data3d = data3d;
    this.x = x;
    this.y = y;
    this.z = z;
    this.axis = axis;
  }
  get opposite() { return OPPOSITE[this.name]; }
  get isHorizontal() { return this.axis !== 'y'; }
  clockwise() { return CW[this.name]; }
  counterClockwise() { return CCW[this.name]; }
  toString() { return this.name; }
}

export const DOWN = new Dir('down', 0, 0, -1, 0, 'y');
export const UP = new Dir('up', 1, 0, 1, 0, 'y');
export const NORTH = new Dir('north', 2, 0, 0, -1, 'z');
export const SOUTH = new Dir('south', 3, 0, 0, 1, 'z');
export const WEST = new Dir('west', 4, -1, 0, 0, 'x');
export const EAST = new Dir('east', 5, 1, 0, 0, 'x');

const OPPOSITE = { down: UP, up: DOWN, north: SOUTH, south: NORTH, west: EAST, east: WEST };
const CW = { north: EAST, east: SOUTH, south: WEST, west: NORTH };
const CCW = { north: WEST, west: SOUTH, south: EAST, east: NORTH };

// Direction.values()
export const ALL = [DOWN, UP, NORTH, SOUTH, WEST, EAST];
// Direction.Plane.HORIZONTAL / VERTICAL
export const HORIZONTAL = [NORTH, EAST, SOUTH, WEST];
export const VERTICAL = [UP, DOWN];
// NeighborUpdater.UPDATE_ORDER
export const UPDATE_ORDER = [WEST, EAST, DOWN, UP, NORTH, SOUTH];
// BlockBehaviour.UPDATE_SHAPE_ORDER
export const UPDATE_SHAPE_ORDER = [WEST, EAST, NORTH, SOUTH, DOWN, UP];

export const BY_NAME = { down: DOWN, up: UP, north: NORTH, south: SOUTH, west: WEST, east: EAST };
export const BY_DATA3D = [DOWN, UP, NORTH, SOUTH, WEST, EAST];

export function dirByName(name) {
  const d = BY_NAME[String(name).toLowerCase()];
  if (!d) throw new Error(`Unknown direction "${name}"`);
  return d;
}

export class Pos {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  rel(dir, n = 1) { return new Pos(this.x + dir.x * n, this.y + dir.y * n, this.z + dir.z * n); }
  offset(dx, dy, dz) { return new Pos(this.x + dx, this.y + dy, this.z + dz); }
  above(n = 1) { return new Pos(this.x, this.y + n, this.z); }
  below(n = 1) { return new Pos(this.x, this.y - n, this.z); }
  equals(o) { return o.x === this.x && o.y === this.y && o.z === this.z; }
  get key() { return `${this.x},${this.y},${this.z}`; }
  // Vec3i.hashCode(): (y + z * 31) * 31 + x, with Java int overflow.
  get javaHash() { return (Math.imul((this.y + Math.imul(this.z, 31)) | 0, 31) + this.x) | 0; }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
  toArray() { return [this.x, this.y, this.z]; }
}

export function pos(x, y, z) { return new Pos(x, y, z); }

export function posFromKey(key) {
  const [x, y, z] = key.split(',').map(Number);
  return new Pos(x, y, z);
}
