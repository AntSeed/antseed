// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedWashTradingPointsPolicy } from "../../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract DeploymentLegacyEmissionsMarker { }

contract DeploymentStakingMock {
    mapping(address seller => uint256 agentId) public getAgentId;

    function setAgentId(address seller, uint256 agentId) external {
        getAgentId[seller] = agentId;
    }
}

contract DeploymentWashTradingStatusMock {
    bool public backfillComplete;
    mapping(address seller => uint16 ratioBps) public washRatioBps;

    function isSellerWashTradingFlagged(address seller) external view returns (bool) {
        return washRatioBps[seller] != 0;
    }
}

contract VerifierDeploymentIntegrationTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    address private constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function test_recognizedUsageTopologyRoutesPoliciesThroughEmptyRegistry() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry registry = _deployRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));
        AntseedUsageAccounting usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(address(this));

        usageAccounting.setPointsPolicy(address(pointsPolicyRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verification), 10_000, true);

        assertEq(address(usageAccounting.pointsPolicy()), address(pointsPolicyRegistry));
        assertEq(pointsPolicyRegistry.policyCount(), 0);
        assertEq(address(verification.registry()), address(registry));
        assertEq(address(verification.emissionsGate()), address(gate));
        (address controller, uint32 shareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, address(verification));
        assertEq(shareBps, 10_000);
    }

    function test_lateVerifierDeploymentStartsRewardsNextEpoch() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry registry = _deployRegistry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);

        vm.warp(GENESIS + 5 * gate.EPOCH_DURATION() + 1);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));

        assertEq(verification.currentEpoch(), 5);
        assertEq(verification.firstRewardedEpoch(), 6);
    }

    function test_firstEpochConfigurationRegistersWashAndKeepsVerificationShadowOnly() public {
        vm.warp(GENESIS + 8 days);
        address seller = address(0xCAFE);
        AntseedRegistry registry = _deployRegistry();
        DeploymentLegacyEmissionsMarker legacyEmissions = new DeploymentLegacyEmissionsMarker();
        DeploymentStakingMock legacyStaking = new DeploymentStakingMock();
        legacyStaking.setAgentId(seller, 42);
        registry.setEmissions(address(legacyEmissions));
        registry.setStaking(address(legacyStaking));

        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedVerification verification = new AntseedVerification(address(registry), address(gate));
        AntseedUsageAccounting usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(address(this));
        DeploymentWashTradingStatusMock washStatus = new DeploymentWashTradingStatusMock();
        AntseedWashTradingPointsPolicy washPolicy = new AntseedWashTradingPointsPolicy(address(washStatus));
        AntseedVerificationPointsPolicy verificationPolicy =
            new AntseedVerificationPointsPolicy(address(this), address(registry), address(verification));

        usageAccounting.setPointsPolicy(address(pointsPolicyRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verification), 10_000, true);
        pointsPolicyRegistry.registerPolicy(address(washPolicy));

        assertEq(address(usageAccounting.pointsPolicy()), address(pointsPolicyRegistry));
        assertEq(pointsPolicyRegistry.policyCount(), 1);
        assertTrue(pointsPolicyRegistry.isPolicyRegistered(address(washPolicy)));
        assertFalse(pointsPolicyRegistry.isPolicyRegistered(address(verificationPolicy)));
        assertGt(address(verification).code.length, 0);
        (address controller, uint32 shareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, address(verification));
        assertEq(shareBps, 10_000);

        (uint16 washSellerPenalty, uint16 washBuyerPenalty) =
            washPolicy.penaltyBps(bytes32(0), address(0xB0B), seller, 1_000);
        (uint16 verificationSellerPenalty, uint16 verificationBuyerPenalty) =
            verificationPolicy.penaltyBps(bytes32(0), address(0xB0B), seller, 1_000);
        assertEq(washSellerPenalty, 0);
        assertEq(washBuyerPenalty, 0);
        assertEq(verificationSellerPenalty, 0);
        assertEq(verificationBuyerPenalty, 0);
        (uint256 sellerPoints, uint256 buyerPoints) =
            pointsPolicyRegistry.points(bytes32(0), address(0xB0B), seller, 1_000);
        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);

        assertEq(usageAccounting.firstRewardedEpoch(), gate.effectiveEpoch());
        assertEq(verification.firstRewardedEpoch(), gate.effectiveEpoch());
        assertEq(registry.emissions(), address(legacyEmissions));
        assertEq(registry.staking(), address(legacyStaking));

        vm.warp(GENESIS + gate.effectiveEpoch() * gate.EPOCH_DURATION() + 1);
        assertEq(registry.emissions(), address(legacyEmissions));
        assertEq(registry.staking(), address(legacyStaking));
    }

    function _deployRegistry() private returns (AntseedRegistry registry) {
        registry = new AntseedRegistry();
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setIdentityRegistry(address(new MockERC8004Registry()));
        registry.setTeamWallet(address(0xA11CE));
        registry.setProtocolReserve(address(0xB0B));
    }
}
