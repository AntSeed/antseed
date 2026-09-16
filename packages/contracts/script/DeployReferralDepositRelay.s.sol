// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedReferralDepositRelay } from "../payments/AntseedReferralDepositRelay.sol";

/**
 * Deploys the sweep relay that atomically submits buyer referral bindings.
 */
contract DeployReferralDepositRelay is Script {
    function run() external returns (AntseedReferralDepositRelay relay) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_TOKEN");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");
        address referrals = vm.envAddress("ANTSEED_REFERRALS");
        uint256 fee = vm.envUint("DEPOSIT_RELAY_FEE");

        vm.startBroadcast(deployerPrivateKey);
        relay = new AntseedReferralDepositRelay(usdc, deposits, fee, referrals);
        vm.stopBroadcast();

        console.log("AntseedReferralDepositRelay:", address(relay));
        console.log("Set payments.crypto.depositRelayAddress to this address.");
    }
}
