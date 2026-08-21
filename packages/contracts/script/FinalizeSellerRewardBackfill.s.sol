// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { AntseedSellerRewardPolicyRegistry } from "../policies/AntseedSellerRewardPolicyRegistry.sol";

/**
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SELLER_REWARD_POLICY_REGISTRY
 *   PROOF_RELEASE_DIGEST
 */
contract FinalizeSellerRewardBackfill is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddress = vm.envAddress("SELLER_REWARD_POLICY_REGISTRY");
        bytes32 proofReleaseDigest = vm.envBytes32("PROOF_RELEASE_DIGEST");
        require(registryAddress.code.length != 0, "seller reward registry has no code");
        require(proofReleaseDigest != bytes32(0), "proof release digest is zero");

        AntseedSellerRewardPolicyRegistry registry = AntseedSellerRewardPolicyRegistry(registryAddress);
        vm.startBroadcast(deployerPrivateKey);
        registry.finalizeBackfill(proofReleaseDigest);
        vm.stopBroadcast();

        require(registry.backfillFinalized(), "backfill not finalized");
        require(registry.proofReleaseDigest() == proofReleaseDigest, "proof release digest mismatch");
        console.log("SellerRewardPolicyRegistry:", registryAddress);
        console.logBytes32(proofReleaseDigest);
    }
}
