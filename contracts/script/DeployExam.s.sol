// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HourglassRegistry} from "../src/HourglassRegistry.sol";
import {ZeroHourExam} from "../src/ZeroHourExam.sol";

/// HOURGLASS=0x… forge script script/DeployExam.s.sol --rpc-url qorechain_testnet --broadcast
contract DeployExam is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address hourglass = vm.envOr("HOURGLASS", address(0x5CF8c43C52483bF09F9a32D07a614250bd60f1AA));
        vm.startBroadcast(pk);
        ZeroHourExam zh = new ZeroHourExam(HourglassRegistry(hourglass));
        vm.stopBroadcast();
        console.log("ZeroHourExam:", address(zh));
    }
}
