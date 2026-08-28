// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

/**
 * @notice Deploys or reuses the wash-trading policy leaves and optionally
 *         installs them on the shared points registry and legacy reward paths.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   POINTS_POLICY_REGISTRY
 *   WASH_TRADING_REGISTRY
 *
 * Optional env:
 *   WASH_TRADING_POINTS_POLICY  Existing points policy to reuse.
 *   WASH_TRADING_REWARD_POLICY  Existing reward policy to reuse.
 *   REGISTER_WASH_POLICY        Defaults to true.
 *   INSTALL_WASH_REWARD_POLICY  Defaults to true.
 */
contract ConfigureWashTradingPolicies is Script {
    function run()
        external
        returns (
            AntseedWashTradingPointsPolicy washTradingPointsPolicy,
            AntseedWashTradingRewardPolicy washTradingRewardPolicy
        )
    {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address pointsPolicyRegistryAddress = vm.envAddress("POINTS_POLICY_REGISTRY");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        address pointsPolicyAddress = vm.envOr("WASH_TRADING_POINTS_POLICY", address(0));
        address rewardPolicyAddress = vm.envOr("WASH_TRADING_REWARD_POLICY", address(0));
        bool registerWashPolicy = vm.envOr("REGISTER_WASH_POLICY", true);
        bool installWashRewardPolicy = vm.envOr("INSTALL_WASH_REWARD_POLICY", true);

        require(registryAddress.code.length != 0, "protocol registry has no code");
        require(pointsPolicyRegistryAddress.code.length != 0, "points registry has no code");
        require(washTradingRegistry.code.length != 0, "wash registry has no code");

        IAntseedRegistry protocolRegistry = IAntseedRegistry(registryAddress);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = AntseedPointsPolicyRegistry(pointsPolicyRegistryAddress);
        address emissionsAddress = protocolRegistry.emissions();
        require(emissionsAddress.code.length != 0, "emissions has no code");
        AntseedEmissionsV2 emissions = AntseedEmissionsV2(emissionsAddress);
        address rewardsPoolAddress = address(emissions.sellerRewardsPool());
        require(rewardsPoolAddress.code.length != 0, "seller rewards pool has no code");
        AntseedSellerRewardsPool rewardsPool = AntseedSellerRewardsPool(rewardsPoolAddress);

        if (pointsPolicyAddress != address(0)) {
            require(pointsPolicyAddress.code.length != 0, "wash points policy has no code");
            washTradingPointsPolicy = AntseedWashTradingPointsPolicy(pointsPolicyAddress);
            _validatePointsPolicy(washTradingPointsPolicy, washTradingRegistry);
        }
        if (rewardPolicyAddress != address(0)) {
            require(rewardPolicyAddress.code.length != 0, "wash reward policy has no code");
            washTradingRewardPolicy = AntseedWashTradingRewardPolicy(rewardPolicyAddress);
            _validateRewardPolicy(washTradingRewardPolicy, washTradingRegistry);
        }

        bool needsPointsRegistration = registerWashPolicy
            && (pointsPolicyAddress == address(0) || !pointsPolicyRegistry.isPolicyRegistered(pointsPolicyAddress));
        if (needsPointsRegistration) {
            require(pointsPolicyRegistry.owner() == deployer, "deployer must own points registry");
        }
        if (installWashRewardPolicy) {
            require(emissions.owner() == deployer, "deployer must own emissions");
            require(rewardsPool.owner() == deployer, "deployer must own rewards pool");
        }

        vm.startBroadcast(deployerPrivateKey);
        if (address(washTradingPointsPolicy) == address(0)) {
            washTradingPointsPolicy = new AntseedWashTradingPointsPolicy(washTradingRegistry);
        }
        if (address(washTradingRewardPolicy) == address(0)) {
            washTradingRewardPolicy = new AntseedWashTradingRewardPolicy(washTradingRegistry);
        }
        _validatePointsPolicy(washTradingPointsPolicy, washTradingRegistry);
        _validateRewardPolicy(washTradingRewardPolicy, washTradingRegistry);

        if (registerWashPolicy && !pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy))) {
            pointsPolicyRegistry.registerPolicy(address(washTradingPointsPolicy));
        }
        if (installWashRewardPolicy) {
            if (address(emissions.sellerUnlockPolicy()) != address(washTradingRewardPolicy)) {
                emissions.setSellerUnlockPolicy(address(washTradingRewardPolicy));
            }
            if (address(rewardsPool.sellerClaimPolicy()) != address(washTradingRewardPolicy)) {
                rewardsPool.setSellerClaimPolicy(address(washTradingRewardPolicy));
            }
        }
        vm.stopBroadcast();

        console.log("PointsPolicyRegistry:     ", pointsPolicyRegistryAddress);
        console.log("WashTradingRegistry:     ", washTradingRegistry);
        console.log("WashTradingPointsPolicy: ", address(washTradingPointsPolicy));
        console.log("WashTradingRewardPolicy: ", address(washTradingRewardPolicy));
        console.log(
            "Points policy registered:", pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy))
        );
        console.log(
            "Reward policy installed: ",
            address(emissions.sellerUnlockPolicy()) == address(washTradingRewardPolicy)
                && address(rewardsPool.sellerClaimPolicy()) == address(washTradingRewardPolicy)
        );
    }

    function _validatePointsPolicy(AntseedWashTradingPointsPolicy policy, address washTradingRegistry) private view {
        require(address(policy.washTradingStatus()) == washTradingRegistry, "wash points registry mismatch");
        require(policy.configurationFinalized(), "wash penalty calibration unfinished");
    }

    function _validateRewardPolicy(AntseedWashTradingRewardPolicy policy, address washTradingRegistry) private view {
        require(address(policy.washTradingStatus()) == washTradingRegistry, "wash reward registry mismatch");
        require(policy.configurationFinalized(), "wash penalty calibration unfinished");
    }
}
