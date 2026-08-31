// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract DeployWashTradingRegistry is Script {
    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("HISTORICAL_AGGREGATOR_PROGRAM_VKEY"),
            vm.envBytes32("HISTORICAL_REPORT_ROOT"),
            vm.envBytes32("HISTORICAL_MANIFEST_DIGEST"),
            uint64(vm.envUint("HISTORICAL_PERIOD_START_BLOCK")),
            uint64(vm.envUint("HISTORICAL_PERIOD_END_BLOCK")),
            uint32(vm.envUint("HISTORICAL_SOURCE_CLAIM_COUNT")),
            uint32(vm.envUint("HISTORICAL_SELLER_COUNT")),
            uint128(vm.envUint("HISTORICAL_TOTAL_PROVEN_WASH_VOLUME"))
        );
        vm.stopBroadcast();

        console.log("HistoricalWashTradingRegistry:", address(registry));
    }
}
