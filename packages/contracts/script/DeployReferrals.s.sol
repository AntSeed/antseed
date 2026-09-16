// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

/**
 * @title DeployReferrals
 * @notice Deploys the Foundation-funded referral rewards contract.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTS_TOKEN
 *   USAGE_ACCOUNTING
 *   USAGE_REWARDS
 *   ANTSEED_DEPOSITS
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployReferrals.s.sol --rpc-url $BASE_MAINNET_RPC_URL --broadcast --verify --via-ir
 */
contract DeployReferrals is Script {
    function run() external returns (AntseedReferrals referrals) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address ants = vm.envAddress("ANTS_TOKEN");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address usageRewards = vm.envAddress("USAGE_REWARDS");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");

        vm.startBroadcast(deployerPrivateKey);
        referrals = new AntseedReferrals(ants, usageAccounting, usageRewards, deposits);
        vm.stopBroadcast();

        console.log("AntseedReferrals:", address(referrals));
        console.log("Referral rate (bps):", referrals.referralRateBps());
        console.log("Fund the contract with Foundation ANTS, then set payments.crypto.referralsAddress.");
    }
}
