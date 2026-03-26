// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetSessions, ISetEmissions, ISetProtocolReserve, ISetStaking} from "../interfaces/IAntseedWiring.sol";

/**
 * @title Deploy
 * @notice Deploys the full AntSeed protocol to a local anvil chain.
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
        console.log("MockUSDC:           ", usdc);

        // 2. AntseedIdentity (no constructor args)
        bytes memory identityBytecode = vm.getCode("AntseedIdentity.sol:AntseedIdentity");
        address identity;
        assembly { identity := create(0, add(identityBytecode, 0x20), mload(identityBytecode)) }
        require(identity != address(0), "Identity deploy failed");
        console.log("AntseedIdentity:    ", identity);

        // 3. ANTSToken
        address antsToken;
        assembly { antsToken := create(0, add(tokenBytecode, 0x20), mload(tokenBytecode)) }
        require(antsToken != address(0), "ANTSToken deploy failed");
        console.log("ANTSToken:          ", antsToken);

        // 4. AntseedStaking(usdc, identity)
        bytes memory stakingBytecode = abi.encodePacked(
            vm.getCode("AntseedStaking.sol:AntseedStaking"),
            abi.encode(usdc, identity)
        );
        address staking;
        assembly { staking := create(0, add(stakingBytecode, 0x20), mload(stakingBytecode)) }
        require(staking != address(0), "Staking deploy failed");
        console.log("AntseedStaking:     ", staking);

        // 5. AntseedDeposits(usdc)
        bytes memory depositsBytecode = abi.encodePacked(
            vm.getCode("AntseedDeposits.sol:AntseedDeposits"),
            abi.encode(usdc)
        );
        address deposits;
        assembly { deposits := create(0, add(depositsBytecode, 0x20), mload(depositsBytecode)) }
        require(deposits != address(0), "Deposits deploy failed");
        console.log("AntseedDeposits:    ", deposits);

        // 6. TempoStreamChannel (no constructor args)
        bytes memory tempoBytecode = vm.getCode("TempoStreamChannel.sol:TempoStreamChannel");
        address tempo;
        assembly { tempo := create(0, add(tempoBytecode, 0x20), mload(tempoBytecode)) }
        require(tempo != address(0), "TempoStreamChannel deploy failed");
        console.log("TempoStreamChannel: ", tempo);

        // 7. AntseedSessions(streamChannel, deposits, identity, staking, usdc)
        bytes memory sessionsBytecode = abi.encodePacked(
            vm.getCode("AntseedSessions.sol:AntseedSessions"),
            abi.encode(tempo, deposits, identity, staking, usdc)
        );
        address sessions;
        assembly { sessions := create(0, add(sessionsBytecode, 0x20), mload(sessionsBytecode)) }
        require(sessions != address(0), "Sessions deploy failed");
        console.log("AntseedSessions:    ", sessions);

        // 8. AntseedEmissions(antsToken, initialEmission, epochDuration)
        bytes memory emissionsBytecode = abi.encodePacked(
            vm.getCode("AntseedEmissions.sol:AntseedEmissions"),
            abi.encode(antsToken, uint256(1_000_000e18), uint256(7 days))
        );
        address emissions;
        assembly { emissions := create(0, add(emissionsBytecode, 0x20), mload(emissionsBytecode)) }
        require(emissions != address(0), "Emissions deploy failed");
        console.log("AntseedEmissions:   ", emissions);

        // 9. AntseedSubPool(usdc, identity)
        bytes memory subPoolBytecode = abi.encodePacked(
            vm.getCode("AntseedSubPool.sol:AntseedSubPool"),
            abi.encode(usdc, identity)
        );
        address subPool;
        assembly { subPool := create(0, add(subPoolBytecode, 0x20), mload(subPoolBytecode)) }
        require(subPool != address(0), "SubPool deploy failed");
        console.log("AntseedSubPool:     ", subPool);

        // ---- Wire contracts together ----
        ISetSessions(deposits).setSessionsContract(sessions);
        ISetSessions(identity).setSessionsContract(sessions);
        ISetStaking(identity).setStakingContract(staking);
        ISetSessions(staking).setSessionsContract(sessions);
        ISetProtocolReserve(staking).setProtocolReserve(protocolReserve);
        ISetEmissions(antsToken).setEmissionsContract(emissions);
        ISetSessions(emissions).setSessionsContract(sessions);
        ISetProtocolReserve(sessions).setProtocolReserve(protocolReserve);
        ISetSessions(subPool).setSessionsContract(sessions);

        vm.stopBroadcast();

        console.log("");
        console.log("--- Protocol fully deployed and wired ---");
    }
}
