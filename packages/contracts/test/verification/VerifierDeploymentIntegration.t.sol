// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { ConfigureVerification } from "../../script/ConfigureVerification.s.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";

contract VerifierDeploymentIntegrationTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    uint256 private constant DEPLOYER_PRIVATE_KEY = 0xA11CE;
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function test_configureVerificationTransfersBucketAndKeepsPolicyShadowOnly() public {
        vm.warp(GENESIS + 8 days);
        address deployer = vm.addr(DEPLOYER_PRIVATE_KEY);

        vm.startPrank(deployer);
        AntseedRegistry registry = new AntseedRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(deployer);
        gate.setMinter(VERIFICATION_MINTER_ID, address(0xF1ED), 10_000, true);
        vm.stopPrank();

        _setConfigureEnv(registry, gate, pointsPolicyRegistry, address(0), address(0), false);
        ConfigureVerification script = new ConfigureVerification();
        (AntseedVerification verification, AntseedVerificationPointsPolicy verificationPointsPolicy) = script.run();

        (address controller, uint32 shareBps, bool editable) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, address(verification));
        assertEq(shareBps, 10_000);
        assertTrue(editable);
        assertEq(address(verification.registry()), address(registry));
        assertEq(address(verification.emissionsGate()), address(gate));
        assertEq(address(verificationPointsPolicy.registry()), address(registry));
        assertEq(address(verificationPointsPolicy.verificationStatus()), address(verification));
        assertEq(verificationPointsPolicy.minDistinctDiffVerifiers(), 2);
        assertEq(verificationPointsPolicy.diffPenaltyBps(), 10_000);
        assertFalse(pointsPolicyRegistry.isPolicyRegistered(address(verificationPointsPolicy)));
        assertEq(pointsPolicyRegistry.policyCount(), 0);

        _setConfigureEnv(
            registry, gate, pointsPolicyRegistry, address(verification), address(verificationPointsPolicy), false
        );
        (AntseedVerification reusedVerification, AntseedVerificationPointsPolicy reusedPolicy) = script.run();

        assertEq(address(reusedVerification), address(verification));
        assertEq(address(reusedPolicy), address(verificationPointsPolicy));
        assertEq(pointsPolicyRegistry.policyCount(), 0);
    }

    function test_lateVerifierDeploymentStartsRewardsNextEpoch() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry registry = new AntseedRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);

        vm.warp(GENESIS + 5 * gate.EPOCH_DURATION() + 1);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));

        assertEq(verification.currentEpoch(), 5);
        assertEq(verification.firstRewardedEpoch(), 6);
    }

    function _setConfigureEnv(
        AntseedRegistry registry,
        AntseedEmissionsGate gate,
        AntseedPointsPolicyRegistry pointsPolicyRegistry,
        address verification,
        address verificationPointsPolicy,
        bool registerVerificationPolicy
    ) private {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_PRIVATE_KEY));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EMISSIONS_GATE", vm.toString(address(gate)));
        vm.setEnv("POINTS_POLICY_REGISTRY", vm.toString(address(pointsPolicyRegistry)));
        vm.setEnv("VERIFICATION", vm.toString(verification));
        vm.setEnv("VERIFICATION_POINTS_POLICY", vm.toString(verificationPointsPolicy));
        vm.setEnv("REGISTER_VERIFICATION_POLICY", registerVerificationPolicy ? "true" : "false");
    }
}
