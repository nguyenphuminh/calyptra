// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DisputesBase} from "../src/Disputes.sol";
import {Hasher} from "../src/Hasher.sol";
import {Pool} from "../src/Pool.sol";
import {
    AlreadyInitialized,
    ChannelAlreadyFinalized,
    ChannelNotFinalized,
    DeadlineNotReached,
    DuplicateNullifier,
    IVerifier,
    InvalidAmount,
    InvalidCiphertext,
    InvalidExtData,
    InvalidField,
    InvalidProof,
    InvalidRecipient,
    InvalidValue,
    InvalidWindow,
    NoPendingDispute,
    NotInitialized,
    NullifierAlreadySpent,
    SettlementFailed,
    StaleState,
    StateMismatch,
    TokenNotAllowed,
    TransferFailed,
    TreeFull,
    Unauthorized,
    UnknownRoot
} from "../src/Shared.sol";

/// Pins the selectors, event topics and error selectors of the off-chain ABI.
contract AbiTest is Test {
    function test_poolSelectorsAndTopics() public pure {
        assertEq(Pool.initialize.selector, bytes4(0xf8c8765e));
        assertEq(Pool.deposit.selector, bytes4(0x9e48ff5a));
        assertEq(Pool.transact.selector, bytes4(0x9ae489d7));
        assertEq(Pool.settle.selector, bytes4(0x8d65fc8d));
        assertEq(Pool.root.selector, bytes4(0xebf0c717));
        assertEq(Pool.isKnownRoot.selector, bytes4(0xa6232a93));
        assertEq(Pool.isSpent.selector, bytes4(0x5a129efe));
        assertEq(Pool.NewCommitment.selector, 0xe5b9fcee308349a880a3033e7bf8f0d7192658e7dbdaf7481ecc63f3d7addf03);
        assertEq(Pool.NewNullifier.selector, 0x9218fa47e982bf1ded9b6823b77dbac4a5db62fc73f8efc325c7de424a411802);
    }

    function test_disputesSelectorsAndTopics() public pure {
        assertEq(DisputesBase.initialize.selector, bytes4(0x485cc955));
        assertEq(DisputesBase.submitState.selector, bytes4(0x85a6316c));
        assertEq(DisputesBase.finalize.selector, bytes4(0xeb80232f));
        assertEq(DisputesBase.reclaim.selector, bytes4(0x98eafdf5));
        assertEq(DisputesBase.disputeOf.selector, bytes4(0xb1eb0fb7));
        assertEq(DisputesBase.isFinalized.selector, bytes4(0x33727c4d));
        assertEq(DisputesBase.windowBounds.selector, bytes4(0x139695f3));
        assertEq(
            DisputesBase.DisputeSubmitted.selector, 0x5dc2c1f555939ac05c3ec8fcdc29a28e55a136f6ce31688d96dd1719cdf57aaf
        );
        assertEq(
            DisputesBase.ChannelFinalized.selector, 0x2bfa49d4d8f77aba74228999baddcb8c8c9401fb74785b3cba98855a4fb35257
        );
    }

    function test_internalSelectors() public pure {
        assertEq(IVerifier.verify.selector, bytes4(0x4b09bfed));
        assertEq(Hasher.hash2.selector, bytes4(0x511c53ff));
        assertEq(Hasher.insertLeaves.selector, bytes4(0x3086cdf2));
    }

    function test_errorSelectors() public pure {
        assertEq(NotInitialized.selector, bytes4(0x87138d5c));
        assertEq(AlreadyInitialized.selector, bytes4(0x0dc149f0));
        assertEq(Unauthorized.selector, bytes4(0x82b42900));
        assertEq(UnknownRoot.selector, bytes4(0x8c520116));
        assertEq(NullifierAlreadySpent.selector, bytes4(0xb115d857));
        assertEq(DuplicateNullifier.selector, bytes4(0xe1200f1d));
        assertEq(InvalidProof.selector, bytes4(0x09bde339));
        assertEq(InvalidAmount.selector, bytes4(0x2c5211c6));
        assertEq(InvalidField.selector, bytes4(0x7fa0b337));
        assertEq(TokenNotAllowed.selector, bytes4(0xa29c4986));
        assertEq(InvalidValue.selector, bytes4(0xaa7feadc));
        assertEq(InvalidCiphertext.selector, bytes4(0x989a539a));
        assertEq(InvalidExtData.selector, bytes4(0x72560b3b));
        assertEq(InvalidRecipient.selector, bytes4(0x9c8d2cd2));
        assertEq(TreeFull.selector, bytes4(0xb48f2cf8));
        assertEq(TransferFailed.selector, bytes4(0x90b8ec18));
        assertEq(InvalidWindow.selector, bytes4(0x392334ed));
        assertEq(ChannelAlreadyFinalized.selector, bytes4(0x36692f88));
        assertEq(StaleState.selector, bytes4(0x3902a9c9));
        assertEq(NoPendingDispute.selector, bytes4(0xd0912510));
        assertEq(StateMismatch.selector, bytes4(0x4ecc13ec));
        assertEq(DeadlineNotReached.selector, bytes4(0x66ec4ee6));
        assertEq(ChannelNotFinalized.selector, bytes4(0x7109256c));
        assertEq(SettlementFailed.selector, bytes4(0xd9c80951));
    }
}
