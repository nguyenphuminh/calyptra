// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AlreadyInitialized,
    CIPHERTEXT_SIZE,
    DuplicateNullifier,
    EMPTY_ROOT,
    IHasher,
    IVerifier,
    InvalidAmount,
    InvalidCiphertext,
    InvalidExtData,
    InvalidField,
    InvalidProof,
    InvalidRecipient,
    InvalidValue,
    MAX_AMOUNT,
    NotInitialized,
    NullifierAlreadySpent,
    ROOT_HISTORY,
    SNARK_SCALAR_FIELD,
    Shared,
    TRANSFER,
    TokenNotAllowed,
    TransferFailed,
    TreeFull,
    Unauthorized,
    UnknownRoot
} from "./Shared.sol";

/// Shielded pool (all-ref §4.4): one combined balance per token (the native coin and the stablecoin),
/// the note-commitment Merkle tree (depth 20), the last 100 roots and the spent-nullifier set.
/// No owner, no pause, no upgrade path, no admin withdrawal.
contract Pool {
    event NewCommitment(uint256 indexed commitment, uint256 leafIndex, bytes ciphertext);
    event NewNullifier(uint256 indexed nullifier);

    // Storage layout of all-ref §4.4.1/§11.2: fixed arrays for the frontier and the root ring share
    // storage pages on Monad (MIP-8); nullifiers stay in a mapping. All storage is internal so the
    // ABI is exactly the one of all-ref §4.3.
    bool internal initialized;
    address internal _stablecoin; // the only ERC-20 accepted; 0 = no stablecoin on this network
    address internal _verifier;
    address internal _hasher;
    address internal _disputes; // the only caller of `settle`
    uint32 internal leafCount; // index of the next free leaf
    uint8 internal currentRootSlot; // ring slot of the current root (0..99)
    uint256[20] internal filledSubtrees; // latest LEFT child at each level (the tree frontier)
    uint256[100] internal roots; // ring buffer of the last 100 roots
    mapping(uint256 => uint256) internal rootSlotPlusOne; // slot + 1 of a known root; 0 = unknown
    mapping(uint256 => bool) internal nullifiers;

    /// One-shot, permissionless wiring (the deploy script calls it right after deployment).
    /// No zero-address or code checks (all-ref §4.4.2): a zero stablecoin means "no stablecoin here".
    // forge-lint: disable-next-line(missing-zero-check)
    function initialize(address stablecoin, address verifier, address hasher, address disputes) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        _stablecoin = stablecoin;
        _verifier = verifier;
        _hasher = hasher;
        _disputes = disputes;
        roots[0] = EMPTY_ROOT;
        rootSlotPlusOne[EMPTY_ROOT] = 1;
    }

    /// Shields `amount` of `token` (0 = the native coin). The commitment is computed here from what
    /// actually arrived, so a depositor can never claim more than it paid.
    function deposit(address token, uint256 amount, uint256 inner, bytes calldata ciphertext) external payable {
        if (!initialized) revert NotInitialized();
        if (ciphertext.length != CIPHERTEXT_SIZE) revert InvalidCiphertext();
        if (inner >= SNARK_SCALAR_FIELD) revert InvalidField();
        uint256 received;
        if (token == address(0)) {
            if (msg.value != amount) revert InvalidValue();
            received = amount;
        } else {
            if (token != _stablecoin) revert TokenNotAllowed();
            if (msg.value != 0) revert InvalidValue();
            uint256 balanceBefore = _balanceOf(token);
            _tokenCall(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
            uint256 balanceAfter = _balanceOf(token);
            received = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        }
        if (received == 0 || received > MAX_AMOUNT) revert InvalidAmount();
        uint256 commitment = _hash2(Shared.packAmountToken(token, received), inner);
        uint256[] memory leaves = new uint256[](1);
        leaves[0] = commitment;
        (uint256 index, uint256 newRoot) = _insert(leaves);
        _pushRoot(newRoot);
        // Event order of all-ref §4.4.3; the only external calls before it go to the configured
        // stablecoin (no hooks) and the stateless Hasher.
        // forge-lint: disable-next-line(reentrancy-events)
        emit NewCommitment(commitment, index, ciphertext);
    }

    /// Private transfer, withdrawal, channel funding and cooperative close (one transfer circuit).
    /// signals = [root, publicAmount, publicToken, extDataHash, nf0, nf1, out0, out1, out2].
    function transact(
        uint256[8] calldata proof,
        uint256[9] calldata signals,
        address recipient,
        bytes calldata ciphertexts
    ) external {
        if (!initialized) revert NotInitialized();
        _checkSpend(signals[0], signals[4], signals[5]);
        (bool ok, uint256 extHash) = Shared.extDataHash(recipient, ciphertexts);
        if (!ok || extHash != signals[3]) revert InvalidExtData();
        uint256 publicAmount = signals[1];
        if (publicAmount > MAX_AMOUNT) revert InvalidAmount();
        address payToken = address(0);
        if (publicAmount != 0) {
            if (recipient == address(0)) revert InvalidRecipient();
            payToken = _allowedToken(signals[2]);
        }
        uint256[] memory publicSignals = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) {
            publicSignals[i] = signals[i];
        }
        if (!_verify(proof, publicSignals)) revert InvalidProof();
        _apply(signals[4], signals[5], [signals[6], signals[7], signals[8]], ciphertexts);
        if (publicAmount != 0) _pay(payToken, recipient, publicAmount);
    }

    /// Spends a finalized or reclaimed channel's two inputs and creates its three output notes.
    /// Only the Disputes contract may call it; it has already verified the proof and the ext-data binding.
    function settle(uint256 root_, uint256 nf0, uint256 nf1, uint256[3] calldata outputs, bytes calldata ciphertexts)
        external
    {
        if (!initialized) revert NotInitialized();
        if (msg.sender != _disputes) revert Unauthorized();
        _checkSpend(root_, nf0, nf1);
        if (
            ciphertexts.length != 3 * CIPHERTEXT_SIZE || outputs[0] >= SNARK_SCALAR_FIELD
                || outputs[1] >= SNARK_SCALAR_FIELD || outputs[2] >= SNARK_SCALAR_FIELD
        ) revert InvalidCiphertext();
        _apply(nf0, nf1, [outputs[0], outputs[1], outputs[2]], ciphertexts);
    }

    function root() external view returns (uint256) {
        return roots[currentRootSlot];
    }

    function isKnownRoot(uint256 root_) public view returns (bool) {
        return root_ != 0 && rootSlotPlusOne[root_] != 0;
    }

    function isSpent(uint256 nullifier) external view returns (bool) {
        return nullifiers[nullifier];
    }

    function _checkSpend(uint256 root_, uint256 nf0, uint256 nf1) internal view {
        if (!isKnownRoot(root_)) revert UnknownRoot();
        if (nf0 == nf1) revert DuplicateNullifier();
        if (nullifiers[nf0] || nullifiers[nf1]) revert NullifierAlreadySpent();
    }

    /// The token a withdrawal pays out: 0 = the native coin, otherwise only the configured stablecoin.
    function _allowedToken(uint256 publicToken) internal view returns (address) {
        if (publicToken == 0) return address(0);
        if (_stablecoin != address(0) && publicToken == uint256(uint160(_stablecoin))) return _stablecoin;
        revert TokenNotAllowed();
    }

    function _apply(uint256 nf0, uint256 nf1, uint256[3] memory outputs, bytes calldata ciphertexts) internal {
        nullifiers[nf0] = true;
        emit NewNullifier(nf0);
        nullifiers[nf1] = true;
        emit NewNullifier(nf1);
        uint256[] memory leaves = new uint256[](3);
        leaves[0] = outputs[0];
        leaves[1] = outputs[1];
        leaves[2] = outputs[2];
        (uint256 first, uint256 newRoot) = _insert(leaves);
        for (uint256 i = 0; i < 3; i++) {
            emit NewCommitment(outputs[i], first + i, ciphertexts[i * CIPHERTEXT_SIZE:(i + 1) * CIPHERTEXT_SIZE]);
        }
        _pushRoot(newRoot);
    }

    /// Appends `leaves` through the Hasher and writes back only the frontier entries that changed.
    function _insert(uint256[] memory leaves) internal returns (uint256 first, uint256 newRoot) {
        first = leafCount;
        uint256[20] memory frontier = filledSubtrees;
        // casting to 'uint64' is safe because leafCount <= 2^20
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory call = abi.encodeWithSelector(IHasher.insertLeaves.selector, frontier, uint64(first), leaves);
        (bool ok, bytes memory ret) = _hasher.staticcall(call);
        if (!ok || ret.length < 21 * 32) revert TreeFull();
        (uint256[20] memory updated, uint256 batchRoot) = abi.decode(ret, (uint256[20], uint256));
        for (uint256 level = 0; level < 20; level++) {
            if (updated[level] != frontier[level]) filledSubtrees[level] = updated[level];
        }
        // casting to 'uint32' is safe because the Hasher refuses to grow the tree beyond 2^20 leaves
        // forge-lint: disable-next-line(unsafe-typecast, missing-events-arithmetic)
        leafCount = uint32(first + leaves.length);
        newRoot = batchRoot;
    }

    function _pushRoot(uint256 newRoot) internal {
        uint256 slot = uint256(currentRootSlot) + 1;
        if (slot == ROOT_HISTORY) slot = 0;
        uint256 evicted = roots[slot];
        if (evicted != 0) rootSlotPlusOne[evicted] = 0; // forget the oldest root
        roots[slot] = newRoot;
        rootSlotPlusOne[newRoot] = slot + 1;
        // casting to 'uint8' is safe because slot < ROOT_HISTORY = 100
        // forge-lint: disable-next-line(unsafe-typecast, missing-events-arithmetic)
        currentRootSlot = uint8(slot);
    }

    function _hash2(uint256 a, uint256 b) internal view returns (uint256) {
        (bool ok, bytes memory ret) = _hasher.staticcall(abi.encodeWithSelector(IHasher.hash2.selector, a, b));
        if (!ok || ret.length < 32) revert InvalidField();
        return abi.decode(ret, (uint256));
    }

    /// Every outcome other than a non-zero first word (false, revert, short return data) is a failure.
    function _verify(uint256[8] calldata proof, uint256[] memory publicSignals) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            _verifier.staticcall(abi.encodeWithSelector(IVerifier.verify.selector, TRANSFER, proof, publicSignals));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            // The recipient and the amount are bound by the proof (signals + extDataHash).
            // forge-lint: disable-next-line(arbitrary-send-eth)
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _tokenCall(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        }
    }

    /// Accepts "no return data" (non-standard tokens) or a non-zero first word (decodes as true).
    function _tokenCall(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    function _balanceOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
