// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

/**
 * @notice Installs the wash-trading policy on both seller reward routes.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   BASE_STATE_ORACLE
 *   WASH_TRADING_REGISTRY
 */
contract DeploySellerRewardGate is Script {
    function run() external returns (AntseedWashTradingRewardPolicy washTradingRewardPolicy) {
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

        vm.startBroadcast(deployerPrivateKey);
        washTradingRewardPolicy = new AntseedWashTradingRewardPolicy(washTradingRegistry, baseStateOracle, deployer);
        emissions.setSellerUnlockPolicy(address(washTradingRewardPolicy));
        rewardsPool.setSellerClaimPolicy(address(washTradingRewardPolicy));
        vm.stopBroadcast();

        require(
            address(emissions.sellerUnlockPolicy()) == address(washTradingRewardPolicy), "emissions policy mismatch"
        );
        require(address(rewardsPool.sellerClaimPolicy()) == address(washTradingRewardPolicy), "pool policy mismatch");

        console.log("WashTradingRewardPolicy:", address(washTradingRewardPolicy));
        console.log("AntseedEmissionsV2:     ", emissionsAddress);
        console.log("SellerRewardsPool:      ", rewardsPoolAddress);
        console.log("BaseStateOracle:        ", baseStateOracle);
        console.log("WashTradingRegistry:    ", washTradingRegistry);
    }
}
