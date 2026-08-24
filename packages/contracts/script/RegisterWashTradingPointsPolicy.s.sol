// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

/**
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   POINTS_POLICY_REGISTRY
 *   WASH_TRADING_REGISTRY
 */
contract RegisterWashTradingPointsPolicy is Script {
    function run() external returns (AntseedWashTradingPointsPolicy washTradingPointsPolicy) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address pointsPolicyRegistryAddress = vm.envAddress("POINTS_POLICY_REGISTRY");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        require(pointsPolicyRegistryAddress.code.length != 0, "points registry has no code");
        require(washTradingRegistry.code.length != 0, "wash registry has no code");

        AntseedPointsPolicyRegistry pointsPolicyRegistry = AntseedPointsPolicyRegistry(pointsPolicyRegistryAddress);
        vm.startBroadcast(deployerPrivateKey);
        washTradingPointsPolicy = new AntseedWashTradingPointsPolicy(washTradingRegistry);
        require(washTradingPointsPolicy.configurationFinalized(), "wash penalty calibration unfinished");
        pointsPolicyRegistry.registerPolicy(address(washTradingPointsPolicy));
        vm.stopBroadcast();

        require(
            pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy)),
            "wash points policy not registered"
        );
        require(address(washTradingPointsPolicy.washTradingStatus()) == washTradingRegistry, "wash registry mismatch");
        console.log("PointsPolicyRegistry:    ", pointsPolicyRegistryAddress);
        console.log("WashTradingPointsPolicy:", address(washTradingPointsPolicy));
        console.log("WashTradingRegistry:    ", washTradingRegistry);
    }
}
