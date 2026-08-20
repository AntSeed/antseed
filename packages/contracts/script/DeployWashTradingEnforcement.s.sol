// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";

/**
 * @title DeployWashTradingEnforcement
 * @notice Deploys the immutable positive-evidence P0 seller registry
 *         against the existing canonical Base block oracle.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   RISC0_VERIFIER
 *   BASE_STATE_ORACLE
 *   CLOSED_CYCLE_IMAGE_ID
 *   RECIPROCAL_IMAGE_ID
 */
contract DeployWashTradingEnforcement is Script {
    address internal constant BASE_RISC0_VERIFIER_ROUTER = 0xA326b2eb45A5C3C206dF905A58970DcA57B8719e;

    function run() external returns (IBaseAnalysisStateOracle stateOracle, AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("RISC0_VERIFIER", BASE_RISC0_VERIFIER_ROUTER);
        address stateOracleAddress = vm.envAddress("BASE_STATE_ORACLE");
        require(stateOracleAddress.code.length != 0, "state oracle has no code");
        stateOracle = IBaseAnalysisStateOracle(stateOracleAddress);
        bytes32 closedCycleImageId = vm.envBytes32("CLOSED_CYCLE_IMAGE_ID");
        bytes32 reciprocalImageId = vm.envBytes32("RECIPROCAL_IMAGE_ID");

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(verifier, stateOracleAddress, closedCycleImageId, reciprocalImageId);
        vm.stopBroadcast();

        require(address(registry.verifier()) == verifier, "verifier pointer mismatch");
        require(address(registry.stateOracle()) == address(stateOracle), "state oracle pointer mismatch");
        require(registry.closedCycleImageId() == closedCycleImageId, "closed-cycle image mismatch");
        require(registry.reciprocalImageId() == reciprocalImageId, "reciprocal image mismatch");

        console.log("WashTradingRegistry:", address(registry));
        console.log("RiscZeroVerifier:   ", verifier);
        console.log("BaseStateOracle:    ", address(stateOracle));
        console.logBytes32(closedCycleImageId);
        console.logBytes32(reciprocalImageId);
    }
}
