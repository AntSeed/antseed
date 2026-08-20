// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

/**
 * @title RegisterWashTradingPointsPolicy
 * @notice Deploys the adapter for an existing wash-trading proof registry,
 *         registers it in the configured points-policy registry, and verifies
 *         every pointer before returning.
 *
 * Required env:
 *   POINTS_POLICY_REGISTRY_OWNER_PRIVATE_KEY
 *   POINTS_POLICY_REGISTRY
 *   WASH_TRADING_REGISTRY
 */
contract RegisterWashTradingPointsPolicy is Script {
    function run() external returns (AntseedWashTradingPointsPolicy policy) {
        uint256 ownerPrivateKey = vm.envUint("POINTS_POLICY_REGISTRY_OWNER_PRIVATE_KEY");
        address expectedOwner = vm.addr(ownerPrivateKey);
        AntseedPointsPolicyRegistry pointsRegistry =
            AntseedPointsPolicyRegistry(vm.envAddress("POINTS_POLICY_REGISTRY"));
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");

        require(pointsRegistry.owner() == expectedOwner, "private key is not points registry owner");
        require(washTradingRegistry != address(0), "wash trading registry is zero");

        vm.startBroadcast(ownerPrivateKey);
        policy = new AntseedWashTradingPointsPolicy(washTradingRegistry);
        pointsRegistry.registerPolicy(address(policy));
        vm.stopBroadcast();

        require(pointsRegistry.isPolicyRegistered(address(policy)), "wash policy was not registered");
        require(
            pointsRegistry.policyCategory(address(policy)) == policy.PENALTY_CATEGORY(), "wash policy category mismatch"
        );
        require(address(policy.registry()) == washTradingRegistry, "wash registry pointer mismatch");

        console.log("PointsPolicyRegistry:    ", address(pointsRegistry));
        console.log("WashTradingRegistry:     ", washTradingRegistry);
        console.log("WashTradingPointsPolicy: ", address(policy));
        console.log("Seller/buyer penalty source: registry");
    }
}
