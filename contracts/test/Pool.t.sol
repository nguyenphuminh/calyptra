// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Hasher} from "../src/Hasher.sol";
import {Pool} from "../src/Pool.sol";
import {
    AlreadyInitialized,
    DuplicateNullifier,
    EMPTY_ROOT,
    InvalidAmount,
    InvalidCiphertext,
    InvalidExtData,
    InvalidField,
    InvalidProof,
    InvalidValue,
    NotInitialized,
    NullifierAlreadySpent,
    TokenNotAllowed,
    TransferFailed,
    Unauthorized,
    UnknownRoot
} from "../src/Shared.sol";
import {TestStablecoin} from "../src/test/TestStablecoin.sol";
import {CalyptraTest} from "./utils/CalyptraTest.sol";

/// all-ref §4.10.1 (fixture pool.json; stablecoin 0x5555…55, verifier 0x0101…01, hasher 0x0202…02,
/// disputes 0x0303…03).
contract PoolTest is CalyptraTest {
    address internal constant STABLECOIN = 0x5555555555555555555555555555555555555555;
    address internal constant VERIFIER = 0x0101010101010101010101010101010101010101;
    address internal constant HASHER = 0x0202020202020202020202020202020202020202;
    address internal constant DISPUTES = 0x0303030303030303030303030303030303030303;
    uint256 internal constant MAX_AMOUNT = type(uint64).max;
    bytes32 internal constant NEW_COMMITMENT = keccak256("NewCommitment(uint256,uint256,bytes)");

    Pool internal pool;

    function setUp() public {
        vm.etch(HASHER, address(new Hasher()).code);
        pool = new Pool();
        pool.initialize(STABLECOIN, VERIFIER, HASHER, DISPUTES);
    }

    // 1. initializes once and refuses use before
    function test_initializesOnceAndRefusesUseBefore() public {
        Pool fresh = new Pool();
        uint256[8] memory proof;
        uint256[9] memory signals;
        vm.expectRevert(NotInitialized.selector);
        fresh.transact(proof, signals, address(0), new bytes(504));
        vm.expectRevert(NotInitialized.selector);
        fresh.deposit(address(0), 0, 1, new bytes(168));
        vm.expectRevert(NotInitialized.selector);
        vm.prank(DISPUTES);
        fresh.settle(EMPTY_ROOT, 1, 2, [uint256(1), 2, 3], new bytes(504));
        assertEq(fresh.root(), 0);

        fresh.initialize(STABLECOIN, VERIFIER, HASHER, DISPUTES);
        vm.expectRevert(AlreadyInitialized.selector);
        fresh.initialize(STABLECOIN, VERIFIER, HASHER, DISPUTES);
        assertEq(fresh.root(), EMPTY_ROOT);
        assertTrue(fresh.isKnownRoot(EMPTY_ROOT));
        assertFalse(fresh.isKnownRoot(0));
    }

    // 2. replays deposit, transfer and withdrawal with real proofs
    function test_replaysDepositTransferAndWithdrawalWithRealProofs() public {
        string memory json = _fixture(POOL_FIXTURE);
        vm.etch(VERIFIER, _deployVerifier().code);
        DepositFx memory dep = _deposits(json)[0];
        TransactFx memory transfer = _transact(json, ".transfer");
        TransactFx memory withdrawal = _transact(json, ".withdrawal");

        vm.recordLogs();
        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], NEW_COMMITMENT);
        assertEq(uint256(logs[0].topics[1]), dep.commitment);
        (uint256 leafIndex, bytes memory ciphertext) = abi.decode(logs[0].data, (uint256, bytes));
        assertEq(leafIndex, 0);
        assertEq(ciphertext, dep.ciphertext);

        assertTrue(pool.isKnownRoot(transfer.signals[0]));
        pool.transact(transfer.proof, transfer.signals, transfer.recipient, transfer.ciphertexts);
        assertTrue(pool.isSpent(transfer.signals[4]));
        assertTrue(pool.isSpent(transfer.signals[5]));
        assertEq(1 + vm.getRecordedLogs().length, 1 + 2 + 3);

        pool.transact(withdrawal.proof, withdrawal.signals, withdrawal.recipient, withdrawal.ciphertexts);
        assertEq(pool.root(), vm.parseJsonUint(json, ".finalRoot"));
        assertEq(withdrawal.recipient.balance, withdrawal.signals[1]);

        vm.expectRevert(NullifierAlreadySpent.selector);
        pool.transact(transfer.proof, transfer.signals, transfer.recipient, transfer.ciphertexts);
        vm.expectRevert(NullifierAlreadySpent.selector);
        pool.transact(withdrawal.proof, withdrawal.signals, withdrawal.recipient, withdrawal.ciphertexts);
    }

    // 3. rejects tampered transactions
    function test_rejectsTamperedTransactions() public {
        string memory json = _fixture(POOL_FIXTURE);
        vm.etch(VERIFIER, _deployVerifier().code);
        DepositFx memory dep = _deposits(json)[0];
        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        TransactFx memory t = _transact(json, ".transfer");

        uint256[9] memory s = _copy(t.signals);
        s[0] += 1;
        vm.expectRevert(UnknownRoot.selector);
        pool.transact(t.proof, s, t.recipient, t.ciphertexts);

        s = _copy(t.signals);
        s[5] = s[4];
        vm.expectRevert(DuplicateNullifier.selector);
        pool.transact(t.proof, s, t.recipient, t.ciphertexts);

        bytes memory flipped = bytes.concat(t.ciphertexts);
        flipped[200] = bytes1(uint8(flipped[200]) ^ 1);
        vm.expectRevert(InvalidExtData.selector);
        pool.transact(t.proof, t.signals, t.recipient, flipped);

        bytes memory truncated = new bytes(503);
        for (uint256 i = 0; i < 503; i++) {
            truncated[i] = t.ciphertexts[i];
        }
        vm.expectRevert(InvalidExtData.selector);
        pool.transact(t.proof, t.signals, t.recipient, truncated);

        vm.expectRevert(InvalidExtData.selector);
        pool.transact(t.proof, t.signals, address(0xBEEF), t.ciphertexts);

        uint256[8] memory p = _copy(t.proof);
        p[2] += 1;
        vm.expectRevert(InvalidProof.selector);
        pool.transact(p, t.signals, t.recipient, t.ciphertexts);

        s = _copy(t.signals);
        s[6] += 1;
        vm.expectRevert(InvalidProof.selector);
        pool.transact(t.proof, s, t.recipient, t.ciphertexts);

        s = _copy(t.signals);
        s[1] = MAX_AMOUNT + 1;
        vm.expectRevert(InvalidAmount.selector);
        pool.transact(t.proof, s, t.recipient, t.ciphertexts);

        pool.transact(t.proof, t.signals, t.recipient, t.ciphertexts);
        assertTrue(pool.isSpent(t.signals[4]));
    }

    // 4. withdrawals pay only allowed tokens
    function test_withdrawalsPayOnlyAllowedTokens() public {
        string memory json = _fixture(POOL_FIXTURE);
        vm.etch(VERIFIER, _deployVerifier().code);
        DepositFx memory dep = _deposits(json)[0];
        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        TransactFx memory t = _transact(json, ".transfer");
        pool.transact(t.proof, t.signals, t.recipient, t.ciphertexts);

        TransactFx memory w = _transact(json, ".withdrawal");
        w.signals[2] = 0x1234;
        vm.expectRevert(TokenNotAllowed.selector);
        pool.transact(w.proof, w.signals, w.recipient, w.ciphertexts);
    }

    // 5. deposit checks
    function test_depositChecks() public {
        bytes memory ct = new bytes(168);
        vm.expectRevert(InvalidValue.selector);
        pool.deposit{value: 5}(address(0), 6, 1, ct);
        vm.expectRevert(InvalidCiphertext.selector);
        pool.deposit{value: 5}(address(0), 5, 1, new bytes(167));
        vm.expectRevert(InvalidField.selector);
        pool.deposit{value: 5}(address(0), 5, R, ct);
        vm.expectRevert(TokenNotAllowed.selector);
        pool.deposit(0x7777777777777777777777777777777777777777, 5, 1, ct);
        vm.expectRevert(InvalidValue.selector);
        pool.deposit{value: 5}(STABLECOIN, 5, 1, ct);
        vm.deal(address(this), MAX_AMOUNT + 1);
        vm.expectRevert(InvalidAmount.selector);
        pool.deposit{value: MAX_AMOUNT + 1}(address(0), MAX_AMOUNT + 1, 1, ct);
        vm.expectRevert(InvalidAmount.selector);
        pool.deposit(address(0), 0, 1, ct);

        vm.recordLogs();
        pool.deposit{value: 5}(address(0), 5, 1, ct);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        // Poseidon2(5, 1): the native token packs as 0 * 2^64 + 5.
        assertEq(
            uint256(logs[0].topics[1]), 18816500215088851864087434109260149332202299045149106498974725137014314419960
        );
        assertTrue(pool.isKnownRoot(pool.root()));
        assertTrue(pool.root() != EMPTY_ROOT);
    }

    /// The stablecoin path: the commitment reflects the balance difference, and token failures map
    /// to TransferFailed (not the token's own revert reason).
    function test_stablecoinDepositsCommitWhatArrived() public {
        TestStablecoin token = new TestStablecoin();
        Pool stablePool = new Pool();
        stablePool.initialize(address(token), VERIFIER, HASHER, DISPUTES);
        bytes memory ct = new bytes(168);

        token.mint(address(this), 100_000_000);
        vm.expectRevert(TransferFailed.selector); // no allowance yet
        stablePool.deposit(address(token), 100_000_000, 1, ct);

        token.approve(address(stablePool), type(uint256).max);
        vm.recordLogs();
        stablePool.deposit(address(token), 100_000_000, 1, ct);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Transfer (from the token) then NewCommitment.
        assertEq(logs.length, 2);
        uint256 packed = (uint256(uint160(address(token))) << 64) | 100_000_000;
        assertEq(uint256(logs[1].topics[1]), Hasher(HASHER).hash2(packed, 1));
        assertEq(token.balanceOf(address(stablePool)), 100_000_000);

        vm.expectRevert(TransferFailed.selector); // balance too low
        stablePool.deposit(address(token), 1, 1, ct);
    }

    /// A pool configured without a stablecoin refuses every ERC-20.
    function test_noStablecoinMeansNoErc20() public {
        Pool nativeOnly = new Pool();
        nativeOnly.initialize(address(0), VERIFIER, HASHER, DISPUTES);
        vm.expectRevert(TokenNotAllowed.selector);
        nativeOnly.deposit(STABLECOIN, 5, 1, new bytes(168));
    }

    // 6. settle is only for the Disputes contract
    function test_settleIsOnlyForTheDisputesContract() public {
        bytes memory cts = _ciphertexts(1, 3);
        uint256 root = pool.root();
        vm.expectRevert(Unauthorized.selector);
        pool.settle(root, 10, 11, [uint256(1), 2, 3], cts);

        vm.prank(DISPUTES);
        pool.settle(root, 10, 11, [uint256(1), 2, 3], cts);
        assertTrue(pool.isSpent(10));
        assertTrue(pool.isSpent(11));
        assertTrue(pool.root() != root);

        uint256 current = pool.root();
        vm.prank(DISPUTES);
        vm.expectRevert(NullifierAlreadySpent.selector);
        pool.settle(current, 10, 12, [uint256(4), 5, 6], cts);

        vm.prank(DISPUTES);
        vm.expectRevert(InvalidCiphertext.selector);
        pool.settle(current, 12, 13, [uint256(4), 5, 6], new bytes(10));

        vm.prank(DISPUTES);
        vm.expectRevert(InvalidCiphertext.selector);
        pool.settle(current, 12, 13, [uint256(4), R, 6], cts);
    }

    // 7. keeps exactly the last 100 roots
    function test_keepsExactlyTheLast100Roots() public {
        bytes memory cts = _ciphertexts(1, 3);
        uint256[] memory seen = new uint256[](101);
        seen[0] = pool.root();
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(DISPUTES);
            pool.settle(seen[i], 1000 + 2 * i, 1001 + 2 * i, [i + 1, i + 2, i + 3], cts);
            seen[i + 1] = pool.root();
        }
        assertEq(seen[0], EMPTY_ROOT);
        assertFalse(pool.isKnownRoot(seen[0]));
        for (uint256 i = 1; i <= 100; i++) {
            assertTrue(pool.isKnownRoot(seen[i]));
        }
    }
}
