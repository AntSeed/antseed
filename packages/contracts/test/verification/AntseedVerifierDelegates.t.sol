// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistryV2 } from "../../core/AntseedRegistryV2.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

/// @notice Delegate crediting (AntseedVerifierRegistry) and the delegate
///         share of the verification bucket (AntseedVerifierRewards).
///         Delegates are the organic buyer peers that carry probe traffic
///         for verifiers; they are credited by payout (operator) address.
contract AntseedVerifierDelegatesTest is Test {
    ANTSToken token;
    AntseedRegistryV2 registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identity;
    AntseedVerifierRegistry verifierRegistry;
    AntseedVerifierRewards verifierRewards;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint32 constant TEAM_SHARE_BPS = 15_000;
    uint32 constant RESERVE_SHARE_BPS = 15_000;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address verifierA = address(0xA1);
    address verifierB = address(0xB1);
    address delegateX = address(0xD1);
    address delegateY = address(0xD2);
    address sellerOwner = address(0x51);

    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistryV2();
        identity = new MockERC8004Registry();
        registry.setAntsToken(address(token));
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(address(0xDE0));
        registry.setIdentityRegistry(address(identity));

        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(address(registry), TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        token.setRegistry(address(gate));
        token.enableTransfers();
        gate.fundLegacyEscrow(address(0xE5C0));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRewards = new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verifierRewards), VERIFICATION_SHARE_BPS, true);
        registry.setEmissions(address(gate));

        verifierRegistry.setVerifier(verifierA, true);
        verifierRegistry.setVerifier(verifierB, true);

        _warpGateEpoch(5);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _credit(address verifier_, uint256 credits) internal {
        for (uint256 i = 0; i < credits; i++) {
            uint256 agentId = identity.register();
            identity.setOwner(agentId, sellerOwner);

            bytes32 commitment = keccak256(abi.encode(verifier_, ++commitSalt));
            vm.prank(verifier_);
            verifierRegistry.commitProbeSet(commitment);
            vm.warp(block.timestamp + 1);
            vm.prank(verifier_);
            verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
        }
    }

    function _creditDelegate(address verifier_, address delegate_, uint32 amount) internal {
        address[] memory delegates = new address[](1);
        uint32[] memory credits = new uint32[](1);
        delegates[0] = delegate_;
        credits[0] = amount;
        vm.prank(verifier_);
        verifierRegistry.creditDelegates(delegates, credits);
    }

    // ─── Registry: creditDelegates ───────────────────────────────────

    function test_creditDelegatesAccumulates() public {
        _creditDelegate(verifierA, delegateX, 3);
        _creditDelegate(verifierB, delegateX, 2);
        _creditDelegate(verifierA, delegateY, 1);

        assertEq(verifierRegistry.epochDelegateCredits(5, delegateX), 5);
        assertEq(verifierRegistry.epochDelegateCredits(5, delegateY), 1);
        assertEq(verifierRegistry.epochTotalDelegateCredits(5), 6);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierA), 4);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierB), 2);
    }

    function test_creditDelegatesOnlyApprovedVerifier() public {
        address[] memory delegates = new address[](1);
        uint32[] memory credits = new uint32[](1);
        delegates[0] = delegateX;
        credits[0] = 1;
        vm.prank(delegateX);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.creditDelegates(delegates, credits);
    }

    function test_creditDelegatesValidation() public {
        address[] memory one = new address[](1);
        uint32[] memory two = new uint32[](2);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.LengthMismatch.selector);
        verifierRegistry.creditDelegates(one, two);

        address[] memory none = new address[](0);
        uint32[] memory noneC = new uint32[](0);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.creditDelegates(none, noneC);

        address[] memory delegates = new address[](1);
        uint32[] memory credits = new uint32[](1);
        delegates[0] = address(0);
        credits[0] = 1;
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.creditDelegates(delegates, credits);

        delegates[0] = delegateX;
        credits[0] = 0;
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.creditDelegates(delegates, credits);

        delegates[0] = verifierA;
        credits[0] = 1;
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.SelfDelegate.selector);
        verifierRegistry.creditDelegates(delegates, credits);

        address[] memory tooMany = new address[](verifierRegistry.MAX_DELEGATES_PER_BATCH() + 1);
        uint32[] memory tooManyC = new uint32[](tooMany.length);
        for (uint256 i = 0; i < tooMany.length; i++) {
            tooMany[i] = address(uint160(0x1000 + i));
            tooManyC[i] = 1;
        }
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.BatchTooLarge.selector);
        verifierRegistry.creditDelegates(tooMany, tooManyC);
    }

    function test_creditDelegatesPerEpochCap() public {
        verifierRegistry.setMaxDelegateCreditsPerVerifierPerEpoch(5);
        _creditDelegate(verifierA, delegateX, 5);

        vm.prank(verifierA);
        address[] memory delegates = new address[](1);
        uint32[] memory credits = new uint32[](1);
        delegates[0] = delegateY;
        credits[0] = 1;
        vm.expectRevert(AntseedVerifierRegistry.DelegateCreditCapExceeded.selector);
        verifierRegistry.creditDelegates(delegates, credits);

        // Another verifier still has its own allowance…
        _creditDelegate(verifierB, delegateY, 5);
        // …and the cap resets next epoch.
        _warpGateEpoch(6);
        _creditDelegate(verifierA, delegateX, 5);
        assertEq(verifierRegistry.epochDelegateCredits(6, delegateX), 5);
    }

    function test_delegateConfigSetters() public {
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setDelegateShareBps(10_001);
        verifierRegistry.setDelegateShareBps(3000);
        assertEq(verifierRegistry.delegateShareBps(), 3000);

        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setMaxDelegateCreditsPerVerifierPerEpoch(0);

        vm.prank(delegateX);
        vm.expectRevert();
        verifierRegistry.setDelegateShareBps(1000);
    }

    // ─── Rewards: delegate pool split ────────────────────────────────

    function test_splitAndClaims() public {
        _credit(verifierA, 3);
        _credit(verifierB, 1);
        _creditDelegate(verifierA, delegateX, 3);
        _creditDelegate(verifierB, delegateY, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertGt(budget, 0);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        assertEq(verifierRewards.delegateEpochPool(5), delegatePool);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), (verifierPool * 3) / 4);
        assertEq(verifierRewards.pendingDelegateReward(5, delegateX), (delegatePool * 3) / 4);
        assertEq(verifierRewards.pendingDelegateReward(5, delegateY), delegatePool / 4);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        vm.prank(delegateX);
        verifierRewards.claimDelegateReward(5);
        vm.prank(delegateY);
        verifierRewards.claimDelegateReward(5);

        assertEq(token.balanceOf(verifierA), (verifierPool * 3) / 4);
        assertEq(token.balanceOf(verifierB), verifierPool / 4);
        assertEq(token.balanceOf(delegateX), (delegatePool * 3) / 4);
        assertEq(token.balanceOf(delegateY), delegatePool / 4);
        uint256 minted = token.balanceOf(verifierA) + token.balanceOf(verifierB)
            + token.balanceOf(delegateX) + token.balanceOf(delegateY);
        assertLe(minted, budget);
        assertEq(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), minted);
    }

    function test_noDelegateCreditsKeepsFullBudgetForVerifiers() public {
        _credit(verifierA, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertEq(verifierRewards.delegateEpochPool(5), 0);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), budget);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierA), budget);
    }

    function test_delegateClaimGuards() public {
        _creditDelegate(verifierA, delegateX, 1);

        // Not finalized yet.
        vm.prank(delegateX);
        vm.expectRevert(AntseedVerifierRewards.EpochNotFinalized.selector);
        verifierRewards.claimDelegateReward(5);

        _warpGateEpoch(6);

        vm.prank(delegateY);
        vm.expectRevert(AntseedVerifierRewards.NothingToClaim.selector);
        verifierRewards.claimDelegateReward(5);

        vm.prank(delegateX);
        verifierRewards.claimDelegateReward(5);
        assertTrue(verifierRewards.epochDelegateRewardClaimed(5, delegateX));
        assertEq(verifierRewards.pendingDelegateReward(5, delegateX), 0);
        vm.prank(delegateX);
        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.claimDelegateReward(5);

        vm.prank(delegateX);
        vm.expectRevert(AntseedVerifierRewards.PreEffectiveEpoch.selector);
        verifierRewards.claimDelegateReward(4);
    }

    function test_shareChangeAfterFreezeDoesNotResizePools() public {
        _credit(verifierA, 1);
        _credit(verifierB, 1);
        _creditDelegate(verifierA, delegateX, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        // First claim freezes budget AND split.
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierA), verifierPool / 2);

        verifierRegistry.setDelegateShareBps(8000);

        // Frozen pools must not move under remaining claimants.
        assertEq(verifierRewards.delegateEpochPool(5), delegatePool);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierB), verifierPool / 2);
        vm.prank(delegateX);
        verifierRewards.claimDelegateReward(5);
        assertEq(token.balanceOf(delegateX), delegatePool);
    }

    function test_remainderSettlesOnlyVerifierPool() public {
        // Delegate credits but zero verifier credits: the delegate pool stays
        // claimable, only the verifier pool routes through burn/reserve.
        _creditDelegate(verifierA, delegateX, 2);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        uint256 delegatePool = (budget * 2000) / 10_000;

        (uint256 burned, uint256 reserved) = verifierRewards.settleEpochRemainder(5);
        assertEq(burned + reserved, budget - delegatePool);

        vm.prank(delegateX);
        verifierRewards.claimDelegateReward(5);
        assertEq(token.balanceOf(delegateX), delegatePool);

        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.settleEpochRemainder(5);
    }
}
