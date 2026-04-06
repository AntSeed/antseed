// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetRegistry, ISetWriter} from "../interfaces/IAntseedWiring.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";

/**
 * @title UpgradeBaseSepolia
 * @notice Partial deploy: Registry, Stats, Deposits, Channels only.
 *         Reuses existing USDC, Staking, Emissions, ANTSToken, and ERC-8004.
 *         After deploy, calls setRegistry on existing Staking + Emissions
 *         to point them at the new Registry.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/UpgradeBaseSepolia.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract UpgradeBaseSepolia is Script {
    // ─── Existing contracts (kept as-is) ────────────────────────────
    address constant USDC           = 0xcA04797CaB6B412Cee6798B7314a05AdFDc3Cf23;
    address constant STAKING        = 0x1CB76B197a20E41f9AA01806B41C59e16Cad46a7;
    address constant EMISSIONS      = 0x9B30DAcfC20F0927fFD49fB0B84cf3EB83976a33;
    address constant ANTS_TOKEN     = 0x10B2B40d7aDEBAB0f8a9567fc90973Fbb997aE61;
    address constant IDENTITY       = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address protocolReserve = vm.envAddress("PROTOCOL_RESERVE");
        address teamWallet = vm.envAddress("TEAM_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        console.log("Deployer:             ", deployer);
        console.log("Protocol Reserve:     ", protocolReserve);
        console.log("Team Wallet:          ", teamWallet);
        console.log("");
        console.log("--- Existing (reused) ---");
        console.log("USDC:                 ", USDC);
        console.log("Staking:              ", STAKING);
        console.log("Emissions:            ", EMISSIONS);
        console.log("ANTSToken:            ", ANTS_TOKEN);
        console.log("ERC-8004 Registry:    ", IDENTITY);
        console.log("");

        // 1. AntseedRegistry (new central address book)
        AntseedRegistry registry = new AntseedRegistry();
        console.log("--- New deployments ---");
        console.log("AntseedRegistry:      ", address(registry));

        // 2. AntseedStats (new)
        bytes memory statsBytecode = vm.getCode("AntseedStats.sol:AntseedStats");
        address stats;
        assembly { stats := create(0, add(statsBytecode, 0x20), mload(statsBytecode)) }
        require(stats != address(0), "Stats deploy failed");
        console.log("AntseedStats:         ", stats);

        // 3. AntseedDeposits(usdc) — new logic (direct payouts)
        bytes memory depositsBytecode = abi.encodePacked(
            vm.getCode("AntseedDeposits.sol:AntseedDeposits"),
            abi.encode(USDC)
        );
        address deposits;
        assembly { deposits := create(0, add(depositsBytecode, 0x20), mload(depositsBytecode)) }
        require(deposits != address(0), "Deposits deploy failed");
        console.log("AntseedDeposits:      ", deposits);

        // 4. AntseedChannels(registry) — new logic
        bytes memory channelsBytecode = abi.encodePacked(
            vm.getCode("AntseedChannels.sol:AntseedChannels"),
            abi.encode(address(registry))
        );
        address channels;
        assembly { channels := create(0, add(channelsBytecode, 0x20), mload(channelsBytecode)) }
        require(channels != address(0), "Channels deploy failed");
        console.log("AntseedChannels:      ", channels);

        // ---- Wire new Registry (all addresses) ----
        registry.setChannels(channels);
        registry.setStats(stats);
        registry.setDeposits(deposits);
        registry.setStaking(STAKING);
        registry.setEmissions(EMISSIONS);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setIdentityRegistry(IDENTITY);
        registry.setProtocolReserve(protocolReserve);
        registry.setTeamWallet(teamWallet);

        // ---- Point new contracts at new Registry ----
        ISetRegistry(channels).setRegistry(address(registry));
        ISetRegistry(deposits).setRegistry(address(registry));

        // ---- Point existing contracts at new Registry ----
        ISetRegistry(STAKING).setRegistry(address(registry));
        ISetRegistry(EMISSIONS).setRegistry(address(registry));
        ISetRegistry(ANTS_TOKEN).setRegistry(address(registry));

        // ---- Authorize Channels as Stats writer ----
        ISetWriter(stats).setWriter(channels, true);

        vm.stopBroadcast();

        console.log("");
        console.log("--- Upgrade complete ---");
        console.log("");
        console.log("Update chain-config.ts (base-sepolia):");
        console.log("  usdcContractAddress:      ", USDC);
        console.log("  depositsContractAddress:   ", deposits);
        console.log("  channelsContractAddress:   ", channels);
        console.log("  stakingContractAddress:    ", STAKING);
        console.log("  emissionsContractAddress:  ", EMISSIONS);
        console.log("  identityRegistryAddress:   ", IDENTITY);
    }
}
