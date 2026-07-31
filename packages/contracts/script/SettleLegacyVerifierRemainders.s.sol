// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { IAntseedLegacyVerifierRewards } from "../interfaces/IAntseedLegacyVerifierRewards.sol";

contract SettleLegacyVerifierRemainders is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address controller = vm.envAddress("LEGACY_VERIFIER_REWARDS");
        uint256[] memory epochs = vm.envUint("LEGACY_FINALIZED_EPOCHS", ",");
        require(controller != address(0) && controller.code.length != 0, "legacy controller not set");
        require(epochs.length != 0, "no finalized epochs");

        vm.startBroadcast(deployerPrivateKey);
        for (uint256 i = 0; i < epochs.length; i++) {
            try IAntseedLegacyVerifierRewards(controller).settleEpochRemainder(epochs[i]) returns (
                uint256 burnedAmount, uint256 reserveAmount
            ) {
                console.log("Settled legacy verifier epoch:", epochs[i]);
                console.log("Burned:", burnedAmount);
                console.log("Reserved:", reserveAmount);
            } catch (bytes memory reason) {
                console.log("Failed legacy verifier epoch:", epochs[i]);
                console.logBytes(reason);
            }
        }
        vm.stopBroadcast();
    }
}
