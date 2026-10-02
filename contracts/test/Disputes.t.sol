// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Disputes, DisputesBase, DisputesShortWindow} from "../src/Disputes.sol";
import {
    AlreadyInitialized,
    ChannelAlreadyFinalized,
    ChannelNotFinalized,
    DeadlineNotReached,
    InvalidExtData,
    InvalidProof,
    InvalidWindow,
    NoPendingDispute,
    NotInitialized,
    SettlementFailed,
    StaleState,
    StateMismatch,
    UnknownRoot
} from "../src/Shared.sol";
import {CalyptraTest} from "./utils/CalyptraTest.sol";
import {MockPool} from "./utils/Mocks.sol";

/// all-ref §4.10.2 (fixture dispute.json; pool 0x0a0a…0a mocked, verifier 0x0101…01, T0 = 1_800_000_000).
contract DisputesTest is CalyptraTest {
    address internal constant POOL = 0x0A0A0a0a0a0a0a0A0a0a0A0a0A0A0A0a0a0a0a0a;
    address internal constant VERIFIER = 0x0101010101010101010101010101010101010101;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant DAY = 86400;

    Disputes internal disputes;
    MockPool internal pool = MockPool(POOL);

    function setUp() public {
        vm.etch(POOL, address(new MockPool()).code);
        pool.setKnownRoot(true);
        disputes = new Disputes();
        disputes.initialize(POOL, VERIFIER);
        vm.warp(T0);
    }

    function _load() internal returns (string memory json) {
        json = _fixture(DISPUTE_FIXTURE);
        vm.etch(VERIFIER, _deployVerifier().code);
    }

    // 1. old state is answered by the latest and finalizes after the fixed deadline
    function test_oldStateIsAnsweredByTheLatestAndFinalizesAfterTheFixedDeadline() public {
        string memory json = _load();
        SubmitFx memory old = _submit(json, ".submitOld");
        SubmitFx memory latest = _submit(json, ".submitLatest");
        FinalizeFx memory fin = _finalize(json, ".finalize");
        uint256 channel = old.signals[1];

        vm.expectEmit(address(disputes));
        emit DisputesBase.DisputeSubmitted(channel, 100, old.signals[3], T0 + 3 * DAY);
        disputes.submitState(old.proof, old.signals);
        (bool pending, uint256 nonce, uint256 stateHash, uint256 deadline) = disputes.disputeOf(channel);
        assertTrue(pending);
        assertEq(nonce, 100);
        assertEq(stateHash, old.signals[3]);
        assertEq(deadline, T0 + 3 * DAY);

        vm.expectRevert(StaleState.selector);
        disputes.submitState(old.proof, old.signals);

        vm.warp(T0 + DAY);
        vm.expectEmit(address(disputes));
        emit DisputesBase.DisputeSubmitted(channel, 200, latest.signals[3], T0 + 3 * DAY);
        disputes.submitState(latest.proof, latest.signals);
        (pending, nonce, stateHash, deadline) = disputes.disputeOf(channel);
        assertTrue(pending);
        assertEq(nonce, 200);
        assertEq(stateHash, latest.signals[3]);
        assertEq(deadline, T0 + 3 * DAY);
        vm.expectRevert(StaleState.selector);
        disputes.submitState(old.proof, old.signals);

        vm.warp(T0 + 3 * DAY - 1);
        vm.expectRevert(DeadlineNotReached.selector);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);

        vm.warp(T0 + 3 * DAY);
        vm.expectEmit(address(disputes));
        emit DisputesBase.ChannelFinalized(channel);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        assertTrue(disputes.isFinalized(channel));
        (pending, nonce, stateHash, deadline) = disputes.disputeOf(channel);
        assertFalse(pending);
        assertEq(nonce, 200);
        assertEq(deadline, T0 + 3 * DAY);
        assertEq(pool.settleCalls(), 1);

        vm.expectRevert(ChannelAlreadyFinalized.selector);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        vm.expectRevert(ChannelAlreadyFinalized.selector);
        disputes.submitState(latest.proof, latest.signals);
    }

    // 2. finalize settles only the pending state
    function test_finalizeSettlesOnlyThePendingState() public {
        string memory json = _load();
        SubmitFx memory old = _submit(json, ".submitOld");
        FinalizeFx memory fin = _finalize(json, ".finalize");

        vm.expectRevert(NoPendingDispute.selector);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);

        disputes.submitState(old.proof, old.signals);
        vm.warp(T0 + 3 * DAY);
        vm.expectRevert(StateMismatch.selector);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
    }

    // 3. finalize rejects tampered ciphertexts and proofs
    function test_finalizeRejectsTamperedCiphertextsAndProofs() public {
        string memory json = _load();
        SubmitFx memory latest = _submit(json, ".submitLatest");
        FinalizeFx memory fin = _finalize(json, ".finalize");
        disputes.submitState(latest.proof, latest.signals);
        vm.warp(T0 + 3 * DAY);

        bytes memory flipped = bytes.concat(fin.ciphertexts);
        flipped[400] = bytes1(uint8(flipped[400]) ^ 1);
        vm.expectRevert(InvalidExtData.selector);
        disputes.finalize(fin.proof, fin.signals, flipped);

        uint256[8] memory p = _copy(fin.proof);
        p[7] += 1;
        vm.expectRevert(InvalidProof.selector);
        disputes.finalize(p, fin.signals, fin.ciphertexts);

        uint256[9] memory s = _copy(fin.signals);
        s[4] += 1; // payout notes are bound
        vm.expectRevert(InvalidProof.selector);
        disputes.finalize(fin.proof, s, fin.ciphertexts);

        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        assertTrue(disputes.isFinalized(fin.signals[7]));
    }

    // 4. submissions need a known root, a valid window and a valid proof
    function test_submissionsNeedAKnownRootAValidWindowAndAValidProof() public {
        string memory json = _load();
        SubmitFx memory old = _submit(json, ".submitOld");
        assertEq(old.signals[4], vm.parseJsonUint(json, ".window"));

        pool.setKnownRoot(false);
        vm.expectRevert(UnknownRoot.selector);
        disputes.submitState(old.proof, old.signals);
        pool.setKnownRoot(true);

        uint256[5] memory s = _copy(old.signals);
        s[4] = 3 * DAY - 1;
        vm.expectRevert(InvalidWindow.selector);
        disputes.submitState(old.proof, s);
        s[4] = 7 * DAY + 1;
        vm.expectRevert(InvalidWindow.selector);
        disputes.submitState(old.proof, s);

        s = _copy(old.signals);
        s[2] += 1;
        vm.expectRevert(InvalidProof.selector);
        disputes.submitState(old.proof, s);

        (bool pending,,,) = disputes.disputeOf(old.signals[1]);
        assertFalse(pending);
    }

    // 5. a contribution left out of the final state is reclaimed after finalization
    function test_aContributionLeftOutOfTheFinalStateIsReclaimedAfterFinalization() public {
        string memory json = _load();
        SubmitFx memory state0 = _submit(json, ".submitState0");
        FinalizeFx memory fin0 = _finalize(json, ".finalizeState0");
        ReclaimFx memory rec = _reclaim(json, ".reclaim");
        assertEq(rec.signals[7], state0.signals[1]);

        vm.expectRevert(ChannelNotFinalized.selector);
        disputes.reclaim(rec.proof, rec.signals, rec.ciphertexts);

        disputes.submitState(state0.proof, state0.signals);
        vm.expectRevert(ChannelNotFinalized.selector);
        disputes.reclaim(rec.proof, rec.signals, rec.ciphertexts);

        vm.warp(T0 + 3 * DAY);
        disputes.finalize(fin0.proof, fin0.signals, fin0.ciphertexts);
        assertTrue(disputes.isFinalized(state0.signals[1]));

        disputes.reclaim(rec.proof, rec.signals, rec.ciphertexts);
        assertEq(pool.settleCalls(), 2);

        bytes memory flipped = bytes.concat(rec.ciphertexts);
        flipped[0] = bytes1(uint8(flipped[0]) ^ 1);
        vm.expectRevert(InvalidExtData.selector);
        disputes.reclaim(rec.proof, rec.signals, flipped);
        uint256[8] memory p = _copy(rec.proof);
        p[0] += 1;
        vm.expectRevert(InvalidProof.selector);
        disputes.reclaim(p, rec.signals, rec.ciphertexts);
    }

    // 6. reports when the pool refuses the settlement
    function test_reportsWhenThePoolRefusesTheSettlement() public {
        string memory json = _load();
        SubmitFx memory latest = _submit(json, ".submitLatest");
        FinalizeFx memory fin = _finalize(json, ".finalize");
        disputes.submitState(latest.proof, latest.signals);
        vm.warp(T0 + 3 * DAY);
        pool.setSettleReverts(true);
        vm.expectRevert(SettlementFailed.selector);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        // The whole transaction reverted: still pending, not finalized.
        (bool pending,,,) = disputes.disputeOf(fin.signals[7]);
        assertTrue(pending);
        assertFalse(disputes.isFinalized(fin.signals[7]));
    }

    // 7. window bounds are three to seven days
    function test_windowBoundsAreThreeToSevenDays() public {
        (uint64 min, uint64 max) = disputes.windowBounds();
        assertEq(min, 259200);
        assertEq(max, 604800);
        (min, max) = new DisputesShortWindow().windowBounds();
        assertEq(min, 10);
        assertEq(max, 604800);
    }

    function test_initializesOnceAndRefusesUseBefore() public {
        Disputes fresh = new Disputes();
        uint256[8] memory proof;
        vm.expectRevert(NotInitialized.selector);
        fresh.submitState(proof, [uint256(0), 0, 0, 0, 0]);
        uint256[9] memory nine;
        vm.expectRevert(NotInitialized.selector);
        fresh.finalize(proof, nine, new bytes(504));
        uint256[8] memory eight;
        vm.expectRevert(NotInitialized.selector);
        fresh.reclaim(proof, eight, new bytes(504));
        fresh.initialize(POOL, VERIFIER);
        vm.expectRevert(AlreadyInitialized.selector);
        fresh.initialize(POOL, VERIFIER);
        (bool pending, uint256 nonce, uint256 stateHash, uint256 deadline) = fresh.disputeOf(123);
        assertFalse(pending);
        assertEq(nonce + stateHash + deadline, 0);
        assertFalse(fresh.isFinalized(123));
    }
}
