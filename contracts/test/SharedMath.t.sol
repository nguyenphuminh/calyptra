// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hasher} from "../src/Hasher.sol";
import {Shared, TreeFull} from "../src/Shared.sol";
import {TreeOracle} from "./utils/TreeOracle.sol";

/// Exposes the internal encodings with calldata arguments, as Pool and Disputes call them.
contract SharedHarness {
    function reduce(uint256 x) external pure returns (uint256) {
        return Shared.reduce(x);
    }

    function extDataHash(address recipient, bytes calldata cts) external pure returns (bool, uint256) {
        return Shared.extDataHash(recipient, cts);
    }
}

/// all-ref §4.10.5 (shared math: encodings and the tree).
contract SharedMathTest is Test {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    SharedHarness internal shared;
    Hasher internal hasher;

    function setUp() public {
        shared = new SharedHarness();
        hasher = new Hasher();
    }

    function test_reduceMatchesModulo() public view {
        assertEq(shared.reduce(0), 0);
        assertEq(shared.reduce(R - 1), R - 1);
        assertEq(shared.reduce(R), 0);
        assertEq(shared.reduce(R + 5), 5);
        assertEq(
            shared.reduce(type(uint256).max),
            6350874878119819312338956282401532410528162663560392320966563075034087161850
        );
    }

    function test_extDataHashNeedsThreeFullCiphertexts() public view {
        (bool ok, uint256 h) = shared.extDataHash(address(1), new bytes(504));
        assertTrue(ok);
        // extDataHashOf({ recipient: 0x00..01, three ciphertexts of 168 zero bytes }) (all-ref §3.17).
        assertEq(h, 10472773345416213608939933309650111419917463049876096415424922068459820375380);
        (ok, h) = shared.extDataHash(address(1), new bytes(503));
        assertFalse(ok);
        assertEq(h, 0);
        (ok,) = shared.extDataHash(address(1), new bytes(505));
        assertFalse(ok);
    }

    function test_packsTokenAboveTheAmountBits() public pure {
        assertEq(Shared.packAmountToken(address(0), 5), 5);
        assertEq(Shared.packAmountToken(address(1), 5), (1 << 64) + 5);
    }

    /// 9 rounds of 3-leaf batches match a full level-by-level rebuild after every round.
    function test_incrementalBatchesMatchAFullRebuild() public view {
        uint256[20] memory frontier;
        uint256[] memory all = new uint256[](27);
        for (uint256 round = 0; round < 9; round++) {
            uint256[] memory batch = new uint256[](3);
            for (uint256 j = 0; j < 3; j++) {
                batch[j] = _leaf(round * 3 + j);
                all[round * 3 + j] = batch[j];
            }
            uint256 root;
            (frontier, root) = hasher.insertLeaves(frontier, uint64(round * 3), batch);
            assertEq(root, TreeOracle.fullRoot(_prefix(all, (round + 1) * 3)));
        }
    }

    /// Batch sizes 1..5 over 7 rounds each match one-at-a-time insertion (root and frontier) and a full rebuild.
    function test_batchesOfAnySizeAndAlignmentMatchSingleInserts() public view {
        for (uint256 size = 1; size <= 5; size++) {
            uint256[20] memory batched;
            uint256[20] memory single;
            uint256[] memory all = new uint256[](size * 7);
            uint256 next = 0;
            for (uint256 round = 0; round < 7; round++) {
                uint256[] memory batch = new uint256[](size);
                uint256 singleRoot;
                for (uint256 j = 0; j < size; j++) {
                    batch[j] = _leaf(1000 * size + next);
                    all[next] = batch[j];
                    singleRoot = TreeOracle.insertOne(single, next, batch[j]);
                    next++;
                }
                uint256 batchRoot;
                (batched, batchRoot) = hasher.insertLeaves(batched, uint64(next - size), batch);
                assertEq(batchRoot, singleRoot);
                assertEq(batchRoot, TreeOracle.fullRoot(_prefix(all, next)));
                for (uint256 level = 0; level < 20; level++) {
                    assertEq(batched[level], single[level]);
                }
            }
        }
    }

    function test_refusesToOverflowOrInsertNothing() public {
        uint256[20] memory frontier;
        uint256[] memory one = new uint256[](1);
        one[0] = 7;
        hasher.insertLeaves(frontier, uint64((1 << 20) - 1), one);
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(frontier, uint64(1 << 20), one);
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(frontier, uint64((1 << 20) - 1), new uint256[](2));
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(frontier, 0, new uint256[](0));
    }

    function _leaf(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("calyptra.leaf", i))) % R;
    }

    function _prefix(uint256[] memory values, uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = values[i];
        }
    }
}
