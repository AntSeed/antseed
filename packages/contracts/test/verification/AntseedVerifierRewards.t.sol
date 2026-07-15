// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { ResponseAuthFixture } from "./ResponseAuthFixture.sol";

/// @dev Stand-in for `registry.emissions()` pinned at a fixed epoch: models
///      a registry epoch clock lagging the gate's, so credits can land in an
///      epoch the gate already finalized.
contract MockEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract AntseedVerifierRewardsTest is Test, ResponseAuthFixture {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identity;
    AntseedVerifierRegistry verifierRegistry;
    AntseedVerifierRewards verifierRewards;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    address constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint32 constant TEAM_SHARE_BPS = 15_000;
    uint32 constant RESERVE_SHARE_BPS = 15_000;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address emissionsReserveDest = address(0xA1FE);
    address verifierA = address(0xA1);
    address verifierB = address(0xB1);
    address verifierC = address(0xC1);
    address sellerOwner = address(0x51);

    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    /// @dev Signing key + registered agent for the seller whose signed
    ///      exchanges `_anchorBatch` anchors (signature-verified on-chain).
    uint256 constant RECORD_SELLER_KEY = 0x5E11E4;
    uint256 recordAgentId;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        registry.setAntsToken(address(token));
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(address(0xDE0));
        registry.setIdentityRegistry(address(identity));

        // Deploy the gate in epoch 4 (effectiveEpoch 5) and wire the
        // verification bucket in the deploy epoch — minter shares only apply
        // from the NEXT epoch, exactly like the production broadcast.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(address(registry), TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        token.setRegistry(address(gate));
        token.enableTransfers();
        // No bucket mints until the legacy escrow is settled; any recipient
        // address marks the pot funded.
        gate.fundLegacyEscrow(address(0xE5C0));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRewards = new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verifierRewards), VERIFICATION_SHARE_BPS, true);

        // The verifier registry resolves its epoch clock through
        // registry.emissions() — the gate's clock in this fixture.
        registry.setEmissions(address(gate));

        verifierRegistry.setVerifier(verifierA, true);
        verifierRegistry.setVerifier(verifierB, true);
        verifierRegistry.setVerifier(verifierC, true);

        recordAgentId = identity.register();
        identity.setOwner(recordAgentId, vm.addr(RECORD_SELLER_KEY));

        _warpGateEpoch(5);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    /// @dev Anchor a fully SIGNED exchange batch bound to `commitment`,
    ///      sized (12 records) to cover the probe counts these tests attest
    ///      so the anchored probe-count cap never trips. Records derive from
    ///      the commitment so every batch has a distinct root; the buyer in
    ///      every signed payload is the anchoring verifier (no delegate
    ///      accrual side effects).
    function _anchorBatch(address verifier_, bytes32 commitment) internal returns (bytes32 batchRoot) {
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = makeSignedBatch(12, recordAgentId, RECORD_SELLER_KEY, verifier_, commitment);
        vm.prank(verifier_);
        batchRoot = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    /// @dev Earn `credits` verification credits for `verifier_` in the current
    ///      epoch. Each credit audits a fresh agent so the per-service
    ///      cooldown never interferes.
    function _credit(address verifier_, uint256 credits) internal {
        for (uint256 i = 0; i < credits; i++) {
            uint256 agentId = identity.register();
            identity.setOwner(agentId, sellerOwner);

            bytes32 commitment = keccak256(abi.encode(verifier_, ++commitSalt));
            vm.prank(verifier_);
            verifierRegistry.commitProbeSet(commitment);
            vm.warp(block.timestamp + 1);
            bytes32 batchRoot = _anchorBatch(verifier_, commitment);
            vm.prank(verifier_);
            verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, 10, 3);
        }
    }

    // ─── Constructor ─────────────────────────────────────────────────

    function test_constructorZeroChecks() public {
        vm.expectRevert(AntseedVerifierRewards.InvalidAddress.selector);
        new AntseedVerifierRewards(address(0), address(verifierRegistry));
        vm.expectRevert(AntseedVerifierRewards.InvalidAddress.selector);
        new AntseedVerifierRewards(address(gate), address(0));
    }

    // ─── Claiming ────────────────────────────────────────────────────

    function test_proRataSplitAcrossVerifiers() public {
        _credit(verifierA, 3);
        _credit(verifierB, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertEq(budget, gate.minterEpochBudget(VERIFICATION_MINTER_ID, 5));
        assertGt(budget, 0);

        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), (budget * 3) / 4);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierB), budget / 4);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierC), 0);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);

        assertEq(token.balanceOf(verifierA), (budget * 3) / 4);
        assertEq(token.balanceOf(verifierB), budget / 4);
        assertLe(token.balanceOf(verifierA) + token.balanceOf(verifierB), budget);
        assertEq(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), token.balanceOf(verifierA) + token.balanceOf(verifierB));

        assertTrue(verifierRewards.epochRewardClaimed(5, verifierA));
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), 0);
    }

    function test_claimWithoutCreditsReverts() public {
        _credit(verifierA, 1);
        _warpGateEpoch(6);

        vm.prank(verifierC);
        vm.expectRevert(AntseedVerifierRewards.NothingToClaim.selector);
        verifierRewards.claimVerifierReward(5);
    }

    function test_doubleClaimReverts() public {
        _credit(verifierA, 1);
        _warpGateEpoch(6);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.claimVerifierReward(5);
    }

    function test_unfinalizedEpochClaimReverts() public {
        _credit(verifierA, 1);

        vm.startPrank(verifierA);
        vm.expectRevert(AntseedVerifierRewards.EpochNotFinalized.selector);
        verifierRewards.claimVerifierReward(5);
        vm.expectRevert(AntseedVerifierRewards.EpochNotFinalized.selector);
        verifierRewards.claimVerifierReward(7);
        vm.stopPrank();
    }

    function test_preEffectiveEpochClaimReverts() public {
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRewards.PreEffectiveEpoch.selector);
        verifierRewards.claimVerifierReward(4);
    }

    function test_budgetFreezesAtFirstClaim() public {
        _credit(verifierA, 1);
        _credit(verifierB, 1);
        _warpGateEpoch(6);

        uint256 budgetBefore = verifierRewards.verifierEpochBudget(5);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);

        // Rotating the bucket controller zeroes the LIVE budget for this
        // controller, but the frozen epoch pot must not move under B.
        gate.setMinterController(VERIFICATION_MINTER_ID, address(0xBEEF));
        assertEq(gate.controllerEpochBudget(address(verifierRewards), 5), 0);
        assertEq(verifierRewards.verifierEpochBudget(5), budgetBefore);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierB), budgetBefore / 2);

        gate.setMinterController(VERIFICATION_MINTER_ID, address(verifierRewards));
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierB), budgetBefore / 2);
    }

    function test_lateCreditsDoNotShiftFrozenShares() public {
        _credit(verifierA, 1);
        _credit(verifierB, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5); // freezes budget, split AND totals
        assertEq(token.balanceOf(verifierA), budget / 2);
        assertEq(verifierRewards.verifierEpochTotalCredits(5), 2);

        // A lagging registry epoch clock lands a late credit in the already
        // frozen epoch 5.
        MockEpochClock laggingClock = new MockEpochClock();
        laggingClock.setCurrentEpoch(5);
        registry.setEmissions(address(laggingClock));
        _credit(verifierC, 1);
        assertEq(verifierRegistry.epochTotalCredits(5), 3);
        assertEq(verifierRewards.verifierEpochTotalCredits(5), 2, "frozen total must not move");

        // The frozen denominator keeps every pre-freeze SHARE intact: B's
        // pending amount is not diluted by the late credit, and claiming
        // here — BEFORE the late claimant — pays it in full.
        assertEq(verifierRewards.pendingVerifierReward(5, verifierB), budget / 2);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierB), budget / 2);

        // With the pool now exhausted, the late claimer's share against the
        // frozen total no longer fits the gate bucket and the gate's budget
        // guard stops it. This is claim-order dependent, NOT a reserved
        // share: had C claimed before B, C would have been paid and B
        // displaced — see test_lateCreditsCanDisplaceUnclaimedFrozenShares.
        vm.prank(verifierC);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        verifierRewards.claimVerifierReward(5);
    }

    function test_lateCreditsCanDisplaceUnclaimedFrozenShares() public {
        // LIMITATION, pinned executable: freezing the totals finalizes every
        // share already PAID and caps minting at the gate budget, but it does
        // NOT reserve the pool for pre-freeze claimants who have not claimed
        // yet. Under a lagging registry epoch clock (misconfigured wiring —
        // production runs the registry and the gate on one clock) a late
        // credit claims against the nonzero frozen denominator first-come-
        // first-served and can exhaust the pool ahead of them.
        _credit(verifierA, 1);
        _credit(verifierB, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5); // freezes the total at 2
        assertEq(token.balanceOf(verifierA), budget / 2);

        MockEpochClock laggingClock = new MockEpochClock();
        laggingClock.setCurrentEpoch(5);
        registry.setEmissions(address(laggingClock));
        _credit(verifierC, 1);

        // The late claimant claims FIRST: 1 credit against the frozen total
        // of 2 still fits the gate bucket, so it is paid in full.
        vm.prank(verifierC);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierC), budget / 2);

        // The pre-freeze claimant B is displaced — its frozen share no
        // longer fits the exhausted bucket.
        vm.prank(verifierB);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        verifierRewards.claimVerifierReward(5);
        // The hard guarantee holds: the gate budget was never overdrawn.
        assertLe(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), budget);
    }

    function test_lateCreditsAfterZeroCreditFreezeAreUnclaimable() public {
        _warpGateEpoch(6);
        // Settling the zero-credit epoch freezes its totals at zero.
        verifierRewards.settleEpochRemainder(5);

        MockEpochClock laggingClock = new MockEpochClock();
        laggingClock.setCurrentEpoch(5);
        registry.setEmissions(address(laggingClock));
        _credit(verifierA, 1);
        assertEq(verifierRegistry.epochCredits(5, verifierA), 1);

        // The pool already routed through burn/reserve; the late credit is a
        // clean NothingToClaim, not a division panic or a gate revert.
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), 0);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRewards.NothingToClaim.selector);
        verifierRewards.claimVerifierReward(5);
    }

    function test_dewhitelistedVerifierStillClaimsPastEpochRewards() public {
        // Pins current behavior: the whitelist gates ATTESTING, not claiming.
        // Credits already earned in a finalized epoch stay claimable after
        // the verifier is removed from the whitelist.
        _credit(verifierA, 1);
        _warpGateEpoch(6);
        verifierRegistry.setVerifier(verifierA, false);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierA), budget);
    }

    function test_controllerFlipStrandsUnclaimedRewards() public {
        // Pins current behavior: rotating the verification bucket controller
        // deletes THIS controller's minter binding in the gate, stranding
        // every reward not yet claimed through it (the deploy script warns
        // about exactly this).
        _credit(verifierA, 1);
        _credit(verifierB, 1);
        _warpGateEpoch(6);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5); // freezes a nonzero budget

        AntseedVerifierRewards replacement =
            new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        gate.setMinterController(VERIFICATION_MINTER_ID, address(replacement));

        // B's share was frozen under the old controller; after the flip the
        // gate no longer recognizes it as a minter.
        vm.prank(verifierB);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        verifierRewards.claimVerifierReward(5);
    }

    function test_zeroBudgetClaimMarksClaimedWithoutMinting() public {
        _credit(verifierA, 1);
        _warpGateEpoch(6);

        // With the controller rotated away, the live budget for this
        // controller is zero; the claim freezes zero and mints nothing but
        // still spends the claim.
        gate.setMinterController(VERIFICATION_MINTER_ID, address(0xBEEF));
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);

        assertEq(token.balanceOf(verifierA), 0);
        assertTrue(verifierRewards.epochRewardClaimed(5, verifierA));
        assertEq(verifierRewards.verifierEpochBudget(5), 0);
    }

    // ─── Remainder settlement ────────────────────────────────────────

    function test_zeroCreditEpochRemainderSettles() public {
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertGt(budget, 0);

        uint256 deadBefore = token.balanceOf(DEAD_ADDRESS);
        (uint256 burnedAmount, uint256 reserveAmount) = verifierRewards.settleEpochRemainder(5);

        // 10% bucket < 30% epoch burn cap: the whole remainder burns.
        assertEq(burnedAmount, budget);
        assertEq(reserveAmount, 0);
        assertEq(token.balanceOf(DEAD_ADDRESS), deadBefore + budget);
        assertTrue(verifierRewards.epochRemainderSettled(5));
        assertEq(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), budget);

        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.settleEpochRemainder(5);
    }

    function test_remainderSplitsBurnAndReserveAtBurnCap() public {
        _warpGateEpoch(6);

        // Eat 25% of the epoch's 30% burn cap through the team and reserve
        // wallet buckets, so the verification remainder (10%) splits 5%/5%.
        uint256 emission = gate.getEpochEmission(5);
        vm.prank(teamWallet);
        gate.claimRemainder(5, reserve, (emission * 15_000) / 100_000);
        vm.prank(reserve);
        gate.claimRemainder(5, reserve, (emission * 10_000) / 100_000);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        uint256 reserveBefore = token.balanceOf(reserve);
        (uint256 burnedAmount, uint256 reserveAmount) = verifierRewards.settleEpochRemainder(5);

        assertEq(burnedAmount, (emission * 5_000) / 100_000);
        assertEq(reserveAmount, budget - burnedAmount);
        assertEq(token.balanceOf(reserve), reserveBefore + reserveAmount);
    }

    function test_remainderPaysEmissionsReserveWhenSplitConfigured() public {
        gate.setMinterController(gate.RESERVE_MINTER_ID(), emissionsReserveDest);
        _warpGateEpoch(6);

        // Exhaust the burn cap so the whole remainder routes to the reserve
        // destination — which must be the emissions reserve, not the fee one.
        uint256 emission = gate.getEpochEmission(5);
        vm.prank(teamWallet);
        gate.claimRemainder(5, emissionsReserveDest, (emission * 15_000) / 100_000);
        // The configured emissions reserve now controls the reserve bucket.
        vm.prank(emissionsReserveDest);
        gate.claimRemainder(5, emissionsReserveDest, (emission * 15_000) / 100_000);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        (uint256 burnedAmount, uint256 reserveAmount) = verifierRewards.settleEpochRemainder(5);

        // The cap-eating claims above burned in full; only the verification
        // remainder reaches the reserve destination.
        assertEq(burnedAmount, 0);
        assertEq(reserveAmount, budget);
        assertEq(token.balanceOf(emissionsReserveDest), budget);
        assertEq(token.balanceOf(reserve), 0);
    }

    function test_settleWithCreditsReverts() public {
        _credit(verifierA, 1);
        _warpGateEpoch(6);

        vm.expectRevert(AntseedVerifierRewards.NothingToSettle.selector);
        verifierRewards.settleEpochRemainder(5);
    }

    function test_settleUnfinalizedEpochReverts() public {
        vm.expectRevert(AntseedEmissionsGate.EpochNotFinalized.selector);
        verifierRewards.settleEpochRemainder(5);
    }

    function test_settlePreEffectiveEpochReverts() public {
        // Pre-effective epochs precede the bucket's share checkpoint, so their
        // bucket budget is zero and there is nothing to settle; the gate's own
        // PreEffectiveEpoch guard backstops any nonzero path.
        vm.expectRevert(AntseedVerifierRewards.NothingToSettle.selector);
        verifierRewards.settleEpochRemainder(4);
    }

    function test_claimUnaffectedByOtherEpochRemainderSettle() public {
        // Epoch 5 has no credits; epoch 6 has credits for A.
        _warpGateEpoch(6);
        _credit(verifierA, 2);
        _warpGateEpoch(7);

        verifierRewards.settleEpochRemainder(5);

        uint256 budget = verifierRewards.verifierEpochBudget(6);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(6);
        assertEq(token.balanceOf(verifierA), budget);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function test_pendingVerifierRewardEdges() public {
        _credit(verifierA, 1);

        // Unfinalized epoch reads zero.
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), 0);
        // Pre-effective epoch reads zero.
        assertEq(verifierRewards.pendingVerifierReward(4, verifierA), 0);

        _warpGateEpoch(6);
        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), budget);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierB), 0);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), 0);
    }
}
