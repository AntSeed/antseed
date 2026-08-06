// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract AntseedVerifierRewardsTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    uint256 private constant EPOCH_DURATION = 7 days;
    address private constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");

    address private verifierA = address(0xA11CE);
    address private verifierB = address(0xB0B);
    ANTSToken private token;
    AntseedEmissionsGate private gate;
    AntseedVerification private verification;
    MockERC8004Registry private identity;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry core = new AntseedRegistry();
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        token = ANTSToken(ANTS_TOKEN);
        core.setAntsToken(ANTS_TOKEN);
        core.setTeamWallet(address(0x1111));
        core.setProtocolReserve(address(0x2222));
        identity = new MockERC8004Registry();
        core.setIdentityRegistry(address(identity));
        gate = new AntseedEmissionsGate(address(0x1111), address(0x2222), 15_000, 15_000);
        verification = new AntseedVerification(address(core), address(gate));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verification), 10_000, true);
        token.setRegistry(address(gate));
        gate.fundLegacyEscrow(address(0xE5C0));
        verification.setVerifier(verifierA, true);
        verification.setVerifier(verifierB, true);
    }

    function test_claimsProRataVerifierOnlyPool() public {
        uint256 rewardedEpoch = verification.firstRewardedEpoch();
        _warpToEpoch(rewardedEpoch);
        _submit(verifierA, _register(address(0xCAFE)), keccak256("a"), 1);
        _submit(verifierB, _register(address(0xD00D)), keccak256("b"), 2);

        uint256 budget = verification.verifierEpochBudget(rewardedEpoch);
        _warpToEpoch(rewardedEpoch + 1);
        assertEq(verification.pendingVerifierReward(rewardedEpoch, verifierA), budget / 3);
        assertEq(verification.pendingVerifierReward(rewardedEpoch, verifierB), (budget * 2) / 3);

        vm.prank(verifierA);
        verification.claimVerifierReward(rewardedEpoch);
        vm.prank(verifierB);
        verification.claimVerifierReward(rewardedEpoch);
        assertEq(token.balanceOf(verifierA), budget / 3);
        assertEq(token.balanceOf(verifierB), (budget * 2) / 3);

        vm.prank(verifierA);
        vm.expectRevert(AntseedVerification.NothingToClaim.selector);
        verification.claimVerifierReward(rewardedEpoch);
        assertEq(verification.epochCredits(rewardedEpoch, verifierA), 0);
    }

    function test_zeroCreditEpochCanSettleRemainder() public {
        uint256 rewardedEpoch = verification.firstRewardedEpoch();
        _warpToEpoch(rewardedEpoch + 1);
        (uint256 burned, uint256 reserved) = verification.settleEpochRemainder(rewardedEpoch);
        assertGt(burned + reserved, 0);
        assertTrue(verification.epochRemainderSettled(rewardedEpoch));
    }

    function test_outstandingRewardRemainsClaimableInLaterEpoch() public {
        uint256 rewardedEpoch = verification.firstRewardedEpoch();
        _warpToEpoch(rewardedEpoch);
        _submit(verifierA, _register(address(0xCAFE)), keccak256("delayed"), 1);

        uint256 budget = verification.verifierEpochBudget(rewardedEpoch);
        _warpToEpoch(rewardedEpoch + 10);

        assertEq(verification.pendingVerifierReward(rewardedEpoch, verifierA), budget);
        vm.prank(verifierA);
        verification.claimVerifierReward(rewardedEpoch);
        assertEq(token.balanceOf(verifierA), budget);
        assertEq(verification.epochCredits(rewardedEpoch, verifierA), 0);
        assertEq(verification.pendingVerifierReward(rewardedEpoch, verifierA), 0);
    }

    function _register(address seller) private returns (uint256 agentId) {
        vm.prank(seller);
        agentId = identity.register();
    }

    function _submit(address verifier, uint256 agentId, bytes32 auditId, uint32 credits) private {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](1);
        results[0] = IAntseedVerification.VerificationResult({
            agentId: agentId,
            serviceHash: SERVICE_HASH,
            verdict: IAntseedVerification.Verdict.SAME,
            modelShareBps: 0
        });
        vm.prank(verifier);
        verification.submitVerificationBundle(
            auditId,
            _currentEpoch(),
            uint64(credits) * 1_000_000,
            keccak256(abi.encode("evidence", auditId)),
            credits,
            results
        );
    }

    function _warpToEpoch(uint256 epoch) private {
        vm.warp(gate.GENESIS() + epoch * gate.EPOCH_DURATION() + 1);
    }

    function _currentEpoch() private view returns (uint256) {
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }
}
