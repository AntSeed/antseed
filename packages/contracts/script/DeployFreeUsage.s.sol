// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedFreeUsage } from "../payments/AntseedFreeUsage.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { ISetWriter } from "../interfaces/IAntseedWiring.sol";

/**
 * @title DeployFreeUsage
 * @notice Deploys only AntseedFreeUsage against an existing AntSeed registry.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Broadcaster private key.
 *   ANTSEED_REGISTRY       Deployed AntseedRegistry address.
 *
 * Optional env:
 *   FREE_USAGE_AUTHORIZE_STATS  Defaults to true. Grants the deployed
 *                               FreeUsage contract writer access on the
 *                               registry's AntseedStats contract.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployFreeUsage.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployFreeUsage is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        bool authorizeStats = vm.envOr("FREE_USAGE_AUTHORIZE_STATS", true);

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address staking = registry.staking();
        address stats = registry.stats();

        require(staking != address(0), "registry staking not set");

        vm.startBroadcast(deployerPrivateKey);

        console.log("=== AntseedFreeUsage Deployment ===");
        console.log("Deployer:             ", deployer);
        console.log("AntseedRegistry:      ", registryAddress);
        console.log("AntseedStaking:       ", staking);
        console.log("AntseedStats:         ", stats);
        console.log("");

        AntseedFreeUsage freeUsage = new AntseedFreeUsage(registryAddress);
        console.log("AntseedFreeUsage:     ", address(freeUsage));

        if (authorizeStats && stats != address(0)) {
            ISetWriter(stats).setWriter(address(freeUsage), true);
            console.log("Stats writer granted: ", true);
        } else {
            console.log("Stats writer granted: ", false);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== AntseedFreeUsage deployment complete ===");
        console.log("Update chain config:");
        console.log("  freeUsageContractAddress:", address(freeUsage));
    }
}
