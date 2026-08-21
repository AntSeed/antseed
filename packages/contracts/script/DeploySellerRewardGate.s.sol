// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedHistoricalClaimsPolicy } from "../policies/AntseedHistoricalClaimsPolicy.sol";
import { AntseedSellerRewardPolicyRegistry } from "../policies/AntseedSellerRewardPolicyRegistry.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

/**
 * @notice Installs a bounded seller-reward policy registry while preserving
 *         the policies already configured on both seller claim routes.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   BASE_STATE_ORACLE
 *   WASH_TRADING_REGISTRY
 */
contract DeploySellerRewardGate is Script {
    function run()
        external
        returns (
            AntseedSellerRewardPolicyRegistry rewardPolicyRegistry,
            AntseedHistoricalClaimsPolicy historicalClaimsPolicy,
            AntseedWashTradingRewardPolicy washTradingRewardPolicy
        )
    {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address baseStateOracle = vm.envAddress("BASE_STATE_ORACLE");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        require(registryAddress.code.length != 0, "protocol registry has no code");
        require(baseStateOracle.code.length != 0, "base state oracle has no code");
        require(washTradingRegistry.code.length != 0, "wash registry has no code");

        IAntseedRegistry protocolRegistry = IAntseedRegistry(registryAddress);
        address emissionsAddress = protocolRegistry.emissions();
        require(emissionsAddress.code.length != 0, "emissions has no code");
        AntseedEmissionsV2 emissions = AntseedEmissionsV2(emissionsAddress);
        address rewardsPoolAddress = address(emissions.sellerRewardsPool());
        require(rewardsPoolAddress.code.length != 0, "seller rewards pool has no code");
        AntseedSellerRewardsPool rewardsPool = AntseedSellerRewardsPool(rewardsPoolAddress);
        require(emissions.owner() == deployer, "deployer must own emissions");
        require(rewardsPool.owner() == deployer, "deployer must own rewards pool");

        address existingUnlockPolicy = address(emissions.sellerUnlockPolicy());
        address existingClaimPolicy = address(rewardsPool.sellerClaimPolicy());

        vm.startBroadcast(deployerPrivateKey);
        rewardPolicyRegistry = new AntseedSellerRewardPolicyRegistry(deployer);
        historicalClaimsPolicy = new AntseedHistoricalClaimsPolicy(baseStateOracle, deployer);
        washTradingRewardPolicy = new AntseedWashTradingRewardPolicy(washTradingRegistry);

        if (existingUnlockPolicy != address(0) && existingUnlockPolicy == existingClaimPolicy) {
            rewardPolicyRegistry.registerPolicy(existingUnlockPolicy, true, true);
        } else {
            if (existingUnlockPolicy != address(0)) {
                rewardPolicyRegistry.registerPolicy(existingUnlockPolicy, true, false);
            }
            if (existingClaimPolicy != address(0)) {
                rewardPolicyRegistry.registerPolicy(existingClaimPolicy, false, true);
            }
        }
        rewardPolicyRegistry.registerPolicy(address(historicalClaimsPolicy), true, true);
        rewardPolicyRegistry.registerPolicy(address(washTradingRewardPolicy), true, true);

        emissions.setSellerUnlockPolicy(address(rewardPolicyRegistry));
        rewardsPool.setSellerClaimPolicy(address(rewardPolicyRegistry));
        vm.stopBroadcast();

        require(address(emissions.sellerUnlockPolicy()) == address(rewardPolicyRegistry), "emissions policy mismatch");
        require(address(rewardsPool.sellerClaimPolicy()) == address(rewardPolicyRegistry), "pool policy mismatch");
        require(
            rewardPolicyRegistry.isPolicyRegistered(address(historicalClaimsPolicy)), "historical policy not registered"
        );
        require(rewardPolicyRegistry.isPolicyRegistered(address(washTradingRewardPolicy)), "wash policy not registered");
        if (existingUnlockPolicy != address(0)) {
            require(rewardPolicyRegistry.isPolicyRegistered(existingUnlockPolicy), "unlock policy not preserved");
        }
        if (existingClaimPolicy != address(0)) {
            require(rewardPolicyRegistry.isPolicyRegistered(existingClaimPolicy), "claim policy not preserved");
        }

        console.log("SellerRewardPolicyRegistry:", address(rewardPolicyRegistry));
        console.log("HistoricalClaimsPolicy:    ", address(historicalClaimsPolicy));
        console.log("WashTradingRewardPolicy:   ", address(washTradingRewardPolicy));
        console.log("AntseedEmissionsV2:        ", emissionsAddress);
        console.log("SellerRewardsPool:         ", rewardsPoolAddress);
        console.log("BaseStateOracle:           ", baseStateOracle);
        console.log("WashTradingRegistry:       ", washTradingRegistry);
    }
}
