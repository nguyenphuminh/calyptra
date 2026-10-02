// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FINALIZE, IVerifier, RECLAIM, SUBMIT_STATE, TRANSFER} from "../src/Shared.sol";
import {CalyptraTest} from "./utils/CalyptraTest.sol";

/// all-ref §4.10.3, against the verifier generated from the circuits' verifying keys.
contract VerifierTest is CalyptraTest {
    IVerifier internal verifier;
    string internal poolJson;
    string internal disputeJson;

    function setUp() public {
        poolJson = _fixture(POOL_FIXTURE);
        disputeJson = _fixture(DISPUTE_FIXTURE);
        verifier = IVerifier(_deployVerifier());
    }

    // 1. accepts real proofs of every circuit (every circuit id 0..3 has a key)
    function test_acceptsRealProofsOfEveryCircuit() public view {
        TransactFx memory transfer = _transact(poolJson, ".transfer");
        TransactFx memory withdrawal = _transact(poolJson, ".withdrawal");
        SubmitFx memory latest = _submit(disputeJson, ".submitLatest");
        FinalizeFx memory fin = _finalize(disputeJson, ".finalize");
        ReclaimFx memory rec = _reclaim(disputeJson, ".reclaim");
        assertTrue(verifier.verify(TRANSFER, transfer.proof, _dyn(transfer.signals)));
        assertTrue(verifier.verify(TRANSFER, withdrawal.proof, _dyn(withdrawal.signals)));
        assertTrue(verifier.verify(SUBMIT_STATE, latest.proof, _dyn(latest.signals)));
        assertTrue(verifier.verify(FINALIZE, fin.proof, _dyn(fin.signals)));
        assertTrue(verifier.verify(RECLAIM, rec.proof, _dyn(rec.signals)));
        // No key for any other id.
        assertFalse(verifier.verify(4, fin.proof, _dyn(fin.signals)));
    }

    // 2. rejects tampered signals, wrong circuit and malformed input
    function test_rejectsTamperedSignalsWrongCircuitAndMalformedInput() public view {
        TransactFx memory t = _transact(poolJson, ".transfer");
        for (uint256 i = 0; i < 9; i++) {
            uint256[] memory s = _dyn(t.signals);
            s[i] += 1;
            assertFalse(verifier.verify(TRANSFER, t.proof, s));
        }
        assertFalse(verifier.verify(FINALIZE, t.proof, _dyn(t.signals)));
        assertFalse(verifier.verify(9, t.proof, _dyn(t.signals)));

        uint256[] memory eight = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) {
            eight[i] = t.signals[i];
        }
        assertFalse(verifier.verify(TRANSFER, t.proof, eight));

        uint256[8] memory p = _copy(t.proof);
        p[0] += 1;
        assertFalse(verifier.verify(TRANSFER, p, _dyn(t.signals)));

        uint256[] memory s0 = _dyn(t.signals);
        s0[0] = R;
        assertFalse(verifier.verify(TRANSFER, t.proof, s0));
    }
}
