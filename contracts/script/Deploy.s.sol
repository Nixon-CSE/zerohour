// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HourglassRegistry} from "../src/HourglassRegistry.sol";

/// forge script script/Deploy.s.sol --rpc-url qorechain_testnet --broadcast
/// Needs an open (unscoped) EVM window for the deployer — see scripts/drill.ts.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 minBond = vm.envOr("MIN_BOND", uint256(1 ether)); // 1 QOR
        uint256 exitDelay = vm.envOr("EXIT_DELAY", uint256(1 days));
        vm.startBroadcast(pk);
        HourglassRegistry reg = new HourglassRegistry(minBond, exitDelay);
        vm.stopBroadcast();
        console.log("HourglassRegistry:", address(reg));
    }
}
