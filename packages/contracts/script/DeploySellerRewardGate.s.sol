// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

/**
 * @notice Deploys one immutable wash-trading reward policy and configures it
 *         on both the locked rewards pool and the immediate emissions route.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   WASH_TRADING_REGISTRY
 */
contract DeploySellerRewardGate is Script {
    function run() external returns (AntseedWashTradingRewardPolicy policy) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        require(registryAddress.code.length != 0, "protocol registry has no code");
        require(washTradingRegistry.code.length != 0, "wash registry has no code");

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address emissionsAddress = registry.emissions();
        require(emissionsAddress.code.length != 0, "emissions has no code");
        AntseedEmissionsV2 emissions = AntseedEmissionsV2(emissionsAddress);
        address rewardsPoolAddress = address(emissions.sellerRewardsPool());
        require(rewardsPoolAddress.code.length != 0, "seller rewards pool has no code");
        AntseedSellerRewardsPool rewardsPool = AntseedSellerRewardsPool(rewardsPoolAddress);

        vm.startBroadcast(deployerPrivateKey);
        policy = new AntseedWashTradingRewardPolicy(washTradingRegistry);
        rewardsPool.setSellerClaimPolicy(address(policy));
        emissions.setSellerUnlockPolicy(address(policy));
        vm.stopBroadcast();

        require(address(policy.washTradingRegistry()) == washTradingRegistry, "policy wash registry mismatch");
        require(address(rewardsPool.sellerClaimPolicy()) == address(policy), "pool policy mismatch");
        require(address(emissions.sellerUnlockPolicy()) == address(policy), "emissions policy mismatch");

        console.log("WashTradingRewardPolicy:", address(policy));
        console.log("AntseedEmissionsV2:  ", emissionsAddress);
        console.log("SellerRewardsPool:   ", rewardsPoolAddress);
        console.log("WashTradingRegistry: ", washTradingRegistry);
    }
}
