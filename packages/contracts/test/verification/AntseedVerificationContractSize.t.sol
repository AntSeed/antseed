// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";

contract AntseedVerificationContractSizeTest is Test {
    uint256 private constant VERIFICATION_RUNTIME_SIZE_LIMIT = 8_192;
    uint256 private constant POLICY_RUNTIME_SIZE_LIMIT = 3_072;

    function test_verificationRuntimeSizeRemainsBounded() public {
        AntseedRegistry registry = new AntseedRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));

        assertLt(address(verification).code.length, VERIFICATION_RUNTIME_SIZE_LIMIT);
    }

    function test_verificationPolicyRuntimeSizeRemainsMinimal() public {
        AntseedRegistry registry = new AntseedRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));
        AntseedVerificationPointsPolicy policy =
            new AntseedVerificationPointsPolicy(address(this), address(registry), address(verification));

        assertLt(address(policy).code.length, POLICY_RUNTIME_SIZE_LIMIT);
    }
}
