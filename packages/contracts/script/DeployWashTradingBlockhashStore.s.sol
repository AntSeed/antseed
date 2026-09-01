// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedSparseBlockhashStore } from "../integrity/AntseedSparseBlockhashStore.sol";

contract DeployWashTradingBlockhashStore is Script {
    function run() external returns (AntseedSparseBlockhashStore store) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        store = new AntseedSparseBlockhashStore(vm.envAddress("CHAINLINK_BLOCKHASH_STORE"));
        vm.stopBroadcast();

        console.log("AntseedSparseBlockhashStore:", address(store));
    }
}
