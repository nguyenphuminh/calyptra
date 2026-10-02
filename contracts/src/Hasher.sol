// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {InvalidField, SNARK_SCALAR_FIELD, Shared, TREE_CAPACITY, TREE_DEPTH, TreeFull} from "./Shared.sol";

/// Stateless circomlib-compatible Poseidon(2) and the pool's batched append-only Merkle insertion
/// (all-ref §4.7). Holds no state and no references; the pool reaches it with STATICCALL.
contract Hasher {
    /// circomlib Poseidon with two inputs (t = 3). Inputs must be field elements.
    function hash2(uint256 a, uint256 b) external pure returns (uint256) {
        if (a >= SNARK_SCALAR_FIELD || b >= SNARK_SCALAR_FIELD) revert InvalidField();
        return _hash2(a, b);
    }

    /// Appends `leaves` at `nextIndex` to the tree whose frontier is `filled` (the latest LEFT child per
    /// level); returns the updated frontier and the root after the whole batch.
    function insertLeaves(uint256[20] calldata filled, uint64 nextIndex, uint256[] calldata leaves)
        external
        pure
        returns (uint256[20] memory, uint256)
    {
        bool outOfField = false;
        for (uint256 i = 0; i < leaves.length; i++) {
            outOfField = outOfField || leaves[i] >= SNARK_SCALAR_FIELD;
        }
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            outOfField = outOfField || filled[level] >= SNARK_SCALAR_FIELD;
        }
        if (outOfField) revert InvalidField();
        if (leaves.length == 0 || uint256(nextIndex) + leaves.length > TREE_CAPACITY) revert TreeFull();
        return _insertLeaves(filled, nextIndex, leaves);
    }

    function _hash2(uint256 a, uint256 b) internal pure returns (uint256) {
        return PoseidonT3.hash([a, b]);
    }

    /// Batch insertion (all-ref §4.7.3): leaves inserted together share the upper part of their paths.
    /// `nodes` are the new nodes of the current level, the first one at position `start`.
    function _insertLeaves(uint256[20] memory filled, uint256 nextIndex, uint256[] memory leaves)
        internal
        pure
        returns (uint256[20] memory, uint256 root)
    {
        if (leaves.length == 0 || nextIndex + leaves.length > TREE_CAPACITY) revert TreeFull();
        uint256[21] memory zeros = Shared.zeros();
        uint256[] memory nodes = leaves;
        uint256 start = nextIndex;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            uint256 last = start + nodes.length - 1;
            uint256 previousLeft = filled[level];
            uint256[] memory parents = new uint256[]((last >> 1) - (start >> 1) + 1);
            uint256 p = 0;
            for (uint256 pos = start & ~uint256(1); pos <= last; pos += 2) {
                uint256 left = pos < start ? previousLeft : nodes[pos - start];
                uint256 right = pos < last ? nodes[pos + 1 - start] : zeros[level];
                parents[p++] = _hash2(left, right);
            }
            uint256 lastLeft = last & ~uint256(1); // right-most new LEFT child at this level
            if (lastLeft >= start) filled[level] = nodes[lastLeft - start];
            nodes = parents;
            start >>= 1;
        }
        return (filled, nodes[0]);
    }
}
