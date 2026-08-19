// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";

/**
 * @notice Permissionless keeper call that preserves one recent EIP-4788 root.
 * Required env: DEPLOYER_PRIVATE_KEY, BASE_STATE_ORACLE, ETHEREUM_TIMESTAMP.
 */
contract ArchiveBaseBeaconRoot is Script {
    function run() external returns (bytes32 beaconRoot) {
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        AntseedBaseCheckpointOracle oracle = AntseedBaseCheckpointOracle(vm.envAddress("BASE_STATE_ORACLE"));
        uint256 ethereumTimestamp = vm.envUint("ETHEREUM_TIMESTAMP");

        vm.startBroadcast(privateKey);
        beaconRoot = oracle.archiveBeaconRoot(ethereumTimestamp);
        vm.stopBroadcast();

        console.log("Archived timestamp:", ethereumTimestamp);
        console.logBytes32(beaconRoot);
    }
}
