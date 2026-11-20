// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HourglassRegistry} from "../src/HourglassRegistry.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/MockPqc.sol";

contract HourglassRegistryTest is Test {
    HourglassRegistry reg;
    MockPqcKeyStatus keyStatus;

    address keyper = makeAddr("keyper");
    address reporter = makeAddr("reporter");
    address attacker = makeAddr("attacker");
    bytes keyperPk = hex"aa11bb22cc33"; // stand-in ML-DSA-87 pubkey

    uint32 constant N = 20; // rounds in the chain
    uint32 constant ROUND_SECONDS = 60;
    uint64 genesis;
    bytes32[] seeds; // seeds[r]

    uint256 constant MIN_BOND = 1 ether;
    uint256 constant EXIT_DELAY = 7 days;

    function setUp() public {
        vm.etch(address(0x0A01), address(new MockPqcVerify()).code);
        vm.etch(address(0x0A02), address(new MockPqcKeyStatus()).code);
        keyStatus = MockPqcKeyStatus(address(0x0A02));
        keyStatus.setKey(keyper, keyperPk);

        reg = new HourglassRegistry(MIN_BOND, EXIT_DELAY);
        genesis = uint64(block.timestamp + 1 hours);

        // backward hash chain: seed[r-1] = keccak(seed[r])
        seeds = new bytes32[](N + 1);
        seeds[N] = keccak256("top secret seed");
        for (uint256 r = N; r > 0; r--) {
            seeds[r - 1] = keccak256(abi.encodePacked(seeds[r]));
        }
        vm.deal(keyper, 10 ether);
        vm.deal(attacker, 10 ether);
    }

    // ------------------------------------------------------------ helpers
    function _sig(bytes32 digest) internal view returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(keyperPk, abi.encodePacked(digest))));
    }

    function _anchor() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(seeds[0]));
    }

    function _register() internal {
        bytes32 d = reg.registerDigest(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N);
        reg.register{value: MIN_BOND}(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N, _sig(d));
    }

    function _at(uint32 round) internal view returns (uint256) {
        return uint256(genesis) + uint256(round) * ROUND_SECONDS;
    }

    // ------------------------------------------------------------ registration
    function test_register_ok() public {
        _register();
        (bytes32 anchor,,,,,,,uint128 bond,,, bool registered) = reg.keypers(keyper);
        assertEq(anchor, _anchor());
        assertEq(bond, MIN_BOND);
        assertTrue(registered);
    }

    function test_register_rejectsBadPqcSignature() public {
        vm.expectRevert(HourglassRegistry.BadPqcSignature.selector);
        reg.register{value: MIN_BOND}(keyper, _anchor(), bytes32(0), genesis, ROUND_SECONDS, N, hex"deadbeef");
    }

    function test_register_rejectsAccountWithoutPqcKey() public {
        bytes32 d = reg.registerDigest(attacker, _anchor(), bytes32(0), genesis, ROUND_SECONDS, N);
        vm.expectRevert(HourglassRegistry.BadPqcSignature.selector);
        reg.register{value: MIN_BOND}(attacker, _anchor(), bytes32(0), genesis, ROUND_SECONDS, N, _sig(d));
    }

    function test_register_twiceReverts() public {
        _register();
        bytes32 d = reg.registerDigest(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N);
        vm.expectRevert(HourglassRegistry.AlreadyRegistered.selector);
        reg.register{value: MIN_BOND}(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N, _sig(d));
    }

    function test_register_bondTooSmall() public {
        bytes32 d = reg.registerDigest(keyper, _anchor(), bytes32(0), genesis, ROUND_SECONDS, N);
        vm.expectRevert(HourglassRegistry.BondTooSmall.selector);
        reg.register{value: MIN_BOND - 1}(keyper, _anchor(), bytes32(0), genesis, ROUND_SECONDS, N, _sig(d));
    }

    // ------------------------------------------------------------ release
    function test_release_beforeTimeReverts() public {
        _register();
        vm.warp(_at(3) - 1);
        vm.expectRevert(HourglassRegistry.TooEarly.selector);
        reg.release(keyper, 3, seeds[3]);
    }

    function test_release_onTime_anyoneCanRelay() public {
        _register();
        vm.warp(_at(3));
        vm.prank(attacker); // relayer identity is irrelevant: the seed is the authorisation
        reg.release(keyper, 3, seeds[3]);
        assertEq(reg.seedOf(keyper, 3), seeds[3]);
        // then a later round, skipping some
        vm.warp(_at(9));
        reg.release(keyper, 9, seeds[9]);
        assertEq(reg.seedOf(keyper, 9), seeds[9]);
    }

    function test_release_wrongSeedReverts() public {
        _register();
        vm.warp(_at(3));
        vm.expectRevert(HourglassRegistry.BadSeed.selector);
        reg.release(keyper, 3, seeds[4]);
    }

    function test_release_pastRoundReverts() public {
        _register();
        vm.warp(_at(5));
        reg.release(keyper, 5, seeds[5]);
        vm.expectRevert(HourglassRegistry.AlreadyReleased.selector);
        reg.release(keyper, 4, seeds[4]);
    }

    function testFuzz_release_randomSeedNeverAccepted(bytes32 guess, uint8 r) public {
        uint32 round = uint32(bound(r, 0, N));
        vm.assume(guess != seeds[round]);
        _register();
        vm.warp(_at(round));
        vm.expectRevert(HourglassRegistry.BadSeed.selector);
        reg.release(keyper, round, guess);
    }

    // ------------------------------------------------------------ accountability
    function test_earlyLeak_isSlashed_reporterPaidHalf() public {
        _register();
        // the keyper "sells" seed[12] long before its time; the buyer reports it
        bytes32 salt = keccak256("salt");
        bytes32 c = reg.reportCommitment(keyper, 12, seeds[12], salt, reporter);
        vm.prank(reporter);
        reg.commitReport(c);
        vm.roll(block.number + 1);
        uint256 before = reporter.balance;
        vm.prank(reporter);
        reg.revealReport(keyper, 12, seeds[12], salt);
        assertEq(reporter.balance - before, MIN_BOND / 2);
        assertEq(reg.BURN().balance, MIN_BOND / 2);
        (,,,,,,,,, bool slashed,) = reg.keypers(keyper);
        assertTrue(slashed);
        // a slashed keyper can no longer release
        vm.warp(_at(12));
        vm.expectRevert(HourglassRegistry.KeyperSlashed_.selector);
        reg.release(keyper, 12, seeds[12]);
    }

    function test_report_cannotBeFrontRun() public {
        _register();
        bytes32 salt = keccak256("salt");
        bytes32 c = reg.reportCommitment(keyper, 12, seeds[12], salt, reporter);
        vm.prank(reporter);
        reg.commitReport(c);
        // attacker copies the reveal from the mempool
        vm.prank(attacker);
        vm.expectRevert(HourglassRegistry.NoCommitment.selector);
        reg.revealReport(keyper, 12, seeds[12], salt);
    }

    function test_report_afterRoundTimeIsNotEvidence() public {
        _register();
        vm.warp(_at(6));
        bytes32 salt = keccak256("s");
        bytes32 c = reg.reportCommitment(keyper, 6, seeds[6], salt, reporter);
        vm.prank(reporter);
        reg.commitReport(c);
        vm.prank(reporter);
        vm.expectRevert(HourglassRegistry.NotEarly.selector);
        reg.revealReport(keyper, 6, seeds[6], salt);
    }

    // ------------------------------------------------------------ exit / Q-Day drill posture
    function test_withdraw_requiresPqcExitDelayAndBoundRecipient() public {
        _register();
        address safe = makeAddr("safe");
        reg.requestExit(keyper, _sig(reg.exitDigest(keyper)));
        bytes memory sigForSafe = _sig(reg.withdrawDigest(keyper, safe));
        vm.expectRevert(HourglassRegistry.ExitPending.selector);
        reg.withdraw(keyper, safe, sigForSafe);
        vm.warp(block.timestamp + EXIT_DELAY);
        // a signature for `safe` cannot be redirected to the attacker
        vm.expectRevert(HourglassRegistry.BadPqcSignature.selector);
        reg.withdraw(keyper, attacker, sigForSafe);
        reg.withdraw(keyper, safe, sigForSafe);
        assertEq(safe.balance, MIN_BOND);
    }

    /// The drill bot holds the keyper's ECDSA key, i.e. can send any tx *as* the keyper,
    /// but has no ML-DSA-87 signature. Nothing it can do moves the bond.
    function test_qdayDrill_classicalKeyAloneCannotDrain() public {
        _register();
        vm.startPrank(keyper);
        vm.expectRevert(HourglassRegistry.BadPqcSignature.selector);
        reg.requestExit(keyper, hex"00");
        vm.expectRevert(HourglassRegistry.ExitNotRequested.selector);
        reg.withdraw(keyper, attacker, hex"00");
        vm.expectRevert(HourglassRegistry.TooEarly.selector);
        reg.release(keyper, 1, seeds[1]); // even with a real seed, not before time
        vm.stopPrank();
        assertEq(address(reg).balance, MIN_BOND);
    }

    // ------------------------------------------------------------ v2 regressions (audit, 20 Nov)
    /// Audit M1: re-registering left exitAt/nextRound stale, so the old public withdraw signature
    /// could be replayed to pull a fresh bond out at once. v2 retires a keyper on withdrawal.
    function test_v2_withdrawnKeyperCanNeverReRegister() public {
        _register();
        reg.requestExit(keyper, _sig(reg.exitDigest(keyper)));
        vm.warp(block.timestamp + EXIT_DELAY);
        reg.withdraw(keyper, keyper, _sig(reg.withdrawDigest(keyper, keyper)));
        assertTrue(reg.retired(keyper));
        bytes32 d = reg.registerDigest(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N);
        vm.expectRevert(HourglassRegistry.AlreadyRegistered.selector);
        reg.register{value: MIN_BOND}(keyper, _anchor(), bytes32("pkroot"), genesis, ROUND_SECONDS, N, _sig(d));
    }

    function test_v2_oldWithdrawSignatureCannotBeReplayed() public {
        _register();
        reg.requestExit(keyper, _sig(reg.exitDigest(keyper)));
        vm.warp(block.timestamp + EXIT_DELAY);
        bytes memory sig = _sig(reg.withdrawDigest(keyper, keyper));
        reg.withdraw(keyper, keyper, sig);
        vm.prank(attacker);
        vm.expectRevert(HourglassRegistry.NotRegistered.selector);
        reg.withdraw(keyper, keyper, sig);
    }
}
