// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";

contract DeployBaseHistoricalAccumulatorOracle is Script {
    function run() external returns (AntseedBaseCheckpointOracle oracle) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envAddress("RISC0_VERIFIER");
        bytes32 epochImageId = vm.envBytes32("HISTORY_EPOCH_IMAGE_ID");
        bytes32 accumulatorImageId = vm.envBytes32("HISTORY_ACCUMULATOR_IMAGE_ID");

        vm.startBroadcast(deployerPrivateKey);
        oracle = new AntseedBaseCheckpointOracle(verifier, epochImageId, accumulatorImageId);
        vm.stopBroadcast();

        console.log("AntseedBaseCheckpointOracle:", address(oracle));
        console.logBytes32(epochImageId);
        console.logBytes32(accumulatorImageId);
    }
}
