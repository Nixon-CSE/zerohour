// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HourglassRegistry} from "../src/HourglassRegistry.sol";
import {ZeroHourExam} from "../src/ZeroHourExam.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/MockPqc.sol";

contract ZeroHourExamTest is Test {
    HourglassRegistry reg;
    ZeroHourExam zh;
    MockPqcKeyStatus keyStatus;

    uint32 constant N = 30;
    uint32 constant ROUND_SECONDS = 300;
    uint64 genesis;

    address board = makeAddr("board");
    address hunter = makeAddr("leakHunter");
    address centreA = makeAddr("centre17-pune");
    address centreB = makeAddr("centre05-patna");
    address attacker = makeAddr("attacker");
    address[] keypers;
    mapping(address => bytes32[]) chain;

    bytes32 constant LABEL = keccak256("NEET-MOCK-2026-SHIFT-1");
    bytes32 constant PAPER = keccak256("the plaintext paper a centre decrypted");
    bytes32 EXAM; // v2: derived from (board, LABEL)
    uint32 constant ROUND_A = 10;
    uint32 constant ROUND_B = 20;
    bytes32 constant CANON_A = keccak256("canonical paper A");
    bytes32 constant CANON_B = keccak256("canonical paper B");
    bytes32 constant SALT = keccak256("salt");

    function setUp() public {
        vm.etch(address(0x0A01), address(new MockPqcVerify()).code);
        vm.etch(address(0x0A02), address(new MockPqcKeyStatus()).code);
        keyStatus = MockPqcKeyStatus(address(0x0A02));
        reg = new HourglassRegistry(1 ether, 1 days);
        zh = new ZeroHourExam(reg);
        genesis = uint64(block.timestamp + 1 hours);

        for (uint256 i; i < 3; i++) {
            address k = makeAddr(string(abi.encodePacked("keyper", vm.toString(i))));
            keypers.push(k);
            _key(k);
            bytes32[] storage s = chain[k];
            for (uint256 r; r <= N; r++) s.push();
            s[N] = keccak256(abi.encodePacked("top", i));
            for (uint256 r = N; r > 0; r--) s[r - 1] = keccak256(abi.encodePacked(s[r]));
            bytes32 anchor = keccak256(abi.encodePacked(s[0]));
            bytes32 d = reg.registerDigest(k, anchor, bytes32(0), genesis, ROUND_SECONDS, N);
            vm.deal(address(this), 10 ether);
            reg.register{value: 1 ether}(k, anchor, bytes32(0), genesis, ROUND_SECONDS, N, _sig(k, d));
        }
        _key(board);
        EXAM = zh.examIdOf(board, LABEL);
        _key(hunter);
        _key(centreA);
        _key(centreB);
    }

    // ------------------------------------------------------------ helpers
    function _pk(address a) internal pure returns (bytes memory) {
        return abi.encodePacked("mldsa87-pk-", a);
    }

    function _key(address a) internal {
        keyStatus.setKey(a, _pk(a));
    }

    function _sig(address signer, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_pk(signer), abi.encodePacked(digest))));
    }

    function _time(uint32 round) internal view returns (uint256) {
        return uint256(genesis) + uint256(round) * ROUND_SECONDS;
    }

    function _create() internal {
        bytes32 commitA = keccak256(abi.encodePacked(CANON_A, SALT));
        bytes32 commitB = keccak256(abi.encodePacked(CANON_B, SALT));
        bytes32 d = zh.createDigest(EXAM, board, hunter, keypers, 2, ROUND_A, ROUND_B, commitA, commitB, bytes32("manifest"));
        zh.createExam(LABEL, board, hunter, keypers, 2, ROUND_A, ROUND_B, commitA, commitB, bytes32("manifest"), _sig(board, d));
    }

    function _addCentre(address c) internal {
        bytes32 d = zh.centreDigest(EXAM, c, keccak256(abi.encode(c, "A")), keccak256(abi.encode(c, "B")), bytes32("perm"));
        zh.addCentre(EXAM, c, keccak256(abi.encode(c, "A")), keccak256(abi.encode(c, "B")), bytes32("perm"), _sig(board, d));
    }

    function _release(uint256 keyperIdx, uint32 round) internal {
        reg.release(keypers[keyperIdx], round, chain[keypers[keyperIdx]][round]);
    }

    function _open(address c, bool backup) internal {
        bytes memory s = _sig(c, zh.openDigest(EXAM, c, backup, PAPER));
        zh.recordOpening(EXAM, c, PAPER, s);
    }

    // ------------------------------------------------------------ tests
    function test_create_requiresBoardPqcSignature() public {
        bytes32 commitA = keccak256(abi.encodePacked(CANON_A, SALT));
        vm.expectRevert(ZeroHourExam.BadPqcSignature.selector);
        zh.createExam(LABEL, board, hunter, keypers, 2, ROUND_A, ROUND_B, commitA, commitA, bytes32(0), hex"00");
        _create();
        assertEq(zh.getExam(EXAM).threshold, 2);
    }

    function test_centre_cannotBeAddedAfterUnlockTime() public {
        _create();
        vm.warp(_time(ROUND_A));
        bytes32 d = zh.centreDigest(EXAM, centreA, bytes32(0), bytes32(0), bytes32(0));
        bytes memory s = _sig(board, d);
        vm.expectRevert(ZeroHourExam.TooLate.selector);
        zh.addCentre(EXAM, centreA, bytes32(0), bytes32(0), bytes32(0), s);
    }

    function test_nobodyOpensBeforeThreshold() public {
        _create();
        _addCentre(centreA);
        vm.warp(_time(ROUND_A));
        _release(0, ROUND_A); // 1 of 3 — below threshold 2
        bytes memory s = _sig(centreA, zh.openDigest(EXAM, centreA, false, PAPER));
        vm.expectRevert(ZeroHourExam.NotUnlocked.selector);
        zh.recordOpening(EXAM, centreA, PAPER, s);
        _release(1, ROUND_A); // 2 of 3
        assertTrue(zh.isUnlocked(EXAM));
        zh.recordOpening(EXAM, centreA, PAPER, s);
        (,,,, uint64 openedAt,) = zh.centres(EXAM, centreA);
        assertEq(openedAt, _time(ROUND_A));
        vm.expectRevert(ZeroHourExam.AlreadyOpened.selector);
        zh.recordOpening(EXAM, centreA, PAPER, s);
    }

    function test_openingNeedsCentrePqcKey_notClassicalKey() public {
        _create();
        _addCentre(centreA);
        vm.warp(_time(ROUND_A));
        _release(0, ROUND_A);
        _release(2, ROUND_A);
        vm.prank(centreA); // the classical key alone
        vm.expectRevert(ZeroHourExam.BadPqcSignature.selector);
        zh.recordOpening(EXAM, centreA, PAPER, hex"00");
    }

    function test_backupSwitch_movesEveryCentreToSetB() public {
        _create();
        _addCentre(centreA);
        _addCentre(centreB);
        // leak detected after set A opened in some region -> switch
        vm.warp(_time(ROUND_A) + 60);
        bytes32 reason = keccak256("leak report #1");
        zh.switchToBackup(EXAM, reason, _sig(board, zh.switchDigest(EXAM, reason)));
        assertEq(zh.activeRound(EXAM), ROUND_B);
        // set A seeds no longer unlock anything
        _release(0, ROUND_A);
        _release(1, ROUND_A);
        assertFalse(zh.isUnlocked(EXAM));
        vm.warp(_time(ROUND_B));
        _release(0, ROUND_B);
        _release(2, ROUND_B);
        _open(centreA, true);
        _open(centreB, true);
    }

    function test_backupSwitch_tooLateOnceSetBUnlockTimePassed() public {
        _create();
        vm.warp(_time(ROUND_B));
        bytes32 reason = keccak256("late");
        bytes memory s = _sig(board, zh.switchDigest(EXAM, reason));
        vm.expectRevert(ZeroHourExam.TooLate.selector);
        zh.switchToBackup(EXAM, reason, s);
    }

    function test_leakReport_onlyFromLeakHunterKey() public {
        _create();
        _addCentre(centreA);
        bytes32 ev = keccak256("photo of Q1-Q4");
        bytes memory forged = _sig(attacker, zh.leakDigest(EXAM, centreA, ev, 9970, bytes32("ipfs")));
        vm.expectRevert(ZeroHourExam.BadPqcSignature.selector);
        zh.reportLeak(EXAM, centreA, ev, 9970, bytes32("ipfs"), forged);
        zh.reportLeak(EXAM, centreA, ev, 9970, bytes32("ipfs"), _sig(hunter, zh.leakDigest(EXAM, centreA, ev, 9970, bytes32("ipfs"))));
        (,,,,, uint32 reports) = zh.centres(EXAM, centreA);
        assertEq(reports, 1);
    }

    function test_fairnessReveal_onlyAfterUnlockAndMatchingCommit() public {
        _create();
        bytes memory s = _sig(board, zh.revealDigest(EXAM, CANON_A, SALT));
        vm.expectRevert(ZeroHourExam.NotOver.selector);
        zh.revealFairness(EXAM, CANON_A, SALT, s);
        vm.warp(_time(ROUND_A));
        _release(0, ROUND_A);
        _release(1, ROUND_A);
        bytes memory wrong = _sig(board, zh.revealDigest(EXAM, CANON_B, SALT));
        vm.expectRevert(ZeroHourExam.CommitMismatch.selector);
        zh.revealFairness(EXAM, CANON_B, SALT, wrong);
        zh.revealFairness(EXAM, CANON_A, SALT, s);
        assertTrue(zh.getExam(EXAM).revealed);
    }

    /// Regression: a keyper that skips straight to a later round still counts — the later
    /// seed hashes down to the exam round's seed, so the exam must unlock.
    function test_unlocksWhenKeyperReleasesALaterRound() public {
        _create();
        _addCentre(centreA);
        vm.warp(_time(ROUND_A + 3));
        _release(0, ROUND_A + 3); // skips ROUND_A; seedOf(k0, ROUND_A) stays empty
        _release(1, ROUND_A);
        assertEq(reg.seedOf(keypers[0], ROUND_A), bytes32(0));
        assertTrue(zh.isUnlocked(EXAM));
        _open(centreA, false);
    }

    // ------------------------------------------------------------ v2 regressions (audit, 20 Nov)
    /// Expects `err` (if non-empty) from createExam itself, not from the helper's view calls.
    function _createWith(bytes32 label, address[] memory ks, uint8 t, uint32 a, uint32 b, bytes memory err) internal {
        bytes32 id = zh.examIdOf(board, label);
        bytes memory sig = _sig(board, zh.createDigest(id, board, hunter, ks, t, a, b, 0, 0, 0));
        if (err.length > 0) vm.expectRevert(err);
        zh.createExam(label, board, hunter, ks, t, a, b, 0, 0, 0, sig);
    }

    /// Audit M3: the id is bound to the board, so a squatter using the same label gets its own id.
    function test_v2_examIdCannotBeSquatted() public {
        _key(attacker);
        bytes32 squatId = zh.examIdOf(attacker, LABEL);
        zh.createExam(LABEL, attacker, attacker, keypers, 2, ROUND_A, ROUND_B, 0, 0, 0,
            _sig(attacker, zh.createDigest(squatId, attacker, attacker, keypers, 2, ROUND_A, ROUND_B, 0, 0, 0)));
        assertTrue(squatId != EXAM);
        _create(); // the real board is unaffected
        assertEq(zh.getExam(EXAM).board, board);
    }

    /// Audit M2: a duplicated keyper would let one seed meet a threshold of 2.
    function test_v2_duplicateKeypersRejected() public {
        address[] memory ks = new address[](2);
        ks[0] = keypers[0];
        ks[1] = keypers[0];
        _createWith("dup", ks, 2, ROUND_A, ROUND_B, abi.encodeWithSelector(ZeroHourExam.BadKeyper.selector, keypers[0]));
    }

    function test_v2_unregisteredOrSlashedKeyperRejected() public {
        address[] memory ks = new address[](2);
        ks[0] = keypers[0];
        ks[1] = attacker; // never registered
        _createWith("unreg", ks, 2, ROUND_A, ROUND_B, abi.encodeWithSelector(ZeroHourExam.BadKeyper.selector, attacker));
        // slash keyper 1, then it cannot be listed
        bytes32 c = reg.reportCommitment(keypers[1], ROUND_A, chain[keypers[1]][ROUND_A], bytes32("s"), attacker);
        vm.prank(attacker);
        reg.commitReport(c);
        vm.prank(attacker);
        reg.revealReport(keypers[1], ROUND_A, chain[keypers[1]][ROUND_A], bytes32("s"));
        ks[1] = keypers[1];
        _createWith("slashed", ks, 2, ROUND_A, ROUND_B, abi.encodeWithSelector(ZeroHourExam.BadKeyper.selector, keypers[1]));
    }

    function test_v2_roundsMustBeInTheFutureAndInsideEveryChain() public {
        _createWith("beyond", keypers, 2, ROUND_A, N + 1, abi.encodeWithSelector(ZeroHourExam.BadKeyper.selector, keypers[0]));
        _createWith("ok", keypers, 2, ROUND_A, ROUND_B, "");
        vm.warp(_time(ROUND_A));
        _createWith("past", keypers, 2, ROUND_A, ROUND_B, abi.encodeWithSelector(ZeroHourExam.TooLate.selector));
    }

    /// Audit L1 + H3: receipts are per set and carry the decrypted paper's hash, so a centre that
    /// opened A can still sign for B after a switch, and the reveal can be checked against it.
    function test_v2_receiptPerSetCarriesPaperHash() public {
        _create();
        _addCentre(centreA);
        _addCentre(centreB);
        vm.warp(_time(ROUND_A));
        _release(0, ROUND_A);
        _release(1, ROUND_A);
        _open(centreA, false);
        assertEq(zh.receiptOf(EXAM, centreA, false), PAPER);
        bytes32 reason = keccak256("leak after A opened");
        zh.switchToBackup(EXAM, reason, _sig(board, zh.switchDigest(EXAM, reason)));
        vm.warp(_time(ROUND_B));
        _release(0, ROUND_B);
        _release(2, ROUND_B);
        bytes32 paperB = keccak256("paper B as decrypted");
        zh.recordOpening(EXAM, centreA, paperB, _sig(centreA, zh.openDigest(EXAM, centreA, true, paperB)));
        assertEq(zh.receiptOf(EXAM, centreA, true), paperB);
        vm.expectRevert(ZeroHourExam.BadParams.selector);
        zh.recordOpening(EXAM, centreB, bytes32(0), hex"00"); // a receipt must name the paper it opened
    }
}
