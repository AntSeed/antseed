// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
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
    uint256 private constant AGENT_ID = 42;
    uint256 private constant RAW_POINTS = 1_000;
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");

    address private seller = address(0xA11CE);
    address private buyer = address(0xB0B);
    address private verifier = address(0xF00D);

    AntseedRegistry private registry;
    MockPointsPolicyStaking private staking;
    AntseedVerification private verification;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        registry = new AntseedRegistry();
        registry.setTeamWallet(address(0x1111));
        registry.setProtocolReserve(address(0x2222));
        MockERC8004Registry identity = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identity));
        staking = new MockPointsPolicyStaking();
        staking.setAgentId(seller, AGENT_ID);
        registry.setStaking(address(staking));
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0x1111), address(0x2222), 15_000, 15_000);
        verification = new AntseedVerification(address(registry), address(gate));
        verification.setVerifier(verifier, true);
        identity.setOwner(AGENT_ID, seller);
    }

    function test_noPenaltyPassesAllPointsThrough() public view {
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_proportionalPenaltyDiscountsSellerPoints() public {
        _submit(IAntseedVerification.Verdict.DIFF, 2_500, keccak256("diff"));
        _assertPoints(RAW_POINTS, 750, RAW_POINTS);
    }

    function test_penaltyStaysActiveUntilCleared() public {
        _submit(IAntseedVerification.Verdict.DIFF, 2_500, keccak256("diff"));
        _assertPoints(RAW_POINTS, 750, RAW_POINTS);
        _submit(IAntseedVerification.Verdict.SAME, 0, keccak256("same"));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_fullPenaltyZeroesSellerPoints() public {
        _submit(IAntseedVerification.Verdict.DIFF, 10_000, keccak256("full"));
        _assertPoints(RAW_POINTS, 0, RAW_POINTS);
    }

    function test_unknownSellerPassesAllPointsThrough() public view {
        (uint256 sellerPoints, uint256 buyerPoints) =
            verification.points(bytes32(0), buyer, address(0xCAFE), RAW_POINTS);
        assertEq(sellerPoints, RAW_POINTS);
        assertEq(buyerPoints, RAW_POINTS);
    }

    function test_brokenStakingReadPassesAllPointsThrough() public {
        registry.setStaking(address(new EmptyPointsPolicyTarget()));
        _assertPoints(RAW_POINTS, RAW_POINTS, RAW_POINTS);
    }

    function test_extremePointsDoNotOverflow() public {
        _submit(IAntseedVerification.Verdict.DIFF, 2_500, keccak256("extreme"));
        uint256 rawPoints = type(uint256).max;
        uint256 expectedSellerPoints = (rawPoints / 10_000) * 7_500 + ((rawPoints % 10_000) * 7_500) / 10_000;
        _assertPoints(rawPoints, expectedSellerPoints, rawPoints);
    }

    function test_constructorRejectsZeroAddress() public {
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0x1111), address(0x2222), 15_000, 15_000);
        vm.expectRevert(AntseedVerification.InvalidAddress.selector);
        new AntseedVerification(address(0), address(gate));
    }

    function _submit(IAntseedVerification.Verdict verdict, uint16 modelShareBps, bytes32 evidenceHash) private {
        uint256 epoch = verification.currentEpoch();
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](1);
        results[0] = IAntseedVerification.VerificationResult({
            agentId: AGENT_ID,
            serviceHash: SERVICE_HASH,
            verdict: verdict,
            modelShareBps: modelShareBps
        });
        vm.prank(verifier);
        verification.submitVerificationBundle(
            epoch,
            1_000_000,
            evidenceHash,
            "",
            results
        );
    }

    function _assertPoints(uint256 rawPoints, uint256 expectedSellerPoints, uint256 expectedBuyerPoints) private view {
        (uint256 sellerPoints, uint256 buyerPoints) = verification.points(bytes32(0), buyer, seller, rawPoints);
        assertEq(sellerPoints, expectedSellerPoints);
        assertEq(buyerPoints, expectedBuyerPoints);
    }
}
