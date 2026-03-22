// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

// Minimal interfaces for post-deploy wiring — avoids import clashes
// from contracts that re-declare IERC20/IAntseedIdentity locally.

interface ISetEscrow {
    function setEscrowContract(address) external;
}

interface ISetEmissions {
    function setEmissionsContract(address) external;
}

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

        // Read bytecodes from compiled artifacts
        bytes memory usdcBytecode = vm.getCode("MockUSDC.sol:MockUSDC");
        bytes memory identityBytecode = vm.getCode("AntseedIdentity.sol:AntseedIdentity");
        bytes memory tokenBytecode = vm.getCode("ANTSToken.sol:ANTSToken");

        vm.startBroadcast(deployerPrivateKey);

        // 1. MockUSDC
        address usdc;
        assembly { usdc := create(0, add(usdcBytecode, 0x20), mload(usdcBytecode)) }
        require(usdc != address(0), "MockUSDC deploy failed");
        console.log("MockUSDC:           ", usdc);

        // 2. AntseedIdentity
        address identity;
        assembly { identity := create(0, add(identityBytecode, 0x20), mload(identityBytecode)) }
        require(identity != address(0), "Identity deploy failed");
        console.log("AntseedIdentity:    ", identity);

        // 3. ANTSToken
        address antsToken;
        assembly { antsToken := create(0, add(tokenBytecode, 0x20), mload(tokenBytecode)) }
        require(antsToken != address(0), "ANTSToken deploy failed");
        console.log("ANTSToken:          ", antsToken);

        // 4. AntseedEscrow(usdc, identity)
        bytes memory escrowBytecode = abi.encodePacked(
            vm.getCode("AntseedEscrow.sol:AntseedEscrow"),
            abi.encode(usdc, identity)
        );
        address escrow;
        assembly { escrow := create(0, add(escrowBytecode, 0x20), mload(escrowBytecode)) }
        require(escrow != address(0), "Escrow deploy failed");
        console.log("AntseedEscrow:      ", escrow);

        // 5. AntseedEmissions(antsToken, initialEmission, epochDuration)
        bytes memory emissionsBytecode = abi.encodePacked(
            vm.getCode("AntseedEmissions.sol:AntseedEmissions"),
            abi.encode(antsToken, uint256(1_000_000e18), uint256(7 days))
        );
        address emissions;
        assembly { emissions := create(0, add(emissionsBytecode, 0x20), mload(emissionsBytecode)) }
        require(emissions != address(0), "Emissions deploy failed");
        console.log("AntseedEmissions:   ", emissions);

        // 6. AntseedSubPool(usdc, identity)
        bytes memory subPoolBytecode = abi.encodePacked(
            vm.getCode("AntseedSubPool.sol:AntseedSubPool"),
            abi.encode(usdc, identity)
        );
        address subPool;
        assembly { subPool := create(0, add(subPoolBytecode, 0x20), mload(subPoolBytecode)) }
        require(subPool != address(0), "SubPool deploy failed");
        console.log("AntseedSubPool:     ", subPool);

        // ---- Wire contracts together ----
        ISetEscrow(identity).setEscrowContract(escrow);
        ISetEmissions(antsToken).setEmissionsContract(emissions);
        ISetEmissions(escrow).setEmissionsContract(emissions);
        ISetEscrow(emissions).setEscrowContract(escrow);
        ISetEscrow(subPool).setEscrowContract(escrow);

        vm.stopBroadcast();

        console.log("");
        console.log("--- Protocol fully deployed and wired ---");
    }
}
