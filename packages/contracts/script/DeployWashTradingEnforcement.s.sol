// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

/**
 * @title DeployWashTradingEnforcement
 * @notice Deploys the proof-backed wash-trading registry.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   BASE_STATE_ORACLE
 *   CLOSED_LOOP_VKEY
 *   RECIPROCAL_VKEY
 */
contract DeployWashTradingEnforcement is Script {
    address internal constant BASE_SP1_GROTH16_VERIFIER_GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("SP1_VERIFIER", BASE_SP1_GROTH16_VERIFIER_GATEWAY);
        address stateOracle = vm.envAddress("BASE_STATE_ORACLE");
        require(stateOracle.code.length != 0, "state oracle has no code");
        bytes32 closedLoopVKey = vm.envBytes32("CLOSED_LOOP_VKEY");
        bytes32 reciprocalVKey = vm.envBytes32("RECIPROCAL_VKEY");

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(verifier, stateOracle, closedLoopVKey, reciprocalVKey);
        vm.stopBroadcast();

        console.log("WashTradingRegistry:", address(registry));
        console.log("SP1Verifier:        ", verifier);
        console.log("BaseStateOracle:    ", stateOracle);
    }
}
