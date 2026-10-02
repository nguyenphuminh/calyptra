// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// Shared helpers: loading the proof fixtures written by contracts/scripts/fixtures.ts (decimal strings,
/// `0x` bytes) and deploying the generated Groth16 verifier.
abstract contract CalyptraTest is Test {
    string internal constant POOL_FIXTURE = "../circuits/build/fixtures/pool.json";
    string internal constant DISPUTE_FIXTURE = "../circuits/build/fixtures/dispute.json";

    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct DepositFx {
        address token;
        uint256 amount;
        uint256 inner;
        uint256 commitment;
        bytes ciphertext;
    }

    struct TransactFx {
        uint256[8] proof;
        uint256[9] signals;
        address recipient;
        bytes ciphertexts;
    }

    struct SubmitFx {
        uint256[8] proof;
        uint256[5] signals;
    }

    struct FinalizeFx {
        uint256[8] proof;
        uint256[9] signals;
        bytes ciphertexts;
    }

    struct ReclaimFx {
        uint256[8] proof;
        uint256[8] signals;
        bytes ciphertexts;
    }

    function _fixture(string memory path) internal view returns (string memory) {
        if (!vm.exists(path)) revert(string.concat("missing ", path, " (run the setup)"));
        return vm.readFile(path);
    }

    /// Deploys the verifier generated from the circuits' verifying keys (src/generated/Verifier.sol).
    function _deployVerifier() internal returns (address verifier) {
        try vm.deployCode("Verifier.sol:Verifier") returns (address deployed) {
            verifier = deployed;
        } catch {
            revert("missing src/generated/Verifier.sol (run the setup)");
        }
    }

    function _deposits(string memory json) internal view returns (DepositFx[] memory deposits) {
        uint256 count = 0;
        while (vm.keyExistsJson(json, string.concat(".deposits[", vm.toString(count), "]"))) count++;
        deposits = new DepositFx[](count);
        for (uint256 i = 0; i < count; i++) {
            string memory key = string.concat(".deposits[", vm.toString(i), "]");
            deposits[i] = DepositFx({
                token: vm.parseJsonAddress(json, string.concat(key, ".token")),
                amount: vm.parseJsonUint(json, string.concat(key, ".amount")),
                inner: vm.parseJsonUint(json, string.concat(key, ".inner")),
                commitment: vm.parseJsonUint(json, string.concat(key, ".commitment")),
                ciphertext: vm.parseJsonBytes(json, string.concat(key, ".ciphertext"))
            });
        }
    }

    function _transact(string memory json, string memory key) internal pure returns (TransactFx memory fx) {
        fx.proof = _proof(json, key);
        uint256[] memory signals = _uints(json, string.concat(key, ".signals"), 9);
        for (uint256 i = 0; i < 9; i++) {
            fx.signals[i] = signals[i];
        }
        fx.recipient = vm.parseJsonAddress(json, string.concat(key, ".recipient"));
        fx.ciphertexts = vm.parseJsonBytes(json, string.concat(key, ".ciphertexts"));
    }

    function _submit(string memory json, string memory key) internal pure returns (SubmitFx memory fx) {
        fx.proof = _proof(json, key);
        uint256[] memory signals = _uints(json, string.concat(key, ".signals"), 5);
        for (uint256 i = 0; i < 5; i++) {
            fx.signals[i] = signals[i];
        }
    }

    function _finalize(string memory json, string memory key) internal pure returns (FinalizeFx memory fx) {
        fx.proof = _proof(json, key);
        uint256[] memory signals = _uints(json, string.concat(key, ".signals"), 9);
        for (uint256 i = 0; i < 9; i++) {
            fx.signals[i] = signals[i];
        }
        fx.ciphertexts = vm.parseJsonBytes(json, string.concat(key, ".ciphertexts"));
    }

    function _reclaim(string memory json, string memory key) internal pure returns (ReclaimFx memory fx) {
        fx.proof = _proof(json, key);
        uint256[] memory signals = _uints(json, string.concat(key, ".signals"), 8);
        for (uint256 i = 0; i < 8; i++) {
            fx.signals[i] = signals[i];
        }
        fx.ciphertexts = vm.parseJsonBytes(json, string.concat(key, ".ciphertexts"));
    }

    function _proof(string memory json, string memory key) internal pure returns (uint256[8] memory proof) {
        uint256[] memory words = _uints(json, string.concat(key, ".proof"), 8);
        for (uint256 i = 0; i < 8; i++) {
            proof[i] = words[i];
        }
    }

    function _uints(string memory json, string memory key, uint256 length) internal pure returns (uint256[] memory v) {
        v = vm.parseJsonUintArray(json, key);
        require(v.length == length, string.concat(key, ": unexpected length"));
    }

    /// Copies (memory arrays assign by reference, so tampering needs a copy).
    function _copy(uint256[9] memory s) internal pure returns (uint256[9] memory out) {
        for (uint256 i = 0; i < 9; i++) {
            out[i] = s[i];
        }
    }

    function _copy(uint256[8] memory s) internal pure returns (uint256[8] memory out) {
        for (uint256 i = 0; i < 8; i++) {
            out[i] = s[i];
        }
    }

    function _copy(uint256[5] memory s) internal pure returns (uint256[5] memory out) {
        for (uint256 i = 0; i < 5; i++) {
            out[i] = s[i];
        }
    }

    /// The signals as the dynamic array `Verifier.verify` takes.
    function _dyn(uint256[9] memory s) internal pure returns (uint256[] memory out) {
        out = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) {
            out[i] = s[i];
        }
    }

    function _dyn(uint256[8] memory s) internal pure returns (uint256[] memory out) {
        out = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) {
            out[i] = s[i];
        }
    }

    function _dyn(uint256[5] memory s) internal pure returns (uint256[] memory out) {
        out = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            out[i] = s[i];
        }
    }

    /// `n` 168-byte ciphertexts filled with the tag bytes `base`, `base + 1`, ... back to back.
    function _ciphertexts(uint8 base, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(168 * n);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = bytes1(uint8(base + i / 168));
        }
    }
}
