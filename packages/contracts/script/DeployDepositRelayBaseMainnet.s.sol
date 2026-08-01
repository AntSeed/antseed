// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {AntseedDepositRelay} from "../payments/AntseedDepositRelay.sol";

/**
 * @title DeployDepositRelayBaseMainnet
 * @notice Deploys AntseedDepositRelay against the existing Base mainnet
 *         protocol contracts. The relay is stateless and immutable (no owner,
 *         no registry wiring) — deploying it is purely additive; buyers opt in
 *         by signing EIP-3009 authorizations addressed to it.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployDepositRelayBaseMainnet.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployDepositRelayBaseMainnet is Script {
    // Real USDC on Base mainnet (Circle)
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // AntseedDeposits on Base mainnet (chain-config base-mainnet)
    address constant DEPOSITS = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2;

    // Fixed relayer fee in USDC base units ($0.05) — matches the local deploy.
    uint256 constant FEE = 50_000;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        console.log("=== Base Mainnet AntseedDepositRelay Deployment ===");
        console.log("Deployer:            ", deployer);
        console.log("USDC (Circle):       ", USDC);
        console.log("AntseedDeposits:     ", DEPOSITS);
        console.log("FEE (USDC base):     ", FEE);

        AntseedDepositRelay relay = new AntseedDepositRelay(USDC, DEPOSITS, FEE);
        console.log("AntseedDepositRelay: ", address(relay));

        vm.stopBroadcast();
    }
}
