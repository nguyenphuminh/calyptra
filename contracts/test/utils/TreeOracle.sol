// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {Shared, TREE_DEPTH} from "../../src/Shared.sol";

/// Test oracles for the batched insertion: the textbook one-leaf insert and a full
/// level-by-level rebuild of the tree.
library TreeOracle {
    function hash2(uint256 a, uint256 b) internal pure returns (uint256) {
        return PoseidonT3.hash([a, b]);
    }

    /// Textbook single insert: updates `filled` in place and returns the new root.
    function insertOne(uint256[20] memory filled, uint256 index, uint256 leaf) internal pure returns (uint256 node) {
        uint256[21] memory zeros = Shared.zeros();
        node = leaf;
        uint256 position = index;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            if (position % 2 == 1) {
                node = hash2(filled[level], node);
            } else {
                filled[level] = node;
                node = hash2(node, zeros[level]);
            }
            position >>= 1;
        }
    }

    /// Root of the tree whose leaves are exactly `leaves` (empty positions are 0).
    function fullRoot(uint256[] memory leaves) internal pure returns (uint256) {
        uint256[21] memory zeros = Shared.zeros();
        uint256[] memory nodes = leaves;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            if (nodes.length == 0) return zeros[TREE_DEPTH];
            uint256[] memory parents = new uint256[]((nodes.length + 1) / 2);
            for (uint256 i = 0; i < parents.length; i++) {
                uint256 left = nodes[2 * i];
                uint256 right = 2 * i + 1 < nodes.length ? nodes[2 * i + 1] : zeros[level];
                parents[i] = hash2(left, right);
            }
            nodes = parents;
        }
        return nodes[0];
    }
}
