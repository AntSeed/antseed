// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { TestPointsPolicyRegistry as PointsPolicyRegistry } from "./mocks/TestPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockPointsPolicyStaking {
    mapping(address seller => uint256 agentId) public getAgentId;

    function setAgentId(address seller, uint256 agentId) external {
        getAgentId[seller] = agentId;
    }
}

contract EmptyPointsPolicyTarget { }

contract AntseedVerifierPointsPolicyTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    uint256 private AGENT_ID;
    uint256 private constant RAW_POINTS = 1_000;
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");

    address private seller = address(0xA11CE);
    address private buyer = address(0xB0B);
    address private verifierA = address(0xF00D);
    address private verifierB = address(0xF00E);
    address private verifierC = address(0xF00F);

    AntseedRegistry private registry;
    MockPointsPolicyStaking private staking;
    AntseedVerification private verification;
    AntseedVerificationPointsPolicy private policy;
    PointsPolicyRegistry private pointsPolicyRegistry;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        registry = new AntseedRegistry();
        registry.setTeamWallet(address(0x1111));
        registry.setProtocolReserve(address(0x2222));
        MockERC8004Registry identity = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identity));
        vm.prank(seller);
        AGENT_ID = identity.register();
        staking = new MockPointsPolicyStaking();
        staking.setAgentId(seller, AGENT_ID);
        registry.setStaking(address(staking));
        verification = new AntseedVerification(address(registry));
        policy = new AntseedVerificationPointsPolicy(address(this), address(registry), address(verification));
        pointsPolicyRegistry = new PointsPolicyRegistry(address(this));
        pointsPolicyRegistry.registerPolicy(address(policy));
        verification.setVerifier(verifierA, true);
        verification.setVerifier(verifierB, true);
        verification.setVerifier(verifierC, true);
    }

    function test_noPenaltyPassesAllPointsThrough() public view {
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_oneVerifierCannotTriggerPenalty() public {
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 10_000, keccak256("one-diff"));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_repeatedDiffFromOneVerifierCountsOnce() public {
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 1_000, keccak256("diff-a"));
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 9_000, keccak256("diff-b"));

        assertEq(verification.activeAgentDiffVerifierCount(AGENT_ID), 1);
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_twoDistinctDiffVerifiersTriggerDefaultFullPenalty() public {
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 1, keccak256("diff-a"));
        _submit(verifierB, IAntseedVerification.Verdict.DIFF, 9_999, keccak256("diff-b"));

        _assertPoints(RAW_POINTS, 0, RAW_POINTS);
    }

    function test_sameServiceRetractionRemovesCorroboration() public {
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 2_500, keccak256("diff-a"));
        _submit(verifierB, IAntseedVerification.Verdict.DIFF, 2_500, keccak256("diff-b"));
        _assertPoints(RAW_POINTS, 0, RAW_POINTS);

        _submit(verifierB, IAntseedVerification.Verdict.UNDETERMINED, 0, keccak256("retract-b"));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_configuredPenaltyDiscountsOnlySellerPoints() public {
        policy.setDiffPenaltyBps(2_500);
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 1_000, keccak256("diff-a"));
        _submit(verifierB, IAntseedVerification.Verdict.DIFF, 9_000, keccak256("diff-b"));

        _assertPoints(RAW_POINTS, 750, RAW_POINTS);
    }

    function test_governanceCanOnlyRaiseCorroborationThreshold() public {
        policy.setMinDistinctDiffVerifiers(3);
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 1_000, keccak256("diff-a"));
        _submit(verifierB, IAntseedVerification.Verdict.DIFF, 1_000, keccak256("diff-b"));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);

        _submit(verifierC, IAntseedVerification.Verdict.DIFF, 1_000, keccak256("diff-c"));
        _assertPoints(RAW_POINTS, 0, RAW_POINTS);

        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidMinimumCorroboration.selector);
        policy.setMinDistinctDiffVerifiers(2);
    }

    function test_policyConfigurationIsOwnerOnlyAndBounded() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert();
        policy.setMinDistinctDiffVerifiers(3);
        vm.expectRevert();
        policy.setDiffPenaltyBps(5_000);
        vm.stopPrank();

        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidMinimumCorroboration.selector);
        policy.setMinDistinctDiffVerifiers(1);
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidPenaltyBps.selector);
        policy.setDiffPenaltyBps(10_001);
    }

    function test_unknownSellerPassesAllPointsThrough() public view {
        (uint256 sellerPoints, uint256 buyerPoints) =
            pointsPolicyRegistry.points(bytes32(0), buyer, address(0xCAFE), RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    function test_brokenStakingReadPassesAllPointsThrough() public {
        registry.setStaking(address(new EmptyPointsPolicyTarget()));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_extremePointsDoNotOverflow() public {
        policy.setDiffPenaltyBps(2_500);
        _submit(verifierA, IAntseedVerification.Verdict.DIFF, 2_500, keccak256("extreme-a"));
        _submit(verifierB, IAntseedVerification.Verdict.DIFF, 2_500, keccak256("extreme-b"));
        uint256 rawPoints = type(uint256).max;
        uint256 expectedSellerPoints = (rawPoints / 10_000) * 7_500 + ((rawPoints % 10_000) * 7_500) / 10_000;
        _assertPoints(rawPoints, expectedSellerPoints, rawPoints);
    }

    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(AntseedVerification.InvalidAddress.selector);
        new AntseedVerification(address(0));

        vm.expectRevert();
        new AntseedVerificationPointsPolicy(address(0), address(registry), address(verification));

        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidAddress.selector);
        new AntseedVerificationPointsPolicy(address(this), address(0), address(verification));

        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidAddress.selector);
        new AntseedVerificationPointsPolicy(address(this), address(registry), address(0));
    }

    function _submit(address verifier, IAntseedVerification.Verdict verdict, uint16 modelShareBps, bytes32 evidenceHash)
        private
    {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](1);
        results[0] = IAntseedVerification.VerificationResult({
            agentId: AGENT_ID,
            serviceHash: SERVICE_HASH,
            verdict: verdict,
            modelShareBps: modelShareBps
        });
        vm.prank(verifier);
        verification.submitVerificationBundle(evidenceHash, "", results);
    }

    function _assertPoints(uint256 rawPoints, uint256 expectedSellerPoints, uint256 expectedBuyerPoints) private view {
        (uint256 sellerPoints, uint256 buyerPoints) = pointsPolicyRegistry.points(bytes32(0), buyer, seller, rawPoints);
        assertEq(sellerPoints, expectedSellerPoints);
        assertEq(buyerPoints, expectedBuyerPoints);
    }
}
