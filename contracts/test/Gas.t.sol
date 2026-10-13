// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Disputes} from "../src/Disputes.sol";
import {Hasher} from "../src/Hasher.sol";
import {Pool} from "../src/Pool.sol";
import {TestStablecoin} from "../src/test/TestStablecoin.sol";
import {CalyptraTest} from "./utils/CalyptraTest.sol";

/// Sends a payout the way `Pool._pay` does, to price an ERC-20 payout against a native one.
contract PayoutProbe {
    function payNative(address to, uint256 amount) external {
        (bool ok,) = to.call{value: amount}("");
        require(ok);
    }

    function payToken(address token, address to, uint256 amount) external {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (uint256)) != 0));
    }
}

/// Gas per operation on the real contracts with real proofs, priced with Foundry's Monad schedule
/// (foundry.toml `network = "monad"`). Monad bills the declared gas LIMIT, so callers must send the
/// explicit limits below (measured worst case + 10-15 %). Accurate figures need
/// isolated transactions (intrinsic + calldata gas included, fresh access lists):
///     forge test --isolate --match-contract GasTest -vv
/// The worst case of a 3-leaf insert (39 Poseidon hashes) is reached by placing leafCount at 2^19 - 1.
contract GasTest is CalyptraTest {
    // Recommended explicit gas limits: the worst case measured below + 12-15 %. Asserted,
    // so a gas regression fails here first.
    //   deposit:      worst = first deposit into the empty tree (20 frontier slots written from zero),
    //                 1,161,092 (stablecoin) / 1,096,164 (native); later deposits ~753k / ~821k. The limit
    //                 also covers a local anvil node's Ethereum pricing (first stablecoin deposit 1,224,291).
    //   transact:     worst = 3 leaves at index 2^19 - 1 (39 hashes) with a payout, 2,642,891 (stablecoin,
    //                 derived) / 2,631,687 (native); a typical transfer is ~2.06M.
    //   submitState:  worst = starting a dispute, 1,210,863; answering ~1.16M.
    //   finalize:     worst 2,651,346 (39 hashes); typical ~2.12-2.18M.
    //   reclaim:      worst 2,586,185 (39 hashes); typical ~2.08M.
    uint256 internal constant DEPOSIT_GAS_LIMIT = 1_350_000;
    uint256 internal constant TRANSACT_GAS_LIMIT = 3_000_000;
    uint256 internal constant SUBMIT_STATE_GAS_LIMIT = 1_380_000;
    uint256 internal constant FINALIZE_GAS_LIMIT = 3_000_000;
    uint256 internal constant RECLAIM_GAS_LIMIT = 2_950_000;

    uint256 internal constant DAY = 86400;
    bytes32 internal constant LEAF_COUNT_SLOT = bytes32(uint256(3)); // _disputes | leafCount << 160 | currentRootSlot << 192
    uint256 internal constant WORST_START = (1 << 19) - 1;

    Pool internal pool;
    Disputes internal disputes;
    TestStablecoin internal token;

    function setUp() public {
        address verifier = _deployVerifier();
        address hasher = address(new Hasher());
        token = new TestStablecoin();
        pool = new Pool();
        disputes = new Disputes();
        pool.initialize(address(token), verifier, hasher, address(disputes));
        disputes.initialize(address(pool), verifier);
        vm.warp(1_800_000_000);
    }

    function test_gasPoolOperations() public {
        string memory json = _fixture(POOL_FIXTURE);
        DepositFx memory dep = _deposits(json)[0];
        TransactFx memory t = _transact(json, ".transfer");
        TransactFx memory w = _transact(json, ".withdrawal");

        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        _record("deposit native, first deposit into the empty tree", DEPOSIT_GAS_LIMIT);
        pool.transact(t.proof, t.signals, t.recipient, t.ciphertexts);
        _record("transact: private transfer", TRANSACT_GAS_LIMIT);
        pool.transact(w.proof, w.signals, w.recipient, w.ciphertexts);
        _record("transact: withdrawal, native payout", TRANSACT_GAS_LIMIT);

        pool.deposit{value: 5}(address(0), 5, 1, new bytes(168));
        _record("deposit native, later deposit", DEPOSIT_GAS_LIMIT);
        token.mint(address(this), 100_000_000);
        token.approve(address(pool), 100_000_000);
        pool.deposit(address(token), 100_000_000, 1, new bytes(168));
        _record("deposit stablecoin, later deposit", DEPOSIT_GAS_LIMIT);
    }

    function test_gasFirstStablecoinDeposit() public {
        token.mint(address(this), 100_000_000);
        token.approve(address(pool), 100_000_000);
        _record("approve stablecoin (TestStablecoin)", type(uint256).max);
        pool.deposit(address(token), 100_000_000, 1, new bytes(168));
        _record("deposit stablecoin, first deposit into the empty tree", DEPOSIT_GAS_LIMIT);
    }

    function test_gasWorstAlignmentTransfer() public {
        string memory json = _fixture(POOL_FIXTURE);
        DepositFx memory dep = _deposits(json)[0];
        TransactFx memory t = _transact(json, ".transfer");
        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        _setLeafCount(WORST_START);
        pool.transact(t.proof, t.signals, t.recipient, t.ciphertexts);
        _record("transact: private transfer, worst alignment (39 hashes)", TRANSACT_GAS_LIMIT);
    }

    function test_gasWorstAlignmentWithdrawal() public {
        string memory json = _fixture(POOL_FIXTURE);
        DepositFx memory dep = _deposits(json)[0];
        TransactFx memory t = _transact(json, ".transfer");
        TransactFx memory w = _transact(json, ".withdrawal");
        pool.deposit{value: dep.amount}(dep.token, dep.amount, dep.inner, dep.ciphertext);
        pool.transact(t.proof, t.signals, t.recipient, t.ciphertexts);
        _setLeafCount(WORST_START);
        pool.transact(w.proof, w.signals, w.recipient, w.ciphertexts);
        uint256 nativeWorst = _record("transact: withdrawal native, worst alignment (39 hashes)", TRANSACT_GAS_LIMIT);

        // The fixtures pay out the native coin; an ERC-20 payout differs only in the payout call.
        PayoutProbe probe = new PayoutProbe();
        vm.deal(address(probe), 1 ether);
        token.mint(address(probe), 1_000_000);
        probe.payNative(address(0xA11CE), 20);
        uint256 nativePayout = vm.lastFrameGas().gasTotalUsed;
        probe.payToken(address(token), address(0xB0B), 20);
        uint256 tokenPayout = vm.lastFrameGas().gasTotalUsed;
        uint256 stableWorst = nativeWorst + tokenPayout - nativePayout;
        console.log("transact: withdrawal stablecoin, worst alignment (derived)", stableWorst);
        assertLe(stableWorst, TRANSACT_GAS_LIMIT);
    }

    function test_gasDisputeOperations() public {
        string memory json = _replayDisputeDeposits();
        SubmitFx memory old = _submit(json, ".submitOld");
        SubmitFx memory latest = _submit(json, ".submitLatest");
        FinalizeFx memory fin = _finalize(json, ".finalize");
        SubmitFx memory state0 = _submit(json, ".submitState0");
        FinalizeFx memory fin0 = _finalize(json, ".finalizeState0");
        ReclaimFx memory rec = _reclaim(json, ".reclaim");

        disputes.submitState(old.proof, old.signals);
        _record("submitState: start a dispute", SUBMIT_STATE_GAS_LIMIT);
        disputes.submitState(latest.proof, latest.signals);
        _record("submitState: answer with a newer state", SUBMIT_STATE_GAS_LIMIT);
        disputes.submitState(state0.proof, state0.signals);
        vm.warp(block.timestamp + 3 * DAY);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        _record("finalize", FINALIZE_GAS_LIMIT);
        disputes.finalize(fin0.proof, fin0.signals, fin0.ciphertexts);
        _record("finalize (state listing one contribution)", FINALIZE_GAS_LIMIT);
        disputes.reclaim(rec.proof, rec.signals, rec.ciphertexts);
        _record("reclaim", RECLAIM_GAS_LIMIT);
    }

    function test_gasWorstAlignmentFinalize() public {
        string memory json = _replayDisputeDeposits();
        SubmitFx memory latest = _submit(json, ".submitLatest");
        FinalizeFx memory fin = _finalize(json, ".finalize");
        disputes.submitState(latest.proof, latest.signals);
        vm.warp(block.timestamp + 3 * DAY);
        _setLeafCount(WORST_START);
        disputes.finalize(fin.proof, fin.signals, fin.ciphertexts);
        _record("finalize, worst alignment (39 hashes)", FINALIZE_GAS_LIMIT);
    }

    function test_gasWorstAlignmentReclaim() public {
        string memory json = _replayDisputeDeposits();
        SubmitFx memory state0 = _submit(json, ".submitState0");
        FinalizeFx memory fin0 = _finalize(json, ".finalizeState0");
        ReclaimFx memory rec = _reclaim(json, ".reclaim");
        disputes.submitState(state0.proof, state0.signals);
        vm.warp(block.timestamp + 3 * DAY);
        disputes.finalize(fin0.proof, fin0.signals, fin0.ciphertexts);
        _setLeafCount(WORST_START);
        disputes.reclaim(rec.proof, rec.signals, rec.ciphertexts);
        _record("reclaim, worst alignment (39 hashes)", RECLAIM_GAS_LIMIT);
    }

    function _replayDisputeDeposits() internal returns (string memory json) {
        json = _fixture(DISPUTE_FIXTURE);
        DepositFx[] memory deps = _deposits(json);
        for (uint256 i = 0; i < deps.length; i++) {
            pool.deposit{value: deps[i].amount}(deps[i].token, deps[i].amount, deps[i].inner, deps[i].ciphertext);
        }
    }

    /// Moves the next free leaf index (Pool storage slot 3, bits 160..191) without touching the rest.
    function _setLeafCount(uint256 count) internal {
        uint256 word = uint256(vm.load(address(pool), LEAF_COUNT_SLOT));
        word = (word & ~(uint256(type(uint32).max) << 160)) | (count << 160);
        vm.store(address(pool), LEAF_COUNT_SLOT, bytes32(word));
    }

    function _record(string memory label, uint256 limit) internal view returns (uint256 used) {
        used = vm.lastFrameGas().gasTotalUsed;
        console.log(label, used);
        assertLe(used, limit, label);
    }
}
