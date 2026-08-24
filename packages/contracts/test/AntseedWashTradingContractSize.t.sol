// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";

contract AntseedWashTradingContractSizeTest is Test {
    uint256 private constant POLICY_RUNTIME_SIZE_LIMIT = 2_048;
    uint256 private constant REGISTRY_RUNTIME_SIZE_LIMIT = 6_144;
    address private constant VERIFIER = address(0x1111);
    address private constant STATUS_OR_BLOCKHASH_STORE = address(0x2222);

    function test_policyRuntimeSizeRemainsMinimal() public {
        vm.etch(STATUS_OR_BLOCKHASH_STORE, hex"00");
        AntseedWashTradingRewardPolicy policy = new AntseedWashTradingRewardPolicy(STATUS_OR_BLOCKHASH_STORE);

        assertLt(address(policy).code.length, POLICY_RUNTIME_SIZE_LIMIT);
    }

    function test_registryRuntimeSizeRemainsMinimal() public {
        vm.chainId(8_453);
        vm.etch(VERIFIER, hex"00");
        vm.etch(STATUS_OR_BLOCKHASH_STORE, hex"00");
        AntseedWashTradingRegistry registry = new AntseedWashTradingRegistry(
            VERIFIER,
            STATUS_OR_BLOCKHASH_STORE,
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            1,
            bytes32(uint256(3))
        );

        assertLt(address(registry).code.length, REGISTRY_RUNTIME_SIZE_LIMIT);
    }
}
