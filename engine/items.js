// Item stacks as containers hold them (a port of the parts of ItemStack that hoppers, droppers and
// comparators use). Stacks are mutable and shared by reference, like vanilla's: a hopper that
// splits one item off a slot changes the stack object that slot holds.

/** Item.getDefaultMaxStackSize for the items a redstone build moves around. Everything else: 64. */
const ONE = [
  /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|horse_armor|bed|boat|raft|minecart|bundle)$/,
  /^(shears|flint_and_steel|fishing_rod|carrot_on_a_stick|warped_fungus_on_a_stick|bow|crossbow|trident|mace|brush|spyglass|elytra|shield|saddle|totem_of_undying|enchanted_book|written_book|writable_book|cake|goat_horn|knowledge_book|debug_stick|turtle_helmet|wolf_armor|minecart|bundle|potion|splash_potion|lingering_potion|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew|ominous_bottle)$/,
  /^music_disc_/,
  /_banner_pattern$|^(flower|creeper|skull|mojang|globe|piglin|flow|guster|field_masoned|bordure_indented)_banner_pattern$/,
  /(^|_)shulker_box$/,
  /^(water|lava|milk|powder_snow|axolotl|cod|salmon|pufferfish|tropical_fish|tadpole)_bucket$/,
];
const SIXTEEN = [
  /^(ender_pearl|snowball|egg|blue_egg|brown_egg|bucket|honey_bottle|armor_stand)$/,
  /_(sign|hanging_sign|banner)$/,
];

const CACHE = new Map();

export function maxStackSize(id) {
  let n = CACHE.get(id);
  if (n === undefined) {
    n = ONE.some((re) => re.test(id)) ? 1 : SIXTEEN.some((re) => re.test(id)) ? 16 : 64;
    CACHE.set(id, n);
  }
  return n;
}

export class ItemStack {
  constructor(id, count) {
    this.id = id;
    this.count = count;
  }

  static of(id, count = 1) {
    return id === 'air' || count <= 0 ? EMPTY : new ItemStack(id, count);
  }

  isEmpty() {
    return this === EMPTY || this.count <= 0;
  }

  getMaxStackSize() {
    return maxStackSize(this.id);
  }

  /** ItemStack.split: takes up to n off this stack and returns them as a new stack. */
  split(n) {
    const k = Math.min(n, this.count);
    if (this.isEmpty() || k <= 0) return EMPTY;
    const out = new ItemStack(this.id, k);
    this.shrink(k);
    return out;
  }

  copy() {
    return this.isEmpty() ? EMPTY : new ItemStack(this.id, this.count);
  }

  copyWithCount(n) {
    return this.isEmpty() || n <= 0 ? EMPTY : new ItemStack(this.id, n);
  }

  grow(n) {
    this.count += n;
  }

  shrink(n) {
    this.count -= n;
  }

  setCount(n) {
    this.count = n;
  }

  limitSize(max) {
    if (!this.isEmpty() && this.count > max) this.count = max;
  }

  toJSON() {
    return { id: this.id, count: this.count };
  }
}

/** ItemStack.EMPTY (shared, never changed). */
export const EMPTY = Object.freeze(Object.assign(Object.create(ItemStack.prototype), { id: 'air', count: 0 }));

export function sameItem(a, b) {
  return a.id === b.id;
}

/** AbstractContainerMenu.getRedstoneSignalFromContainer, with Java float arithmetic. */
export function redstoneSignalFromContainer(c) {
  if (!c) return 0;
  const f = Math.fround;
  let total = 0;
  const size = c.getContainerSize();
  for (let i = 0; i < size; i++) {
    const it = c.getItem(i);
    if (it.isEmpty()) continue;
    total = f(total + f(it.count / c.getMaxStackSizeFor(it)));
  }
  total = f(total / size);
  // Mth.lerpDiscrete(total, 0, 15)
  return Math.floor(f(total * 14)) + (total > 0 ? 1 : 0);
}
