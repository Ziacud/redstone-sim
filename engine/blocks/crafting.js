// The crafter (CrafterBlock + CrafterBlockEntity, with the vanilla crafting recipes from
// engine/recipes.js) and the composter (ComposterBlock and its WorldlyContainer views for hoppers).
// Not simulated: item entities (a crafter facing air removes what it would throw; a full composter
// emptied by hand drops nothing), the GUI's slot toggling (kept in saves: disabledSlots), the
// special recipes that need item components (fireworks, banners, map extending, repair, armour dye).

import { defineBlock } from './base.js';
import { makeState, withProp } from '../state.js';
import { UP, DOWN, dirByName } from '../dir.js';
import { F } from '../world.js';
import { ItemStack, EMPTY } from '../items.js';
import { ContainerBlockEntity, addItem, getContainerAt } from './containers.js';
import { RECIPES, TAGS } from '../recipes.js';

// ------------------------------------------------------------------ recipes

const TAG_SETS = new Map(Object.entries(TAGS).map(([k, v]) => [k, new Set(v)]));

/** Ingredient.test (an empty cell, 0, matches only an empty stack: testOptionalIngredient). */
function test(ing, stack) {
  if (ing === 0) return stack.isEmpty();
  if (stack.isEmpty()) return false;
  if (typeof ing === 'string') return ing[0] === '#' ? (TAG_SETS.get(ing.slice(1))?.has(stack.id) ?? false) : ing === stack.id;
  return ing.includes(stack.id);
}

/** CraftingInput.of(3, 3, items): trimmed to the filled rectangle. */
function craftingInput(items) {
  let left = 2;
  let right = 0;
  let top = 2;
  let bottom = 0;
  for (let y = 0; y < 3; y++) {
    let rowEmpty = true;
    for (let x = 0; x < 3; x++) {
      if (items[x + y * 3].isEmpty()) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      rowEmpty = false;
    }
    if (rowEmpty) continue;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (width <= 0 || height <= 0) return { width: 0, height: 0, items: [], count: 0 };
  const out = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.push(items[x + left + (y + top) * 3]);
  return { width, height, items: out, count: out.filter((s) => !s.isEmpty()).length };
}

const symmetrical = new WeakMap();
function isSymmetrical(r) {
  let v = symmetrical.get(r);
  if (v === undefined) {
    const [, , w, h, cells] = r;
    v = true;
    for (let y = 0; y < h && v; y++) {
      for (let x = 0; x < w; x++) {
        if (JSON.stringify(cells[x + y * w]) !== JSON.stringify(cells[w - 1 - x + y * w])) {
          v = false;
          break;
        }
      }
    }
    symmetrical.set(r, v);
  }
  return v;
}

/** ShapedRecipePattern.matches */
function matchesShaped(r, input) {
  const [, , w, h, cells] = r;
  if (input.width !== w || input.height !== h) return false;
  if (input.count !== cells.filter((c) => c !== 0).length) return false;
  const at = (flip) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ing = cells[flip ? w - 1 - x + y * w : x + y * w];
        if (!test(ing, input.items[x + y * w])) return false;
      }
    }
    return true;
  };
  return (!isSymmetrical(r) && at(true)) || at(false);
}

/** ShapelessRecipe.matches: every ingredient gets its own item (StackedItemContents.canCraft). */
function matchesShapeless(r, input) {
  const ings = r[2];
  const stacks = input.items.filter((s) => !s.isEmpty());
  if (stacks.length !== ings.length) return false;
  const owner = new Array(stacks.length).fill(-1); // stack -> ingredient
  const assign = (i, seen) => {
    for (let s = 0; s < stacks.length; s++) {
      if (seen[s] || !test(ings[i], stacks[s])) continue;
      seen[s] = true;
      if (owner[s] < 0 || assign(owner[s], seen)) {
        owner[s] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < ings.length; i++) if (!assign(i, new Array(stacks.length).fill(false))) return false;
  return true;
}

/** TransmuteRecipe.matches */
function matchesTransmute(r, input) {
  const [, , inIng, matIng, [min, max], result, count, addMaterial] = r;
  if (input.count < min + 1 || input.count > max + 1) return false;
  let found = null;
  let materials = 0;
  for (const s of input.items) {
    if (s.isEmpty()) continue;
    if (test(inIng, s)) {
      if (found) return false;
      found = s;
    } else if (test(matIng, s)) {
      if (++materials > max) return false;
    } else return false;
  }
  if (!found || materials < min || materials > max) return false;
  const size = addMaterial ? materials + count : count;
  if (size !== 1) return true;
  return found.id !== result; // items carry no components here
}

/** RecipeManager.getRecipeFor(CRAFTING, input): the first matching recipe by id. */
export function findRecipe(input) {
  if (input.count === 0) return null;
  for (const r of RECIPES) {
    const ok = r[0] === 's' ? matchesShaped(r, input) : r[0] === 'l' ? matchesShapeless(r, input) : matchesTransmute(r, input);
    if (ok) return r;
  }
  return null;
}

/** Recipe.assemble */
function assemble(r, input) {
  if (r[0] === 't') {
    const [, , inIng, matIng, , result, count, addMaterial] = r;
    const materials = addMaterial ? input.items.filter((s) => !s.isEmpty() && !test(inIng, s) && test(matIng, s)).length : 0;
    return ItemStack.of(result, count + materials);
  }
  return r[0] === 's' ? ItemStack.of(r[5], r[6]) : ItemStack.of(r[3], r[4]);
}

// Item.craftingRemainder
const REMAINDER = { water_bucket: 'bucket', lava_bucket: 'bucket', milk_bucket: 'bucket', dragon_breath: 'glass_bottle', honey_bottle: 'glass_bottle' };

/** CraftingRecipe.defaultCraftingReminder, over the trimmed input. */
const remainingItems = (input) => input.items.map((s) => (s.isEmpty() || !REMAINDER[s.id] ? EMPTY : ItemStack.of(REMAINDER[s.id], 1)));

// ------------------------------------------------------------------ crafter

class CrafterBlockEntity extends ContainerBlockEntity {
  constructor(pos, state) {
    super('crafter', pos, state, 9);
    this.disabled = new Array(9).fill(false);
    this.triggered = !!state.props.triggered;
    this.craftingTicksRemaining = 0;
  }

  slotCanBeDisabled(slot) { return slot > -1 && slot < 9 && this.items[slot].isEmpty(); }
  isSlotDisabled(slot) { return slot >= 0 && slot < 9 && this.disabled[slot]; }
  setSlotState(slot, enabled) {
    if (!this.slotCanBeDisabled(slot)) return;
    this.disabled[slot] = !enabled;
    this.setChanged();
  }

  /** Spreads items: a slot takes one only if no later enabled slot holds fewer (or is empty). */
  canPlaceItem(slot, stack) {
    if (this.disabled[slot]) return false;
    const cur = this.items[slot];
    if (cur.count >= cur.getMaxStackSize()) return false;
    if (cur.isEmpty()) return true;
    for (let i = slot + 1; i < 9; i++) {
      if (this.isSlotDisabled(i)) continue;
      const s = this.items[i];
      if (s.isEmpty() || (s.count < cur.count && s.id === cur.id)) return false;
    }
    return true;
  }

  setItem(slot, stack) {
    if (this.isSlotDisabled(slot)) this.setSlotState(slot, true);
    super.setItem(slot, stack);
  }

  getRedstoneSignal() {
    let n = 0;
    for (let i = 0; i < 9; i++) if (!this.items[i].isEmpty() || this.isSlotDisabled(i)) n++;
    return n;
  }

  /** CrafterBlockEntity.serverTick */
  tick(world, pos, state) {
    const left = this.craftingTicksRemaining - 1;
    if (left < 0) return;
    this.craftingTicksRemaining = left;
    if (left === 0) world.setBlock(pos, withProp(state, 'crafting', false), F.ALL);
  }

  save() {
    const out = super.save();
    const disabled = this.disabled.flatMap((d, i) => (d ? [i] : []));
    if (disabled.length) out.disabledSlots = disabled;
    if (this.triggered) out.triggered = 1;
    if (this.craftingTicksRemaining) out.craftingTicksRemaining = this.craftingTicksRemaining;
    return out;
  }

  load(data) {
    super.load(data);
    this.disabled.fill(false);
    for (const i of data?.disabledSlots ?? []) if (this.slotCanBeDisabled(i)) this.disabled[i] = true;
    this.triggered = !!data?.triggered;
    this.craftingTicksRemaining = data?.craftingTicksRemaining ?? 0;
  }
}

// FrontAndTop, in enum order
const ORIENTATIONS = ['down_east', 'down_north', 'down_south', 'down_west', 'up_east', 'up_north', 'up_south', 'up_west', 'west_up', 'east_up', 'north_up', 'south_up'];

defineBlock({
  id: 'crafter',
  glyph: 'R',
  color: 0x6b6b70,
  properties: { orientation: ORIENTATIONS, triggered: [false, true], crafting: [false, true] },
  defaults: { orientation: 'north_up' },
  hasBlockEntity() { return true; },
  newBlockEntity(pos, state) { return new CrafterBlockEntity(pos, state); },
  pushReaction() { return 'block'; },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos) {
    const be = world.getBlockEntity(pos);
    return be instanceof CrafterBlockEntity ? be.getRedstoneSignal() : 0;
  },
  reportPower(world, pos, state) { return this.getAnalogOutput(world, pos, state); },
  front(state) { return dirByName(state.props.orientation.split('_')[0]); },
  getStateForPlacement(world, pos, props) {
    const s = makeState(this, props);
    return 'triggered' in props ? s : withProp(s, 'triggered', world.hasNeighborSignal(pos));
  },
  setPlacedBy(world, pos, state) {
    if (state.props.triggered) world.scheduleTick(pos, this, 4);
  },
  neighborChanged(world, pos, state) {
    const should = world.hasNeighborSignal(pos);
    const be = world.getBlockEntity(pos);
    if (should && !state.props.triggered) {
      world.scheduleTick(pos, this, 4);
      world.setBlock(pos, withProp(state, 'triggered', true), F.CLIENTS);
      if (be instanceof CrafterBlockEntity) be.triggered = true;
    } else if (!should && state.props.triggered) {
      world.setBlock(pos, withProp(withProp(state, 'triggered', false), 'crafting', false), F.CLIENTS);
      if (be instanceof CrafterBlockEntity) be.triggered = false;
    }
  },
  /** Containers.updateNeighboursAfterDestroy */
  affectNeighborsAfterRemoval(world, pos, state) {
    world.updateNeighbourForOutputSignal(pos, state.block);
  },
  /** CrafterBlock.dispenseFrom */
  tick(world, pos, state) {
    const be = world.getBlockEntity(pos);
    if (!(be instanceof CrafterBlockEntity)) return;
    const input = craftingInput(be.items);
    const recipe = findRecipe(input);
    if (!recipe) return;
    const result = assemble(recipe, input);
    if (result.isEmpty()) return;
    be.craftingTicksRemaining = 6;
    world.setBlock(pos, withProp(state, 'crafting', true), F.CLIENTS);
    this.dispenseItem(world, pos, be, result, state);
    for (const rest of remainingItems(input)) if (!rest.isEmpty()) this.dispenseItem(world, pos, be, rest, state);
    for (const it of be.items) if (!it.isEmpty()) it.shrink(1);
    be.setChanged();
  },
  dispenseItem(world, pos, be, result, state) {
    const dir = this.front(state);
    const into = getContainerAt(world, pos.rel(dir));
    let remaining = result.copy();
    if (into && (into instanceof CrafterBlockEntity || result.count > into.getMaxStackSizeFor(result))) {
      while (!remaining.isEmpty() && addItem(be, into, remaining.copyWithCount(1), dir.opposite).isEmpty()) remaining.shrink(1);
    } else if (into) {
      while (!remaining.isEmpty()) {
        const before = remaining.count;
        remaining = addItem(be, into, remaining, dir.opposite);
        if (remaining.count === before) break;
      }
    }
    // what is left would be thrown out as an item entity (not simulated)
  },
});

// ------------------------------------------------------------------ composter

// ComposterBlock.COMPOSTABLES (chances are floats)
const COMPOSTABLES = new Map();
for (const [chance, ids] of [
  [0.3, 'acacia_leaves acacia_sapling azalea_leaves beetroot_seeds birch_leaves birch_sapling bush cactus_flower cherry_leaves cherry_sapling dark_oak_leaves dark_oak_sapling dried_kelp dry_short_grass dry_tall_grass firefly_bush glow_berries hanging_roots jungle_leaves jungle_sapling kelp leaf_litter mangrove_leaves mangrove_propagule mangrove_roots melon_seeds moss_carpet oak_leaves oak_sapling pale_hanging_moss pale_moss_carpet pale_oak_leaves pale_oak_sapling pink_petals pitcher_pod pumpkin_seeds seagrass short_grass small_dripleaf spruce_leaves spruce_sapling sweet_berries torchflower_seeds wheat_seeds wildflowers'],
  [0.5, 'cactus dried_kelp_block flowering_azalea_leaves glow_lichen melon_slice nether_sprouts sugar_cane tall_grass twisting_vines vine weeping_vines'],
  [0.65, 'allium apple azalea azure_bluet beetroot big_dripleaf blue_orchid brown_mushroom carrot carved_pumpkin closed_eyeblossom cocoa_beans cornflower crimson_fungus crimson_roots dandelion fern large_fern lilac lily_of_the_valley lily_pad melon moss_block mushroom_stem nether_wart open_eyeblossom orange_tulip oxeye_daisy pale_moss_block peony pink_tulip poppy potato pumpkin red_mushroom red_tulip rose_bush sea_pickle shroomlight spore_blossom sunflower warped_fungus warped_roots wheat white_tulip wither_rose'],
  [0.85, 'baked_potato bread brown_mushroom_block cookie flowering_azalea hay_block nether_wart_block pitcher_plant red_mushroom_block torchflower warped_wart_block'],
  [1.0, 'cake pumpkin_pie'],
]) {
  for (const id of ids.split(' ')) COMPOSTABLES.set(id, Math.fround(chance));
}
export const isCompostable = (id) => COMPOSTABLES.has(id);

/** SimpleContainer with one slot, as the composter hands it to hoppers. */
class ComposterContainer {
  constructor(world, pos, state, contents = EMPTY) {
    this.world = world;
    this.pos = pos;
    this.state = state;
    this.items = [contents];
    this.changed = false;
  }
  getContainerSize() { return this.items.length; }
  getItem(slot) { return this.items[slot] ?? EMPTY; }
  isEmpty() { return this.items.every((s) => s.isEmpty()); }
  getMaxStackSize() { return 1; }
  getMaxStackSizeFor(stack) { return Math.min(1, stack.getMaxStackSize()); }
  canPlaceItem() { return true; }
  canTakeItem() { return true; }
  setItem(slot, stack) {
    this.items[slot] = stack;
    stack.limitSize(this.getMaxStackSizeFor(stack));
    this.setChanged();
  }
  removeItem(slot, count) {
    const cur = this.items[slot];
    if (!cur || cur.isEmpty() || count <= 0) return EMPTY;
    const out = cur.split(count);
    if (!out.isEmpty()) this.setChanged();
    return out;
  }
}

/** ComposterBlock.InputContainer: takes one compostable item from above. */
class ComposterInput extends ComposterContainer {
  getSlotsForFace(dir) { return dir === UP ? [0] : []; }
  canPlaceItemThroughFace(slot, stack, dir) { return !this.changed && dir === UP && COMPOSTABLES.has(stack.id); }
  canTakeItemThroughFace() { return false; }
  setChanged() {
    const contents = this.items[0];
    if (contents.isEmpty()) return;
    this.changed = true;
    composterAddItem(this.world, this.pos, this.state, contents);
    this.items[0] = EMPTY;
  }
}

/** ComposterBlock.OutputContainer: one bone meal for a hopper below. */
class ComposterOutput extends ComposterContainer {
  getSlotsForFace(dir) { return dir === DOWN ? [0] : []; }
  canPlaceItemThroughFace() { return false; }
  canTakeItemThroughFace(slot, stack, dir) { return !this.changed && dir === DOWN && stack.id === 'bone_meal'; }
  setChanged() {
    composterEmpty(this.world, this.pos, this.state);
    this.changed = true;
  }
}

/** ComposterBlock.EmptyContainer (level 7: waiting to turn ready). */
class ComposterNone extends ComposterContainer {
  constructor(world, pos, state) {
    super(world, pos, state);
    this.items = [];
  }
  getSlotsForFace() { return []; }
  canPlaceItemThroughFace() { return false; }
  canTakeItemThroughFace() { return false; }
  setChanged() {}
}

function composterEmpty(world, pos, state) {
  const next = withProp(state, 'level', 0);
  world.setBlock(pos, next, F.ALL);
  world.gameEvent('block_change', pos, next);
  return next;
}

/** ComposterBlock.addItem: the first item always counts, later ones with the item's chance. */
function composterAddItem(world, pos, state, stack) {
  const level = state.props.level;
  const chance = COMPOSTABLES.get(stack.id) ?? -1;
  if ((level === 0 && chance > 0) || world.random.nextDouble() < chance) {
    const next = withProp(state, 'level', level + 1);
    world.setBlock(pos, next, F.ALL);
    world.gameEvent('block_change', pos, next);
    if (level + 1 === 7) world.scheduleTick(pos, state.block, 20);
    return next;
  }
  return state;
}

defineBlock({
  id: 'composter',
  glyph: 'K',
  color: 0x7a5a2e,
  properties: { level: [...Array(9).keys()] },
  isConductor() { return false; },
  /** the top has a hole; the walls and the bottom are full */
  faceSturdy(state, dir) { return dir !== UP; },
  hasAnalogOutput() { return true; },
  getAnalogOutput(world, pos, state) { return state.props.level; },
  reportPower(world, pos, state) { return state.props.level; },
  onPlace(world, pos, state) {
    if (state.props.level === 7) world.scheduleTick(pos, this, 20);
  },
  tick(world, pos, state) {
    if (state.props.level === 7) world.setBlock(pos, withProp(state, 'level', 8), F.ALL);
  },
  /** useWithoutItem: a full composter is emptied (the bone meal item is not simulated) */
  use(world, pos, state) {
    if (state.props.level !== 8) return false;
    composterEmpty(world, pos, state);
    return true;
  },
  /** useItemOn with a compostable item (MCP interact / tests) */
  insertItem(world, pos, state, id) {
    if (state.props.level >= 8 || !COMPOSTABLES.has(id)) return false;
    if (state.props.level < 7) composterAddItem(world, pos, state, ItemStack.of(id, 1));
    return true;
  },
  getWorldlyContainer(world, pos, state) {
    const level = state.props.level;
    if (level === 8) return new ComposterOutput(world, pos, state, ItemStack.of('bone_meal', 1));
    if (level < 7) return new ComposterInput(world, pos, state);
    return new ComposterNone(world, pos, state);
  },
});
