// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HourglassRegistry} from "../src/HourglassRegistry.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/MockPqc.sol";

/// A whistleblower contract that, when paid its reward, re-enters the registry to try to be paid again
/// (`forge lint` flags the event after the external call in revealReport; this proves the call cannot be abused).
contract GreedyReporter {
    HourglassRegistry immutable reg;
    address keyper;
    uint32 round;
    bytes32 seed;
    bytes32 salt;
    uint256 public reentries;
    bool public reentryReverted;

    constructor(HourglassRegistry r) {
        reg = r;
    }

    function commit(address k, uint32 r, bytes32 s, bytes32 sa) external {
        (keyper, round, seed, salt) = (k, r, s, sa);
        reg.commitReport(reg.reportCommitment(k, r, s, sa, address(this)));
    }

    function reveal() external {
        reg.revealReport(keyper, round, seed, salt);
    }

    receive() external payable {
        if (reentries++ > 0) return;
        // Second reveal of the same report, mid-payout: must not pay twice.
        try reg.revealReport(keyper, round, seed, salt) {} catch { reentryReverted = true; }
    }
}

contract ReentrancyTest is Test {
    HourglassRegistry reg;
    address keyper = makeAddr("keyper");
    bytes keyperPk = hex"aa11bb22cc33";
    uint32 constant N = 20;
    uint32 constant ROUND_SECONDS = 60;
    uint64 genesis;
    bytes32[] seeds;

    function setUp() public {
        vm.etch(address(0x0A01), address(new MockPqcVerify()).code);
        vm.etch(address(0x0A02), address(new MockPqcKeyStatus()).code);
        MockPqcKeyStatus(address(0x0A02)).setKey(keyper, keyperPk);
        reg = new HourglassRegistry(1 ether, 7 days);
        genesis = uint64(block.timestamp + 1 hours);
        seeds = new bytes32[](N + 1);
        seeds[N] = keccak256("top secret seed");
        for (uint256 r = N; r > 0; r--) seeds[r - 1] = keccak256(abi.encodePacked(seeds[r]));
        bytes32 anchor = keccak256(abi.encodePacked(seeds[0]));
        bytes32 d = reg.registerDigest(keyper, anchor, bytes32("pkroot"), genesis, ROUND_SECONDS, N);
        vm.deal(keyper, 10 ether);
        reg.register{value: 1 ether}(keyper, anchor, bytes32("pkroot"), genesis, ROUND_SECONDS, N, abi.encodePacked(keccak256(abi.encodePacked(keyperPk, abi.encodePacked(d)))));
    }

    function test_slashingPayoutCannotBeReentered() public {
        GreedyReporter g = new GreedyReporter(reg);
        g.commit(keyper, 12, seeds[12], keccak256("salt"));
        vm.roll(block.number + 1);
        g.reveal();
        // Paid exactly once, half the bond; the other half burned; the registry keeps nothing it should not.
        assertEq(address(g).balance, 0.5 ether);
        assertEq(reg.BURN().balance, 0.5 ether);
        assertEq(address(reg).balance, 0);
        assertEq(g.reentries(), 1);
        assertTrue(g.reentryReverted(), "the re-entrant reveal must revert");
        (,,,,,,, uint128 bond,, bool slashed,) = reg.keypers(keyper);
        assertEq(bond, 0);
        assertTrue(slashed);
    }
}
