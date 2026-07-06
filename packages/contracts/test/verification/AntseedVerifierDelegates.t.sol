// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistryV2 } from "../../core/AntseedRegistryV2.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockDeposits } from "../mocks/MockDeposits.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

/// @notice Delegate voucher claims (AntseedVerifierRegistry) and the delegate
///         share of the verification bucket (AntseedVerifierRewards).
///         Delegates are the organic buyer peers that carry probe traffic for
///         verifiers; a verifier signs an EIP-712 DelegateVoucher naming the
///         buyer, and the buyer's deposits operator claims it on-chain.
contract AntseedVerifierDelegatesTest is Test {
    ANTSToken token;
    AntseedRegistryV2 registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identity;
    MockDeposits deposits;
    AntseedVerifierRegistry verifierRegistry;
    AntseedVerifierRewards verifierRewards;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint32 constant TEAM_SHARE_BPS = 15_000;
    uint32 constant RESERVE_SHARE_BPS = 15_000;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    uint32 constant PROBE_COUNT = 10;

    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    uint256 verifierAKey = 0xA1CE;
    uint256 verifierBKey = 0xB0B1;
    uint256 strangerKey = 0x5712A17;
    address verifierA;
    address verifierB;
    address buyerX = address(0xBD1);
    address buyerY = address(0xBD2);
    address operatorX = address(0x0D1);
    address operatorY = address(0x0D2);
    address sellerOwner = address(0x51);

    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    /// @dev Mirror of the contract constant. Kept local so `_sign` makes no
    ///      external calls — a staticcall would consume a pending vm.prank or
    ///      vm.expectRevert when `_sign(...)` is evaluated as an argument.
    bytes32 constant DELEGATE_VOUCHER_TYPEHASH = keccak256(
        "DelegateVoucher(address buyer,bytes32 probeCommitment,uint32 credits,uint256 nonce,uint256 deadline)"
    );
    uint256 commitSalt;
    uint256 voucherNonce;

    function setUp() public {
        verifierA = vm.addr(verifierAKey);
        verifierB = vm.addr(verifierBKey);

        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistryV2();
        identity = new MockERC8004Registry();
        deposits = new MockDeposits();
        registry.setAntsToken(address(token));
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(address(deposits));
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

        deposits.setOperator(buyerX, operatorX);
        deposits.setOperator(buyerY, operatorY);

        _warpGateEpoch(5);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    /// @dev One credited attestation on a fresh agent + fresh commitment.
    ///     Earns the verifier 1 epoch credit and PROBE_COUNT delegate budget
    ///     on the returned commitment.
    function _attest(address verifier_) internal returns (bytes32 commitment) {
        uint256 agentId = identity.register();
        identity.setOwner(agentId, sellerOwner);

        commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, PROBE_COUNT, 3);
    }

    /// @dev Credited attestations on `commitment` across `count` fresh agents
    ///      (a cohort audit reuses one probe-set commitment), growing its
    ///      delegate budget by count * PROBE_COUNT.
    function _attestCohort(address verifier_, bytes32 commitment, uint256 count) internal {
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        for (uint256 i = 0; i < count; i++) {
            uint256 agentId = identity.register();
            identity.setOwner(agentId, sellerOwner);
            vm.prank(verifier_);
            verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, PROBE_COUNT, 3);
        }
    }

    function _voucher(address buyer, bytes32 commitment, uint32 credits)
        internal
        returns (IAntseedVerifierRegistry.DelegateVoucher memory)
    {
        return IAntseedVerifierRegistry.DelegateVoucher({
            buyer: buyer,
            probeCommitment: commitment,
            credits: credits,
            nonce: ++voucherNonce,
            deadline: block.timestamp + 1 days
        });
    }

    function _digest(IAntseedVerifierRegistry.DelegateVoucher memory v) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AntseedVerifierRegistry"),
                keccak256("1"),
                block.chainid,
                address(verifierRegistry)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                DELEGATE_VOUCHER_TYPEHASH,
                v.buyer,
                v.probeCommitment,
                v.credits,
                v.nonce,
                v.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(uint256 key, IAntseedVerifierRegistry.DelegateVoucher memory v)
        internal
        view
        returns (bytes memory)
    {
        (uint8 vSig, bytes32 r, bytes32 s) = vm.sign(key, _digest(v));
        return abi.encodePacked(r, s, vSig);
    }

    /// @dev Full happy path for one voucher: attest enough budget, sign,
    ///      claim as the buyer's operator.
    function _claimVoucher(uint256 verifierKey, address buyer, address operator, uint32 credits) internal {
        bytes32 commitment = keccak256(abi.encode(vm.addr(verifierKey), ++commitSalt));
        uint256 cohort = (uint256(credits) + PROBE_COUNT - 1) / PROBE_COUNT;
        _attestCohort(vm.addr(verifierKey), commitment, cohort);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyer, commitment, credits);
        bytes memory sig = _sign(verifierKey, v);
        vm.prank(operator);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    // ─── Registry: claimDelegateCredits ──────────────────────────────

    function test_claimAccumulatesAcrossVerifiersAndBuyers() public {
        _claimVoucher(verifierAKey, buyerX, operatorX, 3);
        _claimVoucher(verifierBKey, buyerX, operatorX, 2);
        _claimVoucher(verifierAKey, buyerY, operatorY, 1);

        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 5);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorY), 1);
        assertEq(verifierRegistry.epochTotalDelegateCredits(5), 6);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierA), 4);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierB), 2);
        // Buyer hot wallets are never credited.
        assertEq(verifierRegistry.epochDelegateCredits(5, buyerX), 0);
        assertEq(verifierRegistry.epochDelegateCredits(5, buyerY), 0);
    }

    function test_claimMarksVoucherAndCommitmentAccounting() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 4);
        bytes memory sig = _sign(verifierAKey, v);

        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v, sig);

        assertTrue(verifierRegistry.voucherClaimed(_digest(v)));
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, commitment), PROBE_COUNT);
        assertEq(verifierRegistry.commitmentDelegateCredits(verifierA, commitment), 4);
    }

    function test_claimRejectsReplay() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 2);
        bytes memory sig = _sign(verifierAKey, v);

        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v, sig);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.VoucherAlreadyClaimed.selector);
        verifierRegistry.claimDelegateCredits(v, sig);

        // A distinct nonce is a distinct voucher — claimable within budget.
        IAntseedVerifierRegistry.DelegateVoucher memory v2 = _voucher(buyerX, commitment, 2);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v2, _sign(verifierAKey, v2));
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 4);
    }

    function test_claimRejectsExpiredVoucher() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 1);
        v.deadline = block.timestamp - 1;
        bytes memory sig = _sign(verifierAKey, v);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.VoucherExpired.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimRejectsNonOperatorCaller() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 1);
        bytes memory sig = _sign(verifierAKey, v);

        // The buyer hot wallet itself cannot claim…
        vm.prank(buyerX);
        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
        // …nor an unrelated operator.
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimRejectsBuyerWithoutOperator() public {
        address orphanBuyer = address(0xBD3);
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(orphanBuyer, commitment, 1);
        bytes memory sig = _sign(verifierAKey, v);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimRejectsUnapprovedSigner() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 1);
        bytes memory sig = _sign(strangerKey, v);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimRejectsTamperedVoucher() public {
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 1);
        bytes memory sig = _sign(verifierAKey, v);

        // Inflating credits after signing recovers a different signer.
        v.credits = 5;
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimValidation() public {
        bytes32 commitment = _attest(verifierA);

        IAntseedVerifierRegistry.DelegateVoucher memory zeroBuyer = _voucher(address(0), commitment, 1);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.claimDelegateCredits(zeroBuyer, _sign(verifierAKey, zeroBuyer));

        IAntseedVerifierRegistry.DelegateVoucher memory zeroCredits = _voucher(buyerX, commitment, 0);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.claimDelegateCredits(zeroCredits, _sign(verifierAKey, zeroCredits));
    }

    function test_claimRejectsSelfDelegate() public {
        // Verifier "carrying" its own probes: buyer == verifier.
        deposits.setOperator(verifierA, operatorX);
        bytes32 commitment = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(verifierA, commitment, 1);
        bytes memory sig = _sign(verifierAKey, v);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.SelfDelegate.selector);
        verifierRegistry.claimDelegateCredits(v, sig);

        // Verifier as the buyer's operator: operator == verifier.
        deposits.setOperator(buyerX, verifierA);
        bytes32 commitment2 = _attest(verifierA);
        IAntseedVerifierRegistry.DelegateVoucher memory v2 = _voucher(buyerX, commitment2, 1);
        bytes memory sig2 = _sign(verifierAKey, v2);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerifierRegistry.SelfDelegate.selector);
        verifierRegistry.claimDelegateCredits(v2, sig2);
    }

    // ─── Registry: commitment anchoring ──────────────────────────────

    function test_claimRejectsUnattestedCommitment() public {
        bytes32 commitment = keccak256("never attested");
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 1);
        bytes memory sig = _sign(verifierAKey, v);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBudgetExceeded.selector);
        verifierRegistry.claimDelegateCredits(v, sig);
    }

    function test_claimCapsAtCommitmentBudget() public {
        // One credited attestation: budget PROBE_COUNT (10).
        bytes32 commitment = _attest(verifierA);

        IAntseedVerifierRegistry.DelegateVoucher memory over = _voucher(buyerX, commitment, PROBE_COUNT + 1);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBudgetExceeded.selector);
        verifierRegistry.claimDelegateCredits(over, _sign(verifierAKey, over));

        // Budget is cumulative across vouchers on the same commitment.
        IAntseedVerifierRegistry.DelegateVoucher memory v1 = _voucher(buyerX, commitment, 6);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v1, _sign(verifierAKey, v1));

        IAntseedVerifierRegistry.DelegateVoucher memory v2 = _voucher(buyerY, commitment, 5);
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBudgetExceeded.selector);
        verifierRegistry.claimDelegateCredits(v2, _sign(verifierAKey, v2));

        IAntseedVerifierRegistry.DelegateVoucher memory v3 = _voucher(buyerY, commitment, 4);
        vm.prank(operatorY);
        verifierRegistry.claimDelegateCredits(v3, _sign(verifierAKey, v3));
        assertEq(verifierRegistry.commitmentDelegateCredits(verifierA, commitment), PROBE_COUNT);
    }

    function test_uncreditedAttestationGrowsNoBudget() public {
        // First attestation on the agent/service is credited (budget 10);
        // an immediate re-audit is inside the cooldown → uncredited.
        uint256 agentId = identity.register();
        identity.setOwner(agentId, sellerOwner);

        bytes32 first = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(first);
        vm.warp(block.timestamp + 1);
        vm.prank(verifierA);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, first, PROBE_COUNT, 3);
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, first), PROBE_COUNT);

        bytes32 second = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(second);
        vm.warp(block.timestamp + 1);
        vm.prank(verifierA);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, second, PROBE_COUNT, 3);
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, second), 0);

        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, second, 1);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentBudgetExceeded.selector);
        verifierRegistry.claimDelegateCredits(v, _sign(verifierAKey, v));
    }

    // ─── Registry: per-epoch verifier cap ────────────────────────────

    function test_claimPerEpochCap() public {
        verifierRegistry.setMaxDelegateCreditsPerVerifierPerEpoch(5);

        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        _attestCohort(verifierA, commitment, 2); // budget 20 — cap binds first

        IAntseedVerifierRegistry.DelegateVoucher memory v1 = _voucher(buyerX, commitment, 5);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v1, _sign(verifierAKey, v1));

        IAntseedVerifierRegistry.DelegateVoucher memory v2 = _voucher(buyerY, commitment, 1);
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.DelegateCreditCapExceeded.selector);
        verifierRegistry.claimDelegateCredits(v2, _sign(verifierAKey, v2));

        // Another verifier still has its own allowance…
        _claimVoucher(verifierBKey, buyerY, operatorY, 5);
        // …and the cap resets next epoch (same commitment budget carries over).
        _warpGateEpoch(6);
        IAntseedVerifierRegistry.DelegateVoucher memory v3 = _voucher(buyerX, commitment, 5);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v3, _sign(verifierAKey, v3));
        assertEq(verifierRegistry.epochDelegateCredits(6, operatorX), 5);
    }

    function test_delegateConfigSetters() public {
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setDelegateShareBps(10_001);
        verifierRegistry.setDelegateShareBps(3000);
        assertEq(verifierRegistry.delegateShareBps(), 3000);

        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setMaxDelegateCreditsPerVerifierPerEpoch(0);

        vm.prank(operatorX);
        vm.expectRevert();
        verifierRegistry.setDelegateShareBps(1000);
    }

    // ─── Rewards: delegate pool split ────────────────────────────────

    function test_splitAndClaims() public {
        _attest(verifierA);
        _attest(verifierA);
        _attest(verifierA);
        _attest(verifierB);
        _claimVoucher(verifierAKey, buyerX, operatorX, 3);
        _claimVoucher(verifierBKey, buyerY, operatorY, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertGt(budget, 0);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        // _claimVoucher adds one credited attestation per verifier on top of
        // the explicit _attest calls above: verifierA 3+1=4, verifierB 1+1=2.
        assertEq(verifierRewards.delegateEpochPool(5), delegatePool);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), (verifierPool * 4) / 6);
        assertEq(verifierRewards.pendingDelegateReward(5, operatorX), (delegatePool * 3) / 4);
        assertEq(verifierRewards.pendingDelegateReward(5, operatorY), delegatePool / 4);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        vm.prank(operatorX);
        verifierRewards.claimDelegateReward(5);
        vm.prank(operatorY);
        verifierRewards.claimDelegateReward(5);

        assertEq(token.balanceOf(verifierA), (verifierPool * 4) / 6);
        assertEq(token.balanceOf(verifierB), (verifierPool * 2) / 6);
        assertEq(token.balanceOf(operatorX), (delegatePool * 3) / 4);
        assertEq(token.balanceOf(operatorY), delegatePool / 4);
        uint256 minted = token.balanceOf(verifierA) + token.balanceOf(verifierB)
            + token.balanceOf(operatorX) + token.balanceOf(operatorY);
        assertLe(minted, budget);
        assertEq(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), minted);
    }

    function test_noDelegateCreditsKeepsFullBudgetForVerifiers() public {
        _attest(verifierA);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertEq(verifierRewards.delegateEpochPool(5), 0);
        assertEq(verifierRewards.pendingVerifierReward(5, verifierA), budget);

        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierA), budget);
    }

    function test_delegateClaimGuards() public {
        _claimVoucher(verifierAKey, buyerX, operatorX, 1);

        // Not finalized yet.
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRewards.EpochNotFinalized.selector);
        verifierRewards.claimDelegateReward(5);

        _warpGateEpoch(6);

        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRewards.NothingToClaim.selector);
        verifierRewards.claimDelegateReward(5);

        vm.prank(operatorX);
        verifierRewards.claimDelegateReward(5);
        assertTrue(verifierRewards.epochDelegateRewardClaimed(5, operatorX));
        assertEq(verifierRewards.pendingDelegateReward(5, operatorX), 0);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.claimDelegateReward(5);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRewards.PreEffectiveEpoch.selector);
        verifierRewards.claimDelegateReward(4);
    }

    function test_shareChangeAfterFreezeDoesNotResizePools() public {
        _attest(verifierA);
        _attest(verifierB);
        _claimVoucher(verifierAKey, buyerX, operatorX, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        // _claimVoucher added one credited attestation for verifierA: 2 vs 1.
        // First claim freezes budget AND split.
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierA), (verifierPool * 2) / 3);

        verifierRegistry.setDelegateShareBps(8000);

        // Frozen pools must not move under remaining claimants.
        assertEq(verifierRewards.delegateEpochPool(5), delegatePool);
        vm.prank(verifierB);
        verifierRewards.claimVerifierReward(5);
        assertEq(token.balanceOf(verifierB), verifierPool / 3);
        vm.prank(operatorX);
        verifierRewards.claimDelegateReward(5);
        assertEq(token.balanceOf(operatorX), delegatePool);
    }

    function test_remainderSettlesOnlyVerifierPool() public {
        // Attest in epoch 5, claim the voucher in epoch 6: commitment budget
        // is not epoch-scoped, so epoch 6 ends with delegate credits but zero
        // verifier credits. Only the verifier pool routes through
        // burn/reserve; the delegate pool stays claimable.
        bytes32 commitment = _attest(verifierA);
        _warpGateEpoch(6);
        IAntseedVerifierRegistry.DelegateVoucher memory v = _voucher(buyerX, commitment, 2);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(v, _sign(verifierAKey, v));
        _warpGateEpoch(7);

        uint256 budget = verifierRewards.verifierEpochBudget(6);
        uint256 delegatePool = (budget * 2000) / 10_000;

        (uint256 burned, uint256 reserved) = verifierRewards.settleEpochRemainder(6);
        assertEq(burned + reserved, budget - delegatePool);

        vm.prank(operatorX);
        verifierRewards.claimDelegateReward(6);
        assertEq(token.balanceOf(operatorX), delegatePool);

        vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
        verifierRewards.settleEpochRemainder(6);
    }
}
