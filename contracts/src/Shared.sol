// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Constants, errors, interfaces and encodings shared by Pool, Disputes and Hasher (all-ref §4.2, §4.3).

// Order of the BN254 scalar field: every public signal, leaf, nullifier and `inner` is below it.
uint256 constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
// Order of the BN254 base field: every Groth16 proof coordinate is below it.
uint256 constant BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
// Depth of the commitment tree (2^20 = 1,048,576 leaves). An empty leaf is 0.
uint256 constant TREE_DEPTH = 20;
uint256 constant TREE_CAPACITY = 1 << 20;
// Number of recent roots a proof may reference.
uint256 constant ROOT_HISTORY = 100;
// Size of every note ciphertext; a transfer carries three of them back to back (504 bytes).
uint256 constant CIPHERTEXT_SIZE = 168;
// Amounts are 64-bit inside the circuits.
uint256 constant MAX_AMOUNT = type(uint64).max;
// Root of the empty tree, ZEROS[20].
uint256 constant EMPTY_ROOT = 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e;

// Circuit ids taken by `Verifier.verify`.
uint8 constant TRANSFER = 0;
uint8 constant FINALIZE = 1;
uint8 constant RECLAIM = 2;
uint8 constant SUBMIT_STATE = 3;

error NotInitialized();
error AlreadyInitialized();
error Unauthorized();
error UnknownRoot();
error NullifierAlreadySpent();
error DuplicateNullifier();
error InvalidProof();
error InvalidAmount();
error InvalidField();
error TokenNotAllowed();
error InvalidValue();
error InvalidCiphertext();
error InvalidExtData();
error InvalidRecipient();
error TreeFull();
error TransferFailed();
error InvalidWindow();
error ChannelAlreadyFinalized();
error StaleState();
error NoPendingDispute();
error StateMismatch();
error DeadlineNotReached();
error ChannelNotFinalized();
error SettlementFailed();

/// Groth16 verifier for the four circuits (generated into src/generated/Verifier.sol). Never reverts on bad input.
interface IVerifier {
    function verify(uint8 circuit, uint256[8] calldata proof, uint256[] calldata signals) external view returns (bool);
}

/// circomlib Poseidon(2) and the batched append-only Merkle insertion.
interface IHasher {
    function hash2(uint256 a, uint256 b) external view returns (uint256);

    function insertLeaves(uint256[20] calldata filled, uint64 nextIndex, uint256[] calldata leaves)
        external
        view
        returns (uint256[20] memory, uint256);
}

/// The two Pool functions the Disputes contract calls.
interface IPool {
    function isKnownRoot(uint256 root) external view returns (bool);

    function settle(uint256 root, uint256 nf0, uint256 nf1, uint256[3] calldata outputs, bytes calldata ciphertexts)
        external;
}

/// Encodings the contracts share with the off-chain protocol (all-ref §3.2, §3.6, §3.10, §4.2).
library Shared {
    /// `x mod r` for any 256-bit value.
    function reduce(uint256 x) internal pure returns (uint256) {
        return x % SNARK_SCALAR_FIELD;
    }

    /// Binds the recipient and the three output ciphertexts to a proof. Returns (false, 0) when the
    /// ciphertext blob is not exactly 3 * 168 bytes.
    function extDataHash(address recipient, bytes calldata cts) internal pure returns (bool ok, uint256 h) {
        if (cts.length != 3 * CIPHERTEXT_SIZE) return (false, 0);
        bytes32 d = keccak256(
            abi.encode(
                recipient, // 32-byte word, address right-aligned
                keccak256(cts[0:168]), // output 0 ciphertext
                keccak256(cts[168:336]), // output 1 ciphertext
                keccak256(cts[336:504]) // output 2 ciphertext
            )
        );
        return (true, reduce(uint256(d)));
    }

    /// token * 2^64 + amount (amount < 2^64, so OR equals +); always < 2^224 < r.
    function packAmountToken(address token, uint256 amount) internal pure returns (uint256) {
        return (uint256(uint160(token)) << 64) | amount;
    }

    /// ZEROS[i] = root of an empty subtree of height i: ZEROS[0] = 0, ZEROS[i + 1] = Poseidon(ZEROS[i], ZEROS[i]).
    function zeros() internal pure returns (uint256[21] memory z) {
        z = [
            uint256(0),
            0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864,
            0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1,
            0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238,
            0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a,
            0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55,
            0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78,
            0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d,
            0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61,
            0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747,
            0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2,
            0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636,
            0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a,
            0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0,
            0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c,
            0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92,
            0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323,
            0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992,
            0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f,
            0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca,
            EMPTY_ROOT
        ];
    }
}
