// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {AntseedWashTradingRegistry} from "../integrity/AntseedWashTradingRegistry.sol";

contract DeployWashTradingRegistry is Script {
    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(
            vm.envAddress("SP1_VERIFIER"),
            vm.envAddress("CHAINLINK_BLOCKHASH_STORE"),
            vm.envBytes32("WASH_TRADING_SELLER_AGGREGATOR_PROGRAM_VKEY"),
            vm.envBytes32("WASH_TRADING_CLOSED_LOOP_PROGRAM_VKEY"),
            vm.envBytes32("WASH_TRADING_RECIPROCAL_PROGRAM_VKEY"),
            uint64(vm.envUint("HISTORICAL_PERIOD_START_BLOCK")),
            uint64(vm.envUint("HISTORICAL_PERIOD_END_BLOCK"))
        );
        vm.stopBroadcast();

        console.log("AntseedWashTradingRegistry:", address(registry));
    }
}
