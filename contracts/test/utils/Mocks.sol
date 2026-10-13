// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Verifier stand-in that answers every call with a fixed result.
contract MockVerifier {
    bool internal result = true;

    function setResult(bool result_) external {
        result = result_;
    }

    function verify(uint8, uint256[8] calldata, uint256[] calldata) external view returns (bool) {
        return result;
    }
}

/// Pool stand-in for the Disputes tests: `isKnownRoot` answers the value set before
/// each submission; `settle` succeeds unless told to revert.
contract MockPool {
    bool internal known = true;
    bool internal settleReverts;
    uint256 public settleCalls;

    function setKnownRoot(bool known_) external {
        known = known_;
    }

    function setSettleReverts(bool reverts) external {
        settleReverts = reverts;
    }

    function isKnownRoot(uint256) external view returns (bool) {
        return known;
    }

    function settle(uint256, uint256, uint256, uint256[3] calldata, bytes calldata) external {
        require(!settleReverts, "settle refused");
        settleCalls++;
    }
}
