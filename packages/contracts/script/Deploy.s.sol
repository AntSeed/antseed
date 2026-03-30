// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetChannels, ISetEmissions, ISetProtocolReserve} from "../interfaces/IAntseedWiring.sol";

/**
 * @title Deploy
 * @notice Deploys the full AntSeed protocol to a local anvil chain.
 *         Uses MockERC8004Registry for local testing (on mainnet, use the real ERC-8004).
 *
 * Usage:
 *   anvil &
 *   forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "DEPLOYER_PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80) // anvil account 0
        );

        address protocolReserve = vm.envOr("PROTOCOL_RESERVE", vm.addr(deployerPrivateKey));

        // Read bytecodes from compiled artifacts
        bytes memory usdcBytecode = vm.getCode("MockUSDC.sol:MockUSDC");
        bytes memory tokenBytecode = vm.getCode("ANTSToken.sol:ANTSToken");

        vm.startBroadcast(deployerPrivateKey);

        // 1. MockUSDC
        address usdc;
        assembly { usdc := create(0, add(usdcBytecode, 0x20), mload(usdcBytecode)) }
        require(usdc != address(0), "MockUSDC deploy failed");
        console.log("MockUSDC:             ", usdc);

        // 2. MockERC8004Registry (local testing; on mainnet use 0x8004A169...)
        bytes memory registryBytecode = vm.getCode("MockERC8004Registry.sol:MockERC8004Registry");
        address registry;
        assembly { registry := create(0, add(registryBytecode, 0x20), mload(registryBytecode)) }
        require(registry != address(0), "MockERC8004Registry deploy failed");
        console.log("MockERC8004Registry:  ", registry);

        // 3. ANTSToken
        address antsToken;
        assembly { antsToken := create(0, add(tokenBytecode, 0x20), mload(tokenBytecode)) }
        require(antsToken != address(0), "ANTSToken deploy failed");
        console.log("ANTSToken:            ", antsToken);

        // 4. AntseedStats (no constructor args)
        bytes memory statsBytecode = vm.getCode("AntseedStats.sol:AntseedStats");
        address stats;
        assembly { stats := create(0, add(statsBytecode, 0x20), mload(statsBytecode)) }
        require(stats != address(0), "AntseedStats deploy failed");
        console.log("AntseedStats:         ", stats);

        // 5. AntseedStaking(usdc, registry, stats)
        bytes memory stakingBytecode = abi.encodePacked(
            vm.getCode("AntseedStaking.sol:AntseedStaking"),
            abi.encode(usdc, registry, stats)
        );
        address staking;
        assembly { staking := create(0, add(stakingBytecode, 0x20), mload(stakingBytecode)) }
        require(staking != address(0), "Staking deploy failed");
        console.log("AntseedStaking:       ", staking);

        // 6. AntseedDeposits(usdc)
        bytes memory depositsBytecode = abi.encodePacked(
            vm.getCode("AntseedDeposits.sol:AntseedDeposits"),
            abi.encode(usdc)
        );
        address deposits;
        assembly { deposits := create(0, add(depositsBytecode, 0x20), mload(depositsBytecode)) }
        require(deposits != address(0), "Deposits deploy failed");
        console.log("AntseedDeposits:      ", deposits);

        // 7. AntseedChannels(deposits, stats, staking)
        bytes memory channelsBytecode = abi.encodePacked(
            vm.getCode("AntseedChannels.sol:AntseedChannels"),
            abi.encode(deposits, stats, staking)
        );
        address channels;
        assembly { channels := create(0, add(channelsBytecode, 0x20), mload(channelsBytecode)) }
        require(channels != address(0), "Channels deploy failed");
        console.log("AntseedChannels:      ", channels);

        // 9. AntseedEmissions(antsToken, initialEmission, epochDuration)
        bytes memory emissionsBytecode = abi.encodePacked(
            vm.getCode("AntseedEmissions.sol:AntseedEmissions"),
            abi.encode(antsToken, uint256(1_000_000e18), uint256(7 days))
        );
        address emissions;
        assembly { emissions := create(0, add(emissionsBytecode, 0x20), mload(emissionsBytecode)) }
        require(emissions != address(0), "Emissions deploy failed");
        console.log("AntseedEmissions:     ", emissions);

        // 10. AntseedSubPool(usdc, registry, stats)
        bytes memory subPoolBytecode = abi.encodePacked(
            vm.getCode("AntseedSubPool.sol:AntseedSubPool"),
            abi.encode(usdc, registry, stats)
        );
        address subPool;
        assembly { subPool := create(0, add(subPoolBytecode, 0x20), mload(subPoolBytecode)) }
        require(subPool != address(0), "SubPool deploy failed");
        console.log("AntseedSubPool:       ", subPool);

        // ---- Wire contracts together ----
        ISetChannels(stats).setChannelsContract(channels);
        ISetChannels(deposits).setChannelsContract(channels);
        ISetChannels(staking).setChannelsContract(channels);
        ISetProtocolReserve(staking).setProtocolReserve(protocolReserve);
        ISetEmissions(antsToken).setEmissionsContract(emissions);
        ISetChannels(emissions).setChannelsContract(channels);
        ISetProtocolReserve(channels).setProtocolReserve(protocolReserve);
        ISetChannels(subPool).setChannelsContract(channels);

        vm.stopBroadcast();

        console.log("");
        console.log("--- Protocol fully deployed and wired ---");
    }
}
