// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hasher} from "../src/Hasher.sol";
import {InvalidField, Shared, TreeFull} from "../src/Shared.sol";
import {TreeOracle} from "./utils/TreeOracle.sol";

/// all-ref §4.10.4 plus the §11.2 cross-check of the Solidity Poseidon against circomlibjs.
contract HasherTest is Test {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    Hasher internal hasher;

    function setUp() public {
        hasher = new Hasher();
    }

    function test_hashesLikeCircomlibAndRejectsNonFieldInputs() public {
        assertEq(hasher.hash2(1, 2), 7853200120776062878684798364095072458815029376092732009249414926327459813530);
        vm.expectRevert(InvalidField.selector);
        hasher.hash2(R, 2);
        vm.expectRevert(InvalidField.selector);
        hasher.hash2(2, R);
    }

    /// Expected values computed with poseidon-lite (circomlib constants, the same as circomlibjs) on
    /// keccak-derived pseudo-random inputs and on the field's edges.
    function test_matchesCircomlibOnRandomAndEdgeInputs() public view {
        _check(
            15255157475035283782378619069557329253304245394513428404183525807371852326841,
            8176503476195639094468693491416732104444220452620221285221199798214750534321,
            5151658816155123418186476544853565955186005628760502640871024208360914579559
        );
        _check(
            5745657640940340670019589335963001626676969396337718801387925076547325415176,
            2921347269521084514983594619241210810814628847131934529518274289353045270438,
            5773072713217973495763176716772346519211539777399143464520149579836854349243
        );
        _check(
            14099763031686266391627484099386951987748919469880849513555166505891744977893,
            20568995021100481755398011959936329624077436176377624182514052786489083382078,
            17452559903413305602117725820833045339074810573868171192702854283865833656563
        );
        _check(
            10332900134668784485466363686662393999108329981204575685780551561420621777197,
            12997270445980450185180160202051806229822640843275768507795349341170916728528,
            14544428073158511665811821899203551650380625846312731909741767135301176202800
        );
        _check(
            18506884208023818065220358182295459573096491805304443801482655290894861611785,
            707832648977245785355712654956074655109499593151243992612988807382783292673,
            15871357747067763482342575455653326868358641661571891632124079086294482870771
        );
        _check(
            3176861536453668744794051268404834604206011082514507569287269479843557921471,
            21367410725017446110106963486111873217639881883137735614005904044848279748080,
            18960859821969455037448022005776196923942874825984416668347212756146340956649
        );
        _check(
            12458731456382938412144108020282296149161351620544285807698313850368178600217,
            3831679784410686210159218089093897574791761341694055713998357206294562868582,
            20981589606513232865415762217966619844751732668132648074637860338844867806532
        );
        _check(
            19096397404475335059704383760125402806405492379538228225601983259042352084116,
            12929588443613173166311525959191409689383502723354242272688334165651699116654,
            7020265470787454782419631707389301022449984612562789636080404036841298476573
        );
        _check(R - 1, R - 1, 20092309280547939997162506796691455192771288143174894022739895715370814071035);
        _check(0, R - 1, 18408546291162903352980960740361656607192922946056016208256932944581138225340);
        _check(R - 1, 0, 12398508882227933492673204572813459761914093043589189755216261111298919601208);
        _check((1 << 224) - 1, 12345, 9242397970897135165006066892283518284255125361645188888775051693537314883957);
        // Native deposit of 5 with inner 1: Poseidon2(5, 1) (all-ref §4.2.2).
        _check(5, 1, 18816500215088851864087434109260149332202299045149106498974725137014314419960);
    }

    function test_zeroValuesChainThroughTheHash() public view {
        uint256[21] memory zeros = Shared.zeros();
        assertEq(zeros[0], 0);
        for (uint256 i = 0; i < 20; i++) {
            assertEq(hasher.hash2(zeros[i], zeros[i]), zeros[i + 1]);
        }
        assertEq(zeros[1], 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864);
        assertEq(zeros[20], 15019797232609675441998260052101280400536945603062888308240081994073687793470);
    }

    function test_insertLeavesReturnsTheSameRootAsTheCoreTree() public view {
        uint256[20] memory empty;
        uint256[] memory leaves = new uint256[](3);
        (leaves[0], leaves[1], leaves[2]) = (11, 22, 33);
        (uint256[20] memory frontier, uint256 root) = hasher.insertLeaves(empty, 0, leaves);

        uint256[20] memory expectedFrontier;
        uint256 expectedRoot;
        for (uint256 i = 0; i < 3; i++) {
            expectedRoot = TreeOracle.insertOne(expectedFrontier, i, leaves[i]);
        }
        assertEq(root, expectedRoot);
        assertEq(root, TreeOracle.fullRoot(leaves));
        // MerkleTree of @calyptra/framework/protocol with the leaves 11, 22, 33.
        assertEq(root, 20468120495450720226073002917147689356754140023383955129716895173960773083314);
        for (uint256 level = 0; level < 20; level++) {
            assertEq(frontier[level], expectedFrontier[level]);
        }
    }

    function test_insertLeavesRejectsOverflowEmptyBatchesAndNonFieldValues() public {
        uint256[20] memory empty;
        uint256[] memory three = new uint256[](3);
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(empty, uint64(1 << 20), three);
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(empty, 0, new uint256[](0));
        vm.expectRevert(TreeFull.selector);
        hasher.insertLeaves(empty, type(uint64).max, three);

        uint256[] memory bad = new uint256[](1);
        bad[0] = R;
        vm.expectRevert(InvalidField.selector);
        hasher.insertLeaves(empty, 0, bad);
        uint256[20] memory badFrontier;
        badFrontier[7] = R;
        vm.expectRevert(InvalidField.selector);
        hasher.insertLeaves(badFrontier, 0, three);
    }

    function _check(uint256 a, uint256 b, uint256 expected) internal view {
        assertEq(hasher.hash2(a, b), expected);
    }
}
