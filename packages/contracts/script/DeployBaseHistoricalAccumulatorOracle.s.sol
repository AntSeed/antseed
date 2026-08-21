// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";

contract DeployBaseHistoricalAccumulatorOracle is Script {
    address internal constant BASE_SP1_GROTH16_VERIFIER_GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    function run() external returns (AntseedBaseCheckpointOracle oracle) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("SP1_VERIFIER", BASE_SP1_GROTH16_VERIFIER_GATEWAY);
        bytes32 epochRecursionVKey = vm.envBytes32("HISTORY_EPOCH_RECURSION_VKEY");
        bytes32 accumulatorProgramVKey = vm.envBytes32("HISTORY_ACCUMULATOR_PROGRAM_VKEY");

        vm.startBroadcast(deployerPrivateKey);
        oracle = new AntseedBaseCheckpointOracle(verifier, epochRecursionVKey, accumulatorProgramVKey);
        vm.stopBroadcast();

        console.log("AntseedBaseCheckpointOracle:", address(oracle));
        console.logBytes32(epochRecursionVKey);
        console.logBytes32(accumulatorProgramVKey);
    }
}
