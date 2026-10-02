// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AlreadyInitialized,
    ChannelAlreadyFinalized,
    ChannelNotFinalized,
    DeadlineNotReached,
    FINALIZE,
    IPool,
    IVerifier,
    InvalidExtData,
    InvalidProof,
    InvalidWindow,
    NoPendingDispute,
    NotInitialized,
    RECLAIM,
    SUBMIT_STATE,
    SettlementFailed,
    Shared,
    StaleState,
    StateMismatch,
    UnknownRoot
} from "./Shared.sol";

/// Payment-channel disputes (all-ref §4.5): submit or answer a state signed by both parties, finalize
/// the pending state after the dispute window, reclaim contributions the final state left out. Holds
/// no funds; moves notes only through `Pool.settle`. The minimum dispute window is fixed per build:
/// `Disputes` (3 days, production) and `DisputesShortWindow` (10 seconds, local end-to-end tests).
abstract contract DisputesBase {
    struct Dispute {
        bool pending; // a state is pending
        uint64 deadline; // unix seconds, fixed by the first submission
        uint256 nonce; // nonce of the pending state
        uint256 stateHash; // hash of the pending state
    }

    uint64 internal constant MAX_WINDOW = 7 days;

    event DisputeSubmitted(uint256 indexed channelNullifier, uint256 nonce, uint256 stateHash, uint256 deadline);
    event ChannelFinalized(uint256 indexed channelNullifier);

    bool internal initialized;
    address internal _pool;
    address internal _verifier;
    mapping(uint256 channelNullifier => Dispute) internal disputes;
    mapping(uint256 channelNullifier => bool) internal finalized;

    function _minWindow() internal pure virtual returns (uint64);

    /// One-shot, permissionless wiring (the deploy script calls it right after deployment).
    // forge-lint: disable-next-line(missing-zero-check)
    function initialize(address pool, address verifier) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        _pool = pool;
        _verifier = verifier;
    }

    /// Starts a dispute, or answers the pending one with a higher nonce (the deadline never moves).
    /// signals = [root, channelNullifier, nonce, stateHash, window].
    function submitState(uint256[8] calldata proof, uint256[5] calldata signals) external {
        if (!initialized) revert NotInitialized();
        uint256 channelNullifier = signals[1];
        if (finalized[channelNullifier]) revert ChannelAlreadyFinalized();
        uint256 window = signals[4];
        if (window < _minWindow() || window > MAX_WINDOW) revert InvalidWindow();
        Dispute storage d = disputes[channelNullifier];
        bool pending = d.pending;
        if (pending && signals[2] <= d.nonce) revert StaleState();
        if (!_isKnownRoot(signals[0])) revert UnknownRoot();
        uint256[] memory publicSignals = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            publicSignals[i] = signals[i];
        }
        if (!_verify(SUBMIT_STATE, proof, publicSignals)) revert InvalidProof();
        if (!pending) {
            d.pending = true;
            // casting to 'uint64' is safe because window <= 7 days
            // forge-lint: disable-next-line(unsafe-typecast)
            d.deadline = uint64(block.timestamp + window);
        }
        d.nonce = signals[2];
        d.stateHash = signals[3];
        emit DisputeSubmitted(channelNullifier, signals[2], signals[3], d.deadline);
    }

    /// Settles the pending state after its deadline: spends the listed contributions and creates the
    /// payout and fee notes through `Pool.settle`.
    /// signals = [root, extDataHash, nf0, nf1, out0, out1, out2, channelNullifier, stateHash].
    function finalize(uint256[8] calldata proof, uint256[9] calldata signals, bytes calldata ciphertexts) external {
        if (!initialized) revert NotInitialized();
        uint256 channelNullifier = signals[7];
        if (finalized[channelNullifier]) revert ChannelAlreadyFinalized();
        Dispute storage d = disputes[channelNullifier];
        if (!d.pending) revert NoPendingDispute();
        if (d.stateHash != signals[8]) revert StateMismatch();
        // Deadlines are days apart in production; 1-second timestamp granularity does not matter.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < d.deadline) revert DeadlineNotReached();
        (bool ok, uint256 extHash) = Shared.extDataHash(address(0), ciphertexts);
        if (!ok || extHash != signals[1]) revert InvalidExtData();
        uint256[] memory publicSignals = new uint256[](9);
        for (uint256 i = 0; i < 9; i++) {
            publicSignals[i] = signals[i];
        }
        if (!_verify(FINALIZE, proof, publicSignals)) revert InvalidProof();
        d.pending = false;
        finalized[channelNullifier] = true;
        _settle(signals[0], signals[2], signals[3], [signals[4], signals[5], signals[6]], ciphertexts);
        // Event order of all-ref §4.4.7: the Pool's logs, then ChannelFinalized. The only external call
        // is to the configured Pool, and the state changes above already happened.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ChannelFinalized(channelNullifier);
    }

    /// Returns a contribution the finalized state did not list to its contributor.
    /// signals = [root, extDataHash, nf0, nf1, out0, out1, out2, channelNullifier].
    function reclaim(uint256[8] calldata proof, uint256[8] calldata signals, bytes calldata ciphertexts) external {
        if (!initialized) revert NotInitialized();
        if (!finalized[signals[7]]) revert ChannelNotFinalized();
        (bool ok, uint256 extHash) = Shared.extDataHash(address(0), ciphertexts);
        if (!ok || extHash != signals[1]) revert InvalidExtData();
        uint256[] memory publicSignals = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) {
            publicSignals[i] = signals[i];
        }
        if (!_verify(RECLAIM, proof, publicSignals)) revert InvalidProof();
        _settle(signals[0], signals[2], signals[3], [signals[4], signals[5], signals[6]], ciphertexts);
    }

    function disputeOf(uint256 channelNullifier)
        external
        view
        returns (bool pending, uint256 nonce, uint256 stateHash, uint256 deadline)
    {
        Dispute storage d = disputes[channelNullifier];
        return (d.pending, d.nonce, d.stateHash, d.deadline);
    }

    function isFinalized(uint256 channelNullifier) external view returns (bool) {
        return finalized[channelNullifier];
    }

    /// The dispute-window bounds of this build, in seconds.
    function windowBounds() external pure returns (uint64 min, uint64 max) {
        return (_minWindow(), MAX_WINDOW);
    }

    /// Revert, short return data or `false` all mean "unknown".
    function _isKnownRoot(uint256 root) internal view returns (bool) {
        (bool ok, bytes memory ret) = _pool.staticcall(abi.encodeWithSelector(IPool.isKnownRoot.selector, root));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    /// Every outcome other than a non-zero first word (false, revert, short return data) is a failure.
    function _verify(uint8 circuit, uint256[8] calldata proof, uint256[] memory publicSignals)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) =
            _verifier.staticcall(abi.encodeWithSelector(IVerifier.verify.selector, circuit, proof, publicSignals));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    /// Any failure of the pool (unknown root, spent nullifier, bad ciphertexts, ...) is reported as
    /// `SettlementFailed`; the pool's own error is not propagated.
    function _settle(uint256 root, uint256 nf0, uint256 nf1, uint256[3] memory outputs, bytes calldata ciphertexts)
        internal
    {
        (bool ok,) = _pool.call(abi.encodeWithSelector(IPool.settle.selector, root, nf0, nf1, outputs, ciphertexts));
        if (!ok) revert SettlementFailed();
    }
}

/// Production build: dispute windows of 3 to 7 days.
contract Disputes is DisputesBase {
    function _minWindow() internal pure override returns (uint64) {
        return 3 days;
    }
}

/// Test build for local end-to-end runs on a chain that waits in real time: windows of 10 seconds to 7 days.
contract DisputesShortWindow is DisputesBase {
    function _minWindow() internal pure override returns (uint64) {
        return 10;
    }
}
