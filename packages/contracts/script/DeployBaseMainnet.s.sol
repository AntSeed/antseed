// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetRegistry, ISetWriter} from "../interfaces/IAntseedWiring.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";

/**
 * @title DeployBaseMainnet
 * @notice Deploys AntSeed protocol to Base mainnet.
 *         Uses real USDC (Circle) and real ERC-8004 IdentityRegistry.
 *         Skips AntseedSlashing and AntseedSubPool (not needed for v1).
 *
 * Usage:
 *   cd packages/contracts
 *   source .env.mainnet
 *   forge script script/DeployBaseMainnet.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployBaseMainnet is Script {
    // Real USDC on Base mainnet (Circle)
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ERC-8004 IdentityRegistry on Base mainnet
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address protocolReserve = vm.envAddress("PROTOCOL_RESERVE");
        address teamWallet = vm.envAddress("TEAM_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        console.log("=== Base Mainnet Deployment ===");
        console.log("");
        console.log("Deployer:             ", deployer);
        console.log("Protocol Reserve:     ", protocolReserve);
        console.log("Team Wallet:          ", teamWallet);
        console.log("USDC (Circle):        ", USDC);
        console.log("ERC-8004 Registry:    ", IDENTITY_REGISTRY);
        console.log("");

        // 1. ANTSToken
        bytes memory tokenBytecode = vm.getCode("ANTSToken.sol:ANTSToken");
        address antsToken;
        assembly { antsToken := create(0, add(tokenBytecode, 0x20), mload(tokenBytecode)) }
        require(antsToken != address(0), "ANTSToken deploy failed");
        console.log("ANTSToken:            ", antsToken);

        // 2. AntseedRegistry (central address book)
        AntseedRegistry antseedRegistry = new AntseedRegistry();
        console.log("AntseedRegistry:      ", address(antseedRegistry));

        // 3. AntseedStaking(usdc, registry)
        bytes memory stakingBytecode = abi.encodePacked(
            vm.getCode("AntseedStaking.sol:AntseedStaking"),
            abi.encode(USDC, address(antseedRegistry))
        );
        address staking;
        assembly { staking := create(0, add(stakingBytecode, 0x20), mload(stakingBytecode)) }
        require(staking != address(0), "Staking deploy failed");
        console.log("AntseedStaking:       ", staking);

        // 4. AntseedDeposits(usdc)
        bytes memory depositsBytecode = abi.encodePacked(
            vm.getCode("AntseedDeposits.sol:AntseedDeposits"),
            abi.encode(USDC)
        );
        address deposits;
        assembly { deposits := create(0, add(depositsBytecode, 0x20), mload(depositsBytecode)) }
        require(deposits != address(0), "Deposits deploy failed");
        console.log("AntseedDeposits:      ", deposits);

        // 5. AntseedChannels(registry)
        bytes memory channelsBytecode = abi.encodePacked(
            vm.getCode("AntseedChannels.sol:AntseedChannels"),
            abi.encode(address(antseedRegistry))
        );
        address channels;
        assembly { channels := create(0, add(channelsBytecode, 0x20), mload(channelsBytecode)) }
        require(channels != address(0), "Channels deploy failed");
        console.log("AntseedChannels:      ", channels);

        // 6. AntseedStats
        bytes memory statsBytecode = vm.getCode("AntseedStats.sol:AntseedStats");
        address stats;
        assembly { stats := create(0, add(statsBytecode, 0x20), mload(statsBytecode)) }
        require(stats != address(0), "Stats deploy failed");
        console.log("AntseedStats:         ", stats);

        // 7. AntseedEmissions(registry, initialEmission, epochDuration)
        bytes memory emissionsBytecode = abi.encodePacked(
            vm.getCode("AntseedEmissions.sol:AntseedEmissions"),
            abi.encode(address(antseedRegistry), uint256(5_000_000e18), uint256(7 days))
        );
        address emissions;
        assembly { emissions := create(0, add(emissionsBytecode, 0x20), mload(emissionsBytecode)) }
        require(emissions != address(0), "Emissions deploy failed");
        console.log("AntseedEmissions:     ", emissions);

        // ---- Wire registry ----
        antseedRegistry.setChannels(channels);
        antseedRegistry.setStats(stats);
        antseedRegistry.setDeposits(deposits);
        antseedRegistry.setStaking(staking);
        antseedRegistry.setEmissions(emissions);
        antseedRegistry.setAntsToken(antsToken);
        antseedRegistry.setIdentityRegistry(IDENTITY_REGISTRY);
        antseedRegistry.setProtocolReserve(protocolReserve);
        antseedRegistry.setTeamWallet(teamWallet);

        // ---- Point each contract at the registry ----
        ISetRegistry(channels).setRegistry(address(antseedRegistry));
        ISetRegistry(deposits).setRegistry(address(antseedRegistry));
        ISetRegistry(staking).setRegistry(address(antseedRegistry));
        ISetRegistry(emissions).setRegistry(address(antseedRegistry));
        ISetRegistry(antsToken).setRegistry(address(antseedRegistry));

        // ---- Authorize Channels as Stats writer ----
        ISetWriter(stats).setWriter(channels, true);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Base Mainnet deployment complete ===");
        console.log("");
        console.log("Add to chain-config.ts (base-mainnet):");
        console.log("  usdcContractAddress:      ", USDC);
        console.log("  depositsContractAddress:   ", deposits);
        console.log("  channelsContractAddress:   ", channels);
        console.log("  stakingContractAddress:    ", staking);
        console.log("  emissionsContractAddress:  ", emissions);
        console.log("  identityRegistryAddress:   ", IDENTITY_REGISTRY);
    }
}
