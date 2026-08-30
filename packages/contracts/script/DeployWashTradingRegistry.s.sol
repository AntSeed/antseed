// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract DeployWashTradingRegistry is Script {
    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 ownerPrivateKey = vm.envUint("WASH_REGISTRY_OWNER_PRIVATE_KEY");
        address owner = vm.addr(ownerPrivateKey);

        vm.startBroadcast(ownerPrivateKey);
        registry = new AntseedWashTradingRegistry(
            owner, vm.envAddress("SP1_VERIFIER"), vm.envAddress("BLOCKHASH_STORE"), vm.envAddress("EMISSIONS_V2")
        );
        registry.registerChildProgram(
            vm.envBytes32("CLOSED_LOOP_PROGRAM_ID"),
            vm.envBytes32("CLOSED_LOOP_PROGRAM_VKEY"),
            vm.envBytes32("WASH_VOLUME_SOURCE_ID")
        );
        registry.registerChildProgram(
            vm.envBytes32("RECIPROCAL_PROGRAM_ID"),
            vm.envBytes32("RECIPROCAL_PROGRAM_VKEY"),
            vm.envBytes32("WASH_VOLUME_SOURCE_ID")
        );
        registry.registerAggregatorProgram(
            vm.envBytes32("AGGREGATOR_PROGRAM_ID"), vm.envBytes32("AGGREGATOR_PROGRAM_VKEY")
        );
        vm.stopBroadcast();

        console.log("WashTradingRegistry:", address(registry));
    }
}
