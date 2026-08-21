// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";

/**
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   WASH_TRADING_REWARD_POLICY
 *   PROOF_RELEASE_DIGEST
 */
contract FinalizeSellerRewardBackfill is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address policyAddress = vm.envAddress("WASH_TRADING_REWARD_POLICY");
        bytes32 proofReleaseDigest = vm.envBytes32("PROOF_RELEASE_DIGEST");
        require(policyAddress.code.length != 0, "wash trading reward policy has no code");
        require(proofReleaseDigest != bytes32(0), "proof release digest is zero");

        AntseedWashTradingRewardPolicy policy = AntseedWashTradingRewardPolicy(policyAddress);
        vm.startBroadcast(deployerPrivateKey);
        policy.finalizeBackfill(proofReleaseDigest);
        vm.stopBroadcast();

        require(policy.backfillFinalized(), "backfill not finalized");
        require(policy.proofReleaseDigest() == proofReleaseDigest, "proof release digest mismatch");
        console.log("WashTradingRewardPolicy:", policyAddress);
        console.logBytes32(proofReleaseDigest);
    }
}
