// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

/**
 * @title DeployWashTradingEnforcement
 * @notice Deploys the Base-only checkpoint oracle and immutable
 *         positive-evidence seller penalty registry.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   RISC0_VERIFIER
 *   CHECKPOINT_IMAGE_ID
 *   HISTORICAL_CHUNK_IMAGE_ID
 *   COHORT_IMAGE_ID
 *   RECIPROCAL_IMAGE_ID
 *   APPROVED_REPORT_ROOT
 */
contract DeployWashTradingEnforcement is Script {
    address internal constant BASE_RISC0_VERIFIER_ROUTER = 0xA326b2eb45A5C3C206dF905A58970DcA57B8719e;

    function run() external returns (AntseedBaseCheckpointOracle stateOracle, AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("RISC0_VERIFIER", BASE_RISC0_VERIFIER_ROUTER);
        bytes32 checkpointImageId = vm.envBytes32("CHECKPOINT_IMAGE_ID");
        bytes32 historicalChunkImageId = vm.envBytes32("HISTORICAL_CHUNK_IMAGE_ID");
        bytes32 cohortImageId = vm.envBytes32("COHORT_IMAGE_ID");
        bytes32 reciprocalImageId = vm.envBytes32("RECIPROCAL_IMAGE_ID");
        bytes32 approvedReportRoot = vm.envBytes32("APPROVED_REPORT_ROOT");

        vm.startBroadcast(deployerPrivateKey);
        stateOracle = new AntseedBaseCheckpointOracle(verifier, checkpointImageId, historicalChunkImageId);
        registry = new AntseedWashTradingRegistry(
            verifier, address(stateOracle), cohortImageId, reciprocalImageId, approvedReportRoot
        );
        vm.stopBroadcast();

        require(address(registry.verifier()) == verifier, "verifier pointer mismatch");
        require(address(registry.stateOracle()) == address(stateOracle), "state oracle pointer mismatch");
        require(registry.cohortImageId() == cohortImageId, "cohort image mismatch");
        require(registry.reciprocalImageId() == reciprocalImageId, "reciprocal image mismatch");
        require(registry.approvedReportRoot() == approvedReportRoot, "report root mismatch");
        require(address(stateOracle.verifier()) == verifier, "checkpoint verifier pointer mismatch");
        require(stateOracle.checkpointImageId() == checkpointImageId, "checkpoint image mismatch");
        require(stateOracle.historicalChunkImageId() == historicalChunkImageId, "historical image mismatch");

        console.log("WashTradingRegistry:", address(registry));
        console.log("RiscZeroVerifier:   ", verifier);
        console.log("BaseStateOracle:    ", address(stateOracle));
        console.logBytes32(checkpointImageId);
        console.logBytes32(historicalChunkImageId);
        console.logBytes32(cohortImageId);
        console.logBytes32(reciprocalImageId);
        console.logBytes32(approvedReportRoot);
    }
}
