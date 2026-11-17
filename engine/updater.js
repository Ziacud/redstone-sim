// Port of net.minecraft.world.level.redstone.CollectingNeighborUpdater (1.19+).
// Updates triggered while another update is running are collected and run depth-first
// right after the current single update finishes, which reproduces vanilla's ordering.

import { UPDATE_ORDER } from './dir.js';

export function executeUpdate(world, state, pos, sourceBlock, sourcePos, movedByPiston) {
  if (world.rec) world.record('neighbor', pos);
  state.block.neighborChanged(world, pos, state, sourceBlock, sourcePos, movedByPiston);
}

export function executeShapeUpdate(world, direction, neighborState, pos, neighborPos, flags, recursionLeft) {
  if (world.rec) world.record('shape', pos);
  const old = world.getBlockState(pos);
  const updated = old.block.updateShape(world, pos, old, direction, neighborState, neighborPos);
  world.updateOrDestroy(old, updated, pos, flags, recursionLeft);
}

class SimpleNeighborUpdate {
  constructor(pos, block, sourcePos) {
    this.pos = pos;
    this.block = block;
    this.sourcePos = sourcePos;
  }
  runNext(world) {
    executeUpdate(world, world.getBlockState(this.pos), this.pos, this.block, this.sourcePos, false);
    return false;
  }
}

class FullNeighborUpdate {
  constructor(state, pos, block, sourcePos, movedByPiston) {
    this.state = state;
    this.pos = pos;
    this.block = block;
    this.sourcePos = sourcePos;
    this.movedByPiston = movedByPiston;
  }
  runNext(world) {
    executeUpdate(world, this.state, this.pos, this.block, this.sourcePos, this.movedByPiston);
    return false;
  }
}

class ShapeUpdate {
  constructor(direction, state, pos, neighborPos, flags, recursionLeft) {
    this.direction = direction;
    this.state = state;
    this.pos = pos;
    this.neighborPos = neighborPos;
    this.flags = flags;
    this.recursionLeft = recursionLeft;
  }
  runNext(world) {
    executeShapeUpdate(world, this.direction, this.state, this.pos, this.neighborPos, this.flags, this.recursionLeft);
    return false;
  }
}

class MultiNeighborUpdate {
  constructor(sourcePos, block, skipDirection) {
    this.sourcePos = sourcePos;
    this.block = block;
    this.skip = skipDirection;
    this.idx = 0;
    if (UPDATE_ORDER[this.idx] === this.skip) this.idx++;
  }
  runNext(world) {
    const p = this.sourcePos.rel(UPDATE_ORDER[this.idx++]);
    executeUpdate(world, world.getBlockState(p), p, this.block, this.sourcePos, false);
    if (this.idx < UPDATE_ORDER.length && UPDATE_ORDER[this.idx] === this.skip) this.idx++;
    return this.idx < UPDATE_ORDER.length;
  }
}

export class CollectingNeighborUpdater {
  constructor(world, maxChained = 1000000) {
    this.world = world;
    this.max = maxChained;
    this.stack = [];
    this.addedThisLayer = [];
    this.count = 0;
    this.overflowed = false;
  }

  shapeUpdate(direction, state, pos, neighborPos, flags, recursionLeft) {
    this.addAndRun(new ShapeUpdate(direction, state, pos, neighborPos, flags, recursionLeft));
  }

  neighborChanged(pos, block, sourcePos) {
    this.addAndRun(new SimpleNeighborUpdate(pos, block, sourcePos));
  }

  neighborChangedFull(state, pos, block, sourcePos, movedByPiston) {
    this.addAndRun(new FullNeighborUpdate(state, pos, block, sourcePos, movedByPiston));
  }

  updateNeighborsAtExceptFromFacing(pos, block, skipDirection) {
    this.addAndRun(new MultiNeighborUpdate(pos, block, skipDirection));
  }

  addAndRun(update) {
    const nested = this.count > 0;
    const tooMany = this.max >= 0 && this.count >= this.max;
    this.count++;
    if (!tooMany) {
      if (nested) this.addedThisLayer.push(update);
      else this.stack.push(update);
    } else if (this.count - 1 === this.max) {
      this.overflowed = true; // vanilla logs "Too many chained neighbor updates. Skipping the rest."
    }
    if (!nested) this.runUpdates();
  }

  runUpdates() {
    try {
      while (this.stack.length || this.addedThisLayer.length) {
        for (let i = this.addedThisLayer.length - 1; i >= 0; i--) this.stack.push(this.addedThisLayer[i]);
        this.addedThisLayer.length = 0;
        const update = this.stack[this.stack.length - 1];
        while (this.addedThisLayer.length === 0) {
          if (!update.runNext(this.world)) {
            this.stack.pop();
            break;
          }
        }
      }
    } finally {
      this.stack.length = 0;
      this.addedThisLayer.length = 0;
      this.count = 0;
    }
  }
}
