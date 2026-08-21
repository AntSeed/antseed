// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";

/**
 * @title DeployWashTradingEnforcement
 * @notice Deploys the immutable proof-backed wash-trading status registry
 *         against the existing canonical Base block oracle.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SP1_VERIFIER
 *   BASE_STATE_ORACLE
 *   CLOSED_CYCLE_PROGRAM_VKEY
 *   RECIPROCAL_PROGRAM_VKEY
 */
contract DeployWashTradingEnforcement is Script {
    address internal constant BASE_SP1_GROTH16_VERIFIER_GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    function run() external returns (IBaseAnalysisStateOracle stateOracle, AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("SP1_VERIFIER", BASE_SP1_GROTH16_VERIFIER_GATEWAY);
        address stateOracleAddress = vm.envAddress("BASE_STATE_ORACLE");
        require(stateOracleAddress.code.length != 0, "state oracle has no code");
        stateOracle = IBaseAnalysisStateOracle(stateOracleAddress);
        bytes32 closedCycleProgramVKey = vm.envBytes32("CLOSED_CYCLE_PROGRAM_VKEY");
        bytes32 reciprocalProgramVKey = vm.envBytes32("RECIPROCAL_PROGRAM_VKEY");

        vm.startBroadcast(deployerPrivateKey);
        registry =
            new AntseedWashTradingRegistry(verifier, stateOracleAddress, closedCycleProgramVKey, reciprocalProgramVKey);
        vm.stopBroadcast();

        require(address(registry.verifier()) == verifier, "verifier pointer mismatch");
        require(address(registry.stateOracle()) == address(stateOracle), "state oracle pointer mismatch");
        require(registry.closedCycleProgramVKey() == closedCycleProgramVKey, "closed-cycle vkey mismatch");
        require(registry.reciprocalProgramVKey() == reciprocalProgramVKey, "reciprocal vkey mismatch");

        console.log("WashTradingRegistry:", address(registry));
        console.log("SP1Verifier:        ", verifier);
        console.log("BaseStateOracle:    ", address(stateOracle));
        console.logBytes32(closedCycleProgramVKey);
        console.logBytes32(reciprocalProgramVKey);
    }
}
