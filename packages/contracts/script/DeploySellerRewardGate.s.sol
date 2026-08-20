// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardEligibilityPolicy } from "../policies/AntseedSellerRewardEligibilityPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

/**
 * @notice Deploys one immutable P0-or-inactive seller policy and configures it
 *         on both the locked rewards pool and the immediate emissions route.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   WASH_TRADING_REGISTRY
 *   INACTIVE_SELLERS_FILE
 */
contract DeploySellerRewardGate is Script {
    using stdJson for string;

    function run() external returns (AntseedSellerRewardEligibilityPolicy policy) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        string memory snapshotFile = vm.envString("INACTIVE_SELLERS_FILE");
        string memory snapshotJson = vm.readFile(snapshotFile);
        require(snapshotJson.readUint(".chainId") == block.chainid, "inactive snapshot chain mismatch");
        require(
            keccak256(bytes(snapshotJson.readString(".kind")))
                == keccak256("antseed-permanent-inactive-seller-snapshot"),
            "invalid inactive snapshot"
        );
        address[] memory inactiveSellers = snapshotJson.readAddressArray(".inactiveSellers");
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
        policy = new AntseedSellerRewardEligibilityPolicy(registryAddress, washTradingRegistry, inactiveSellers);
        rewardsPool.setSellerClaimPolicy(address(policy));
        emissions.setSellerUnlockPolicy(address(policy));
        vm.stopBroadcast();

        require(address(policy.registry()) == registryAddress, "policy registry mismatch");
        require(address(policy.washTradingRegistry()) == washTradingRegistry, "policy wash registry mismatch");
        require(policy.inactiveSellerCount() == inactiveSellers.length, "inactive snapshot count mismatch");
        for (uint256 index = 0; index < inactiveSellers.length; index++) {
            require(policy.inactiveLastSettledAt(inactiveSellers[index]) != 0, "inactive seller missing");
        }
        require(address(rewardsPool.sellerClaimPolicy()) == address(policy), "pool policy mismatch");
        require(address(emissions.sellerUnlockPolicy()) == address(policy), "emissions policy mismatch");

        console.log("SellerRewardEligibilityPolicy:", address(policy));
        console.log("AntseedEmissionsV2:           ", emissionsAddress);
        console.log("SellerRewardsPool:            ", rewardsPoolAddress);
        console.log("WashTradingRegistry:          ", washTradingRegistry);
        console.log("Permanent inactive sellers:  ", inactiveSellers.length);
        console.logBytes32(policy.inactiveSellerSnapshotHash());
    }
}
