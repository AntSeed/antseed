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
 *   CLOSED_LOOP_VKEY
 *   RECIPROCAL_VKEY
 *   EXPECTED_BATCH_COUNT
 *   EXPECTED_BATCH_DIGEST
 */
contract DeployWashTradingEnforcement is Script {
    address internal constant BASE_SP1_GROTH16_VERIFIER_GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;
    address internal constant BASE_CHAINLINK_BLOCKHASH_STORE = 0x78b69899C8cD252126cBB1A50171ec37286C3877;

    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifier = vm.envOr("SP1_VERIFIER", BASE_SP1_GROTH16_VERIFIER_GATEWAY);
        bytes32 closedLoopVKey = vm.envBytes32("CLOSED_LOOP_VKEY");
        bytes32 reciprocalVKey = vm.envBytes32("RECIPROCAL_VKEY");
        uint32 expectedBatchCount = uint32(vm.envUint("EXPECTED_BATCH_COUNT"));
        bytes32 expectedBatchDigest = vm.envBytes32("EXPECTED_BATCH_DIGEST");
        require(verifier.code.length != 0, "verifier has no code");
        require(BASE_CHAINLINK_BLOCKHASH_STORE.code.length != 0, "BlockhashStore has no code");

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(
            verifier,
            BASE_CHAINLINK_BLOCKHASH_STORE,
            closedLoopVKey,
            reciprocalVKey,
            expectedBatchCount,
            expectedBatchDigest
        );
        vm.stopBroadcast();

        console.log("WashTradingRegistry:", address(registry));
        console.log("SP1Verifier:        ", verifier);
        console.log("BlockhashStore:     ", BASE_CHAINLINK_BLOCKHASH_STORE);
        console.log("ExpectedBatchCount: ", expectedBatchCount);
        console.logBytes32(expectedBatchDigest);
    }
}
