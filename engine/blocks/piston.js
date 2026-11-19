// Ports of PistonBaseBlock, PistonHeadBlock, MovingPistonBlock, PistonMovingBlockEntity and
// PistonStructureResolver (push limit 12, slime/honey, quasi-connectivity, block dropping).

import { defineBlock, BaseBlock } from './base.js';
import { makeState, withProp, getBlock } from '../state.js';
import { ALL, BY_DATA3D, DOWN, UP, dirByName } from '../dir.js';
import { JavaPosMap } from '../javahash.js';
import { F, MIN_Y, MAX_Y } from '../world.js';

const DIRS6 = ['down', 'up', 'north', 'south', 'west', 'east'];
const PUSH_LIMIT = 12;

const isPiston = (s) => s.id === 'piston' || s.id === 'sticky_piston';
const isStickyBlock = (s) => !!s.block.sticky;
function canStickToEachOther(a, b) {
  if (a.block.sticky === 'honey' && b.block.sticky === 'slime') return false;
  if (a.block.sticky === 'slime' && b.block.sticky === 'honey') return false;
  return isStickyBlock(a) || isStickyBlock(b);
}

export function isPushable(state, world, pos, moveDir, allowDestroy, pistonFacing) {
  if (pos.y < MIN_Y || pos.y > MAX_Y - 1) return false;
  if (state.block.isAir) return true;
  if (state.block.pushReaction(state) === 'block' && !isPiston(state)) return false;
  if (moveDir === DOWN && pos.y === MIN_Y) return false;
  if (moveDir === UP && pos.y === MAX_Y - 1) return false;
  if (!isPiston(state)) {
    if (state.block.unbreakable) return false;
    switch (state.block.pushReaction(state)) {
      case 'block': return false;
      case 'destroy': return allowDestroy;
      case 'push_only': return moveDir === pistonFacing;
      default: break;
    }
  } else if (state.props.extended) {
    return false;
  }
  return !state.block.hasBlockEntity(state);
}

// ------------------------------------------------------------------ structure resolver

class PistonStructureResolver {
  constructor(world, pistonPos, pistonDir, extending) {
    this.world = world;
    this.pistonPos = pistonPos;
    this.pistonDirection = pistonDir;
    this.extending = extending;
    this.toPush = [];
    this.toDestroy = [];
    if (extending) {
      this.pushDirection = pistonDir;
      this.startPos = pistonPos.rel(pistonDir);
    } else {
      this.pushDirection = pistonDir.opposite;
      this.startPos = pistonPos.rel(pistonDir, 2);
    }
  }

  indexOf(p) {
    return this.toPush.findIndex((q) => q.equals(p));
  }

  resolve() {
    this.toPush = [];
    this.toDestroy = [];
    const st = this.world.getBlockState(this.startPos);
    if (!isPushable(st, this.world, this.startPos, this.pushDirection, false, this.pistonDirection)) {
      if (this.extending && st.block.pushReaction(st) === 'destroy') {
        this.toDestroy.push(this.startPos);
        return true;
      }
      return false;
    }
    if (!this.addBlockLine(this.startPos, this.pushDirection)) return false;
    for (let i = 0; i < this.toPush.length; i++) {
      const bp = this.toPush[i];
      if (isStickyBlock(this.world.getBlockState(bp)) && !this.addBranchingBlocks(bp)) return false;
    }
    return true;
  }

  addBlockLine(origin, direction) {
    const w = this.world;
    let st = w.getBlockState(origin);
    if (st.block.isAir) return true;
    if (!isPushable(st, w, origin, this.pushDirection, false, direction)) return true;
    if (origin.equals(this.pistonPos)) return true;
    if (this.indexOf(origin) >= 0) return true;
    let i = 1;
    if (i + this.toPush.length > PUSH_LIMIT) return false;
    while (isStickyBlock(st)) {
      const bp = origin.rel(this.pushDirection.opposite, i);
      const old = st;
      st = w.getBlockState(bp);
      if (
        st.block.isAir ||
        !canStickToEachOther(old, st) ||
        !isPushable(st, w, bp, this.pushDirection, false, this.pushDirection.opposite) ||
        bp.equals(this.pistonPos)
      ) break;
      i++;
      if (i + this.toPush.length > PUSH_LIMIT) return false;
    }
    let l = 0;
    for (let i1 = i - 1; i1 >= 0; i1--) {
      this.toPush.push(origin.rel(this.pushDirection.opposite, i1));
      l++;
    }
    let j1 = 1;
    for (;;) {
      const bp1 = origin.rel(this.pushDirection, j1);
      const j = this.indexOf(bp1);
      if (j > -1) {
        this.reorderListAtCollision(l, j);
        for (let k = 0; k <= j + l; k++) {
          const bp2 = this.toPush[k];
          if (isStickyBlock(w.getBlockState(bp2)) && !this.addBranchingBlocks(bp2)) return false;
        }
        return true;
      }
      st = w.getBlockState(bp1);
      if (st.block.isAir) return true;
      if (!isPushable(st, w, bp1, this.pushDirection, true, this.pushDirection) || bp1.equals(this.pistonPos)) return false;
      if (st.block.pushReaction(st) === 'destroy') {
        this.toDestroy.push(bp1);
        return true;
      }
      if (this.toPush.length >= PUSH_LIMIT) return false;
      this.toPush.push(bp1);
      l++;
      j1++;
    }
  }

  reorderListAtCollision(offsets, index) {
    const n = this.toPush.length;
    const a = this.toPush.slice(0, index);
    const b = this.toPush.slice(n - offsets, n);
    const c = this.toPush.slice(index, n - offsets);
    this.toPush = [...a, ...b, ...c];
  }

  addBranchingBlocks(from) {
    const st = this.world.getBlockState(from);
    for (const d of ALL) {
      if (d.axis !== this.pushDirection.axis) {
        const bp = from.rel(d);
        const bs = this.world.getBlockState(bp);
        if (canStickToEachOther(bs, st) && !this.addBlockLine(bp, d)) return false;
      }
    }
    return true;
  }
}

// ------------------------------------------------------------------ moving block entity

export class PistonMovingBlockEntity {
  constructor(pos, state, movedState, direction, extending, isSourcePiston) {
    this.type = 'moving_piston';
    this.pos = pos;
    this.state = state;
    this.movedState = movedState;
    this.direction = direction;
    this.extending = extending;
    this.isSourcePiston = isSourcePiston;
    this.progress = 0;
    this.progressO = 0;
    this.lastTicked = -1;
    this.removed = false;
  }

  isValid(state) { return state.id === 'moving_piston'; }

  /** Replacing block 36 finishes the move first. */
  preRemoveSideEffects() {
    this.finalTick();
  }

  getProgress(partial) {
    const p = Math.min(partial, 1);
    return this.progressO + (this.progress - this.progressO) * p;
  }

  finalTick() {
    const world = this.world;
    if (this.progressO < 1) {
      this.progress = 1;
      this.progressO = 1;
      world.removeBlockEntity(this.pos);
      this.removed = true;
      if (world.getBlockState(this.pos).id === 'moving_piston') {
        const st = this.isSourcePiston ? world.air : world.updateFromNeighbourShapes(this.movedState, this.pos);
        world.setBlock(this.pos, st, F.ALL);
        world.neighborChanged(this.pos, st.block, this.pos);
      }
    }
  }

  tick(world, pos) {
    this.lastTicked = world.time;
    this.progressO = this.progress;
    world.changed.add(pos.key);
    if (this.progressO >= 1) {
      world.removeBlockEntity(pos);
      this.removed = true;
      if (world.getBlockState(pos).id === 'moving_piston') {
        const st = world.updateFromNeighbourShapes(this.movedState, pos);
        if (st.block.isAir) {
          world.setBlock(pos, this.movedState, F.MOVE_BY_PISTON | F.KNOWN_SHAPE | F.INVISIBLE);
          world.updateOrDestroy(this.movedState, st, pos, F.ALL);
        } else {
          world.setBlock(pos, st, F.MOVE_BY_PISTON | F.CLIENTS | F.NEIGHBORS);
          world.neighborChanged(pos, st.block, pos);
        }
      }
    } else {
      this.progress = Math.min(1, this.progress + 0.5);
    }
  }

  save() {
    return {
      movedState: this.movedState.key,
      direction: this.direction.name,
      extending: this.extending,
      isSourcePiston: this.isSourcePiston,
      progress: this.progress,
      progressO: this.progressO,
      lastTicked: this.lastTicked,
    };
  }
}

function newMovingBlockEntity(world, pos, state, movedState, direction, extending, isSourcePiston) {
  const be = new PistonMovingBlockEntity(pos, state, movedState, direction, extending, isSourcePiston);
  be.world = world;
  return be;
}

// ------------------------------------------------------------------ piston base

function pistonBase(id, sticky) {
  return defineBlock({
    id,
    sticky: undefined,
    isStickyPiston: sticky,
    glyph: sticky ? 'P' : 'p',
    color: sticky ? 0x8cb46a : 0xb59b6b,
    properties: { facing: DIRS6, extended: [false, true] },
    defaults: { facing: 'up' },
    isConductor() { return false; },
    pushReaction() { return 'block'; },
    faceSturdy(state, dir, type = 'full') {
      return state.props.extended ? extendedBaseSturdy(state.props.facing, dir, type) : true;
    },
    reportPower(world, pos, state) {
      return state.props.extended ? 15 : 0;
    },
    getStateForPlacement(world, pos, props) {
      return makeState(this, { ...props, extended: false });
    },
    setPlacedBy(world, pos, state) {
      this.checkIfExtend(world, pos, state);
    },
    neighborChanged(world, pos, state) {
      this.checkIfExtend(world, pos, state);
    },
    onPlace(world, pos, state, oldState) {
      if (oldState.id !== state.id && world.getBlockEntity(pos) === null) this.checkIfExtend(world, pos, state);
    },

    checkIfExtend(world, pos, state) {
      const direction = dirByName(state.props.facing);
      const powered = getNeighborSignal(world, pos, direction);
      if (powered && !state.props.extended) {
        if (new PistonStructureResolver(world, pos, direction, true).resolve()) {
          world.blockEvent(pos, this, 0, direction.data3d);
        }
      } else if (!powered && state.props.extended) {
        const bp = pos.rel(direction, 2);
        const bs = world.getBlockState(bp);
        let i = 1;
        if (bs.id === 'moving_piston' && bs.props.facing === direction.name) {
          const be = world.getBlockEntity(bp);
          if (
            be instanceof PistonMovingBlockEntity &&
            be.extending &&
            (be.getProgress(0) < 0.5 || world.time === be.lastTicked || world.handlingTick)
          ) i = 2;
        }
        world.blockEvent(pos, this, i, direction.data3d);
      }
    },

    triggerEvent(world, pos, state, id, param) {
      const direction = dirByName(state.props.facing);
      const extendedState = withProp(state, 'extended', true);
      const powered = getNeighborSignal(world, pos, direction);
      if (powered && (id === 1 || id === 2)) {
        world.setBlock(pos, extendedState, F.CLIENTS);
        return false;
      }
      if (!powered && id === 0) return false;

      if (id === 0) {
        if (!this.moveBlocks(world, pos, direction, true)) return false;
        world.setBlock(pos, extendedState, F.MOVE_BY_PISTON | F.CLIENTS | F.NEIGHBORS);
      } else if (id === 1 || id === 2) {
        const headBe = world.getBlockEntity(pos.rel(direction));
        if (headBe instanceof PistonMovingBlockEntity) headBe.finalTick();
        const moving = makeState(getBlock('moving_piston'), {
          facing: direction.name,
          type: this.isStickyPiston ? 'sticky' : 'normal',
        });
        world.setBlock(pos, moving, F.KNOWN_SHAPE | F.INVISIBLE);
        world.setBlockEntity(
          newMovingBlockEntity(
            world,
            pos,
            moving,
            makeState(this, { facing: BY_DATA3D[param & 7].name, extended: false }),
            direction,
            false,
            true,
          ),
        );
        world.updateNeighborsAt(pos, moving.block);
        world.updateNeighbourShapes(pos, moving, F.CLIENTS);
        if (this.isStickyPiston) {
          const bp = pos.rel(direction, 2);
          const bs = world.getBlockState(bp);
          let finished = false;
          if (bs.id === 'moving_piston') {
            const be = world.getBlockEntity(bp);
            if (be instanceof PistonMovingBlockEntity && be.direction === direction && be.extending) {
              be.finalTick();
              finished = true;
            }
          }
          if (!finished) {
            if (
              id !== 1 ||
              bs.block.isAir ||
              !isPushable(bs, world, bp, direction.opposite, false, direction) ||
              (bs.block.pushReaction(bs) !== 'normal' && !isPiston(bs))
            ) {
              world.removeBlock(pos.rel(direction), false);
            } else {
              this.moveBlocks(world, pos, direction, false);
            }
          }
        } else {
          world.removeBlock(pos.rel(direction), false);
        }
      }
      return true;
    },

    moveBlocks(world, pos, facing, extending) {
      const headPos = pos.rel(facing);
      if (!extending && world.getBlockState(headPos).id === 'piston_head') {
        world.setBlock(headPos, world.air, F.KNOWN_SHAPE | F.INVISIBLE);
      }
      const resolver = new PistonStructureResolver(world, pos, facing, extending);
      if (!resolver.resolve()) return false;
      // Paper/CraftBukkit: BlockPistonExtendEvent / BlockPistonRetractEvent, which plugins (protection,
      // anti-lag) may cancel. world.pistonEvent({ pos, facing, extending, toPush }) -> false cancels.
      if (world.pistonEvent && !world.pistonEvent({ pos, facing, extending, toPush: resolver.toPush, toDestroy: resolver.toDestroy })) return false;

      const map = new JavaPosMap();
      const toPush = resolver.toPush;
      const pushedStates = [];
      for (const bp of toPush) {
        const bs = world.getBlockState(bp);
        pushedStates.push(bs);
        map.set(bp, bs);
      }
      const toDestroy = resolver.toDestroy;
      const affected = new Array(toPush.length + toDestroy.length);
      const moveDir = extending ? facing : facing.opposite;
      let j = 0;
      for (let k = toDestroy.length - 1; k >= 0; k--) {
        const bp = toDestroy[k];
        const bs = world.getBlockState(bp);
        world.setBlock(bp, world.air, F.KNOWN_SHAPE | F.CLIENTS);
        affected[j++] = bs;
      }
      const movingId = getBlock('moving_piston');
      for (let l = toPush.length - 1; l >= 0; l--) {
        const oldPos = toPush[l];
        const bs = world.getBlockState(oldPos);
        const bp = oldPos.rel(moveDir);
        map.delete(bp);
        const moving = makeState(movingId, { facing: facing.name, type: 'normal' });
        world.setBlock(bp, moving, F.MOVE_BY_PISTON | F.INVISIBLE);
        // Paper's "fix a variety of piston desync dupes" (allow-piston-duplication: false): the moving
        // block carries the block's current state, and the old spot turns to air right away
        if (world.paper && map.has(oldPos)) map.set(oldPos, bs);
        world.setBlockEntity(newMovingBlockEntity(world, bp, moving, world.paper ? bs : pushedStates[l], facing, extending, false));
        if (world.paper) world.setBlock(oldPos, world.air, F.CLIENTS | F.KNOWN_SHAPE | F.MOVE_BY_PISTON | F.SKIP_ON_PLACE);
        affected[j++] = bs;
      }
      if (extending) {
        const type = this.isStickyPiston ? 'sticky' : 'normal';
        const head = makeState(getBlock('piston_head'), { facing: facing.name, type, short: false });
        const moving = makeState(movingId, { facing: facing.name, type });
        map.delete(headPos);
        world.setBlock(headPos, moving, F.MOVE_BY_PISTON | F.INVISIBLE);
        world.setBlockEntity(newMovingBlockEntity(world, headPos, moving, head, facing, true, true));
      }
      const air = world.air;
      for (const bp of [...map.keys()]) world.setBlock(bp, air, F.MOVE_BY_PISTON | F.KNOWN_SHAPE | F.CLIENTS);
      for (const [bp, bs] of [...map.entries()]) {
        bs.block.updateIndirectNeighbourShapes(world, bp, bs, F.CLIENTS, 512);
        world.updateNeighbourShapes(bp, air, F.CLIENTS);
        air.block.updateIndirectNeighbourShapes(world, bp, air, F.CLIENTS, 512);
      }
      j = 0;
      for (let i1 = toDestroy.length - 1; i1 >= 0; i1--) {
        const bs = affected[j++];
        const bp = toDestroy[i1];
        // 1.21.5+: removal side effects of destroyed blocks run here, not inside setBlock(…, 18)
        bs.block.affectNeighborsAfterRemoval(world, bp, bs, false);
        bs.block.updateIndirectNeighbourShapes(world, bp, bs, F.CLIENTS, 512);
        world.updateNeighborsAt(bp, bs.block);
      }
      for (let j1 = toPush.length - 1; j1 >= 0; j1--) {
        world.updateNeighborsAt(toPush[j1], affected[j++].block);
      }
      if (extending) world.updateNeighborsAt(headPos, getBlock('piston_head'));
      return true;
    },
  });
}

/**
 * An extended base is 12/16 deep: its back face is full, its side faces only reach the center
 * (enough for a torch), and the face toward the head is open.
 */
function extendedBaseSturdy(facing, dir, type) {
  if (dir.name === facing) return false;
  if (dir.opposite.name === facing) return true;
  return type === 'center';
}

/** PistonBaseBlock.getNeighborSignal, including quasi-connectivity (the block above). */
function getNeighborSignal(world, pos, facing) {
  for (const d of ALL) {
    if (d !== facing && world.hasSignal(pos.rel(d), d)) return true;
  }
  if (world.hasSignal(pos, DOWN)) return true;
  const above = pos.above();
  for (const d of ALL) {
    if (d !== DOWN && world.hasSignal(above.rel(d), d)) return true;
  }
  return false;
}

pistonBase('piston', false);
pistonBase('sticky_piston', true);

// ------------------------------------------------------------------ piston head

function isFittingBase(head, base) {
  const id = head.props.type === 'normal' ? 'piston' : 'sticky_piston';
  return base.id === id && base.props.extended && base.props.facing === head.props.facing;
}

defineBlock({
  id: 'piston_head',
  glyph: 'h',
  color: 0xb59b6b,
  properties: { facing: DIRS6, type: ['normal', 'sticky'], short: [false, true] },
  isConductor() { return false; },
  pushReaction() { return 'block'; },
  // plate on the facing side, 4x4 arm toward the base
  faceSturdy(state, dir, type = 'full') {
    return dir.name === state.props.facing || (type === 'center' && dir.opposite.name === state.props.facing);
  },
  canSurvive(world, pos, state) {
    const bs = world.getBlockState(pos.rel(dirByName(state.props.facing).opposite));
    return isFittingBase(state, bs) || (bs.id === 'moving_piston' && bs.props.facing === state.props.facing);
  },
  updateShape(world, pos, state, dir) {
    return dir.opposite.name === state.props.facing && !this.canSurvive(world, pos, state) ? world.air : state;
  },
  neighborChanged(world, pos, state, sourceBlock, sourcePos) {
    if (this.canSurvive(world, pos, state)) {
      world.neighborChanged(pos.rel(dirByName(state.props.facing).opposite), sourceBlock, sourcePos);
    }
  },
  affectNeighborsAfterRemoval(world, pos, state) {
    const bp = pos.rel(dirByName(state.props.facing).opposite);
    if (isFittingBase(state, world.getBlockState(bp))) world.destroyBlock(bp, true);
  },
});

// ------------------------------------------------------------------ moving piston (block 36)

defineBlock({
  id: 'moving_piston',
  glyph: 'm',
  color: 0x666666,
  properties: { facing: DIRS6, type: ['normal', 'sticky'] },
  unbreakable: true,
  isConductor() { return false; },
  /**
   * PistonMovingBlockEntity.getCollisionShape: a retracting base keeps its extended-base shape;
   * the moved block (or the head, for a source piston) only fills the space once progress is 1.
   */
  faceSturdy(state, dir, type = 'full', world, pos) {
    const be = world && pos ? world.getBlockEntity(pos) : null;
    if (!(be instanceof PistonMovingBlockEntity)) return false;
    if (!be.extending && be.isSourcePiston && isPiston(be.movedState)) {
      if (extendedBaseSturdy(be.direction.name, dir, type)) return true;
    }
    if (be.progress >= 1) {
      const moved = be.isSourcePiston
        ? makeState(getBlock('piston_head'), { facing: be.direction.name, type: state.props.type })
        : be.movedState;
      return moved.block.faceSturdy(moved, dir, type, world, pos);
    }
    return false;
  },
  pushReaction() { return 'block'; },
  hasBlockEntity() { return true; },
  newBlockEntity() { return null; },
});
