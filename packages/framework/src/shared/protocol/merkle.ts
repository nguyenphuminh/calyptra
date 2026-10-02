import { hash2 } from './poseidon.ts';

/** Depth of the pool's commitment tree: room for about 1 million notes (BRD 2.2.1). */
export const TREE_DEPTH = 20;
/** The pool contract remembers this many recent roots (BRD 2.2.1). */
export const ROOT_HISTORY_SIZE = 100;

const zeroCache: bigint[] = [];

/** zeros[0] is an empty leaf (0); zeros[i + 1] = H(zeros[i], zeros[i]). */
export function zeroValues(depth = TREE_DEPTH): readonly bigint[] {
  if (zeroCache.length === 0) zeroCache.push(0n);
  while (zeroCache.length <= depth) {
    const last = zeroCache[zeroCache.length - 1] as bigint;
    zeroCache.push(hash2(last, last));
  }
  return zeroCache.slice(0, depth + 1);
}

export interface MerkleProof {
  leafIndex: number;
  pathElements: bigint[];
}

/** Append-only Merkle tree mirroring the on-chain one, built from the pool's commitment events. */
export class MerkleTree {
  readonly depth: number;
  private readonly layers: bigint[][];
  private readonly zeros: readonly bigint[];

  constructor(depth = TREE_DEPTH, leaves: readonly bigint[] = []) {
    this.depth = depth;
    this.zeros = zeroValues(depth);
    this.layers = Array.from({ length: depth + 1 }, () => []);
    for (const leaf of leaves) this.insert(leaf);
  }

  get size(): number {
    return (this.layers[0] as bigint[]).length;
  }

  get root(): bigint {
    const top = this.layers[this.depth] as bigint[];
    return top.length > 0 ? (top[0] as bigint) : (this.zeros[this.depth] as bigint);
  }

  leaves(): readonly bigint[] {
    return this.layers[0] as bigint[];
  }

  insert(leaf: bigint): number {
    const index = this.size;
    if (index >= 2 ** this.depth) throw new RangeError('Merkle tree is full');
    (this.layers[0] as bigint[]).push(leaf);
    let node = leaf;
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const isRight = i % 2 === 1;
      const sibling = isRight
        ? ((this.layers[level] as bigint[])[i - 1] as bigint)
        : ((this.layers[level] as bigint[])[i + 1] ?? (this.zeros[level] as bigint));
      node = isRight ? hash2(sibling, node) : hash2(node, sibling);
      i >>= 1;
      (this.layers[level + 1] as bigint[])[i] = node;
    }
    return index;
  }

  indexOf(leaf: bigint): number {
    return (this.layers[0] as bigint[]).indexOf(leaf);
  }

  proof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.size) throw new RangeError('leaf index out of range');
    const pathElements: bigint[] = [];
    let i = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const siblingIndex = i % 2 === 1 ? i - 1 : i + 1;
      pathElements.push((this.layers[level] as bigint[])[siblingIndex] ?? (this.zeros[level] as bigint));
      i >>= 1;
    }
    return { leafIndex, pathElements };
  }

  /** A proof for an empty slot, used by dummy inputs whose membership is not checked. */
  emptyProof(): MerkleProof {
    return { leafIndex: 0, pathElements: this.zeros.slice(0, this.depth) as bigint[] };
  }
}
