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
 *   SELLER_PENALTY_IMAGE_ID
 */
contract DeployWashTradingEnforcement is Script {
    function run() external returns (AntseedBaseCheckpointOracle stateOracle, AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envAddress("RISC0_VERIFIER");
        bytes32 checkpointImageId = vm.envBytes32("CHECKPOINT_IMAGE_ID");
        bytes32 sellerPenaltyImageId = vm.envBytes32("SELLER_PENALTY_IMAGE_ID");

        vm.startBroadcast(deployerPrivateKey);
        stateOracle = new AntseedBaseCheckpointOracle(verifier, checkpointImageId);
        registry = new AntseedWashTradingRegistry(verifier, address(stateOracle), sellerPenaltyImageId);
        vm.stopBroadcast();

        require(address(registry.verifier()) == verifier, "verifier pointer mismatch");
        require(address(registry.stateOracle()) == address(stateOracle), "state oracle pointer mismatch");
        require(registry.sellerPenaltyImageId() == sellerPenaltyImageId, "seller penalty image mismatch");
        require(address(stateOracle.verifier()) == verifier, "checkpoint verifier pointer mismatch");
        require(stateOracle.checkpointImageId() == checkpointImageId, "checkpoint image mismatch");

        console.log("WashTradingRegistry:", address(registry));
        console.log("RiscZeroVerifier:   ", verifier);
        console.log("BaseStateOracle:    ", address(stateOracle));
        console.logBytes32(checkpointImageId);
        console.logBytes32(sellerPenaltyImageId);
    }
}
