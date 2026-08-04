// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract AntseedVerifierRewardsTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    uint256 private constant EPOCH_DURATION = 7 days;
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");

    address private verifierA = address(0xA11CE);
    address private verifierB = address(0xB0B);
    ANTSToken private token;
    AntseedEmissionsGate private gate;
    AntseedVerifierRegistry private registry;
    AntseedVerifierRewards private rewards;
    MockERC8004Registry private identity;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry core = new AntseedRegistry();
        token = new ANTSToken();
        core.setAntsToken(address(token));
        core.setTeamWallet(address(0x1111));
        core.setProtocolReserve(address(0x2222));
        identity = new MockERC8004Registry();
        core.setIdentityRegistry(address(identity));
        gate = new AntseedEmissionsGate(address(core), 15_000, 15_000);
        registry = new AntseedVerifierRegistry(address(core), address(gate));
        rewards = new AntseedVerifierRewards(address(gate), address(registry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(rewards), 10_000, true);
        token.setRegistry(address(gate));
        gate.fundLegacyEscrow(address(0xE5C0));
        registry.setVerifier(verifierA, true);
        registry.setVerifier(verifierB, true);
    }

    function test_claimsProRataVerifierOnlyPool() public {
        uint256 rewardedEpoch = rewards.firstRewardedEpoch();
        _warpToEpoch(rewardedEpoch);
        uint256 agentA = _register(address(0xCAFE));
        uint256 agentB = _register(address(0xD00D));
        uint256 agentC = _register(address(0xF00D));
        _submit(verifierA, agentA, keccak256("a"));
        _submit(verifierB, agentB, keccak256("b"));
        _submit(verifierB, agentC, keccak256("c"));

        uint256 budget = rewards.verifierEpochBudget(rewardedEpoch);
        _warpToEpoch(rewardedEpoch + 1);
        assertEq(rewards.pendingVerifierReward(rewardedEpoch, verifierA), budget / 3);
        assertEq(rewards.pendingVerifierReward(rewardedEpoch, verifierB), (budget * 2) / 3);

        vm.prank(verifierA);
        rewards.claimVerifierReward(rewardedEpoch);
        vm.prank(verifierB);
        rewards.claimVerifierReward(rewardedEpoch);
        assertEq(token.balanceOf(verifierA), budget / 3);
        assertEq(token.balanceOf(verifierB), (budget * 2) / 3);

        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        rewards.claimVerifierReward(rewardedEpoch);
    }

    function test_zeroCreditEpochCanSettleRemainder() public {
        uint256 rewardedEpoch = rewards.firstRewardedEpoch();
        _warpToEpoch(rewardedEpoch + 1);
        (uint256 burned, uint256 reserved) = rewards.settleEpochRemainder(rewardedEpoch);
        assertGt(burned + reserved, 0);
        assertTrue(rewards.epochRemainderSettled(rewardedEpoch));
    }

    function _register(address seller) private returns (uint256 agentId) {
        vm.prank(seller);
        agentId = identity.register();
    }

    function _submit(address verifier, uint256 agentId, bytes32 auditId) private {
        vm.prank(verifier);
        registry.submitVerificationResult(
            auditId,
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            IAntseedVerifierRegistry.MetricSnapshot({
                windowStartedAt: uint64(block.timestamp - 1),
                windowEndedAt: uint64(block.timestamp),
                eligibleAttempts: 100,
                successfulAttempts: 100,
                p50TtftMs: 100,
                p95TtftMs: 200,
                p50OutputTokensPerSecondMilli: 10_000,
                schemaVersion: 1,
                observationsRoot: keccak256(abi.encode(auditId))
            }),
            keccak256(abi.encode("evidence", auditId))
        );
    }

    function _warpToEpoch(uint256 epoch) private {
        vm.warp(gate.GENESIS() + epoch * gate.EPOCH_DURATION() + 1);
    }

    function _currentEpoch() private view returns (uint256) {
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }
}
