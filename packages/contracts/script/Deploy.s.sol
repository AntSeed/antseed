// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetRegistry} from "../interfaces/IAntseedWiring.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";

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
        address identityRegistry;
        assembly { identityRegistry := create(0, add(registryBytecode, 0x20), mload(registryBytecode)) }
        require(identityRegistry != address(0), "MockERC8004Registry deploy failed");
        console.log("MockERC8004Registry:  ", identityRegistry);

        // 3. ANTSToken
        address antsToken;
        assembly { antsToken := create(0, add(tokenBytecode, 0x20), mload(tokenBytecode)) }
        require(antsToken != address(0), "ANTSToken deploy failed");
        console.log("ANTSToken:            ", antsToken);

        // 4. AntseedRegistry (central address book)
        AntseedRegistry antseedRegistry = new AntseedRegistry();
        console.log("AntseedRegistry:      ", address(antseedRegistry));

        // 5. AntseedStaking(usdc, registry)
        bytes memory stakingBytecode = abi.encodePacked(
            vm.getCode("AntseedStaking.sol:AntseedStaking"),
            abi.encode(usdc, address(antseedRegistry))
        );
        address staking;
        assembly { staking := create(0, add(stakingBytecode, 0x20), mload(stakingBytecode)) }
        require(staking != address(0), "Staking deploy failed");
        console.log("AntseedStaking:       ", staking);

        // 7. AntseedDeposits(usdc)
        bytes memory depositsBytecode = abi.encodePacked(
            vm.getCode("AntseedDeposits.sol:AntseedDeposits"),
            abi.encode(usdc)
        );
        address deposits;
        assembly { deposits := create(0, add(depositsBytecode, 0x20), mload(depositsBytecode)) }
        require(deposits != address(0), "Deposits deploy failed");
        console.log("AntseedDeposits:      ", deposits);

        // 8. AntseedChannels(registry)
        bytes memory channelsBytecode = abi.encodePacked(
            vm.getCode("AntseedChannels.sol:AntseedChannels"),
            abi.encode(address(antseedRegistry))
        );
        address channels;
        assembly { channels := create(0, add(channelsBytecode, 0x20), mload(channelsBytecode)) }
        require(channels != address(0), "Channels deploy failed");
        console.log("AntseedChannels:      ", channels);

        // 9. AntseedEmissions(registry, initialEmission, epochDuration)
        bytes memory emissionsBytecode = abi.encodePacked(
            vm.getCode("AntseedEmissions.sol:AntseedEmissions"),
            abi.encode(address(antseedRegistry), uint256(1_000_000e18), uint256(7 days))
        );
        address emissions;
        assembly { emissions := create(0, add(emissionsBytecode, 0x20), mload(emissionsBytecode)) }
        require(emissions != address(0), "Emissions deploy failed");
        console.log("AntseedEmissions:     ", emissions);

        // 10. AntseedSubPool(usdc, registry)
        bytes memory subPoolBytecode = abi.encodePacked(
            vm.getCode("AntseedSubPool.sol:AntseedSubPool"),
            abi.encode(usdc, address(antseedRegistry))
        );
        address subPool;
        assembly { subPool := create(0, add(subPoolBytecode, 0x20), mload(subPoolBytecode)) }
        require(subPool != address(0), "SubPool deploy failed");
        console.log("AntseedSubPool:       ", subPool);

        // ---- Wire registry ----
        antseedRegistry.setChannels(channels);
        antseedRegistry.setDeposits(deposits);
        antseedRegistry.setStaking(staking);
        antseedRegistry.setEmissions(emissions);
        antseedRegistry.setAntsToken(antsToken);
        antseedRegistry.setIdentityRegistry(identityRegistry);
        antseedRegistry.setProtocolReserve(protocolReserve);

        // ---- Point each contract at the registry ----
        // Channels and Staking already received the registry in their constructors,
        // but we include them here for uniformity so the pattern is obvious in upgrades.
        ISetRegistry(channels).setRegistry(address(antseedRegistry));
        ISetRegistry(deposits).setRegistry(address(antseedRegistry));
        ISetRegistry(staking).setRegistry(address(antseedRegistry));
        ISetRegistry(emissions).setRegistry(address(antseedRegistry));
        ISetRegistry(antsToken).setRegistry(address(antseedRegistry));
        ISetRegistry(subPool).setRegistry(address(antseedRegistry));

        vm.stopBroadcast();

        console.log("");
        console.log("--- Protocol fully deployed and wired ---");
    }
}
