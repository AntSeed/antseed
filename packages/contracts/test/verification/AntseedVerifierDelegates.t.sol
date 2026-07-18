// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockDeposits } from "../mocks/MockDeposits.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { ResponseAuthFixture } from "./ResponseAuthFixture.sol";

/// @notice Delegate credit accrual + claims (AntseedVerifierRegistry) and the
///         delegate share of the verification bucket (AntseedVerifierRewards).
///         Delegates are the organic buyer peers that carry probe traffic for
///         verifiers. WHO carried WHAT is proven at anchor time: every
///         anchored exchange's seller-signed ResponseAuth payload names the
///         carrier buyer, `anchorExchangeBatch` verifies the signature
///         on-chain and accrues the record's probe count to that buyer, and
///         the buyer's deposits operator claims the accrued credits via
///         `claimDelegateCredits(verifier, probeCommitment, buyer, agentId,
///         serviceHash)` — accrual and budget are keyed by the audited
///         target, so a credited attestation only backs the carriers of
///         that exact target. This replaced the off-chain EIP-712
///         DelegateVoucher flow.
/// @dev Stand-in for `registry.emissions()` pinned at a fixed epoch: models
///      a registry epoch clock lagging the gate's, so delegate credits can
///      land in an epoch the gate already finalized.
contract MockEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract AntseedVerifierDelegatesTest is Test, ResponseAuthFixture {
    ANTSToken token;
    AntseedRegistry registry;
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
    address verifierA = address(0xA1CE);
    address verifierB = address(0xB0B1);
    address stranger = address(0x571241A7);
    address buyerX = address(0xBD1);
    address buyerY = address(0xBD2);
    address operatorX = address(0x0D1);
    address operatorY = address(0x0D2);

    bytes32 constant SERVICE_HASH = keccak256("anthropic/claude-opus-4");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    /// @dev Signing key + registered agent for the seller whose signed
    ///      exchanges the anchor helpers anchor (signature-verified on-chain).
    uint256 constant RECORD_SELLER_KEY = 0x5E11E4;
    uint256 constant TARGETS_PER_BATCH = 4;
    mapping(bytes32 batchRoot => uint256[] targetAgentIds) private _batchTargetAgents;
    mapping(bytes32 batchRoot => uint256 cursor) private _batchTargetCursor;
    mapping(bytes32 verifierCommitment => uint256 agentId) private _commitmentFirstAgent;

    event DelegateCreditsAccrued(
        address indexed verifier,
        bytes32 indexed probeCommitment,
        address indexed buyer,
        uint256 agentId,
        bytes32 serviceHash,
        uint32 credits
    );
    event DelegateCredited(
        uint256 indexed epoch, address indexed verifier, address indexed delegate, bytes32 probeCommitment,
        bytes32 targetKey, uint32 credits
    );

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
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

    /// @dev Anchor a two-record signed batch bound to `commitment`: record 0
    ///      is carried by `carrier` and declares `carrierProbes` probes
    ///      (accruing them to the carrier unless carrier == verifier or
    ///      carrier == seller); record 1 is self-carried by the verifier and
    ///      declares PROBE_COUNT probes, so any PROBE_COUNT attestation fits
    ///      the batch's probe-count cap regardless of `carrierProbes`.
    function _anchorWithCarrier(address verifier_, bytes32 commitment, address carrier, uint32 carrierProbes)
        internal
        returns (bytes32 batchRoot)
    {
        uint256[] memory targetAgentIds = new uint256[](TARGETS_PER_BATCH);
        for (uint256 i = 0; i < targetAgentIds.length; i++) {
            targetAgentIds[i] = identity.register();
            identity.setOwner(targetAgentIds[i], vm.addr(RECORD_SELLER_KEY));
        }
        return _anchorTargetsWithCarrier(verifier_, commitment, carrier, carrierProbes, targetAgentIds);
    }

    function _anchorForAgentWithCarrier(
        address verifier_,
        bytes32 commitment,
        uint256 targetAgentId,
        address carrier,
        uint32 carrierProbes
    ) internal returns (bytes32 batchRoot) {
        uint256[] memory targetAgentIds = new uint256[](1);
        targetAgentIds[0] = targetAgentId;
        return _anchorTargetsWithCarrier(verifier_, commitment, carrier, carrierProbes, targetAgentIds);
    }

    function _anchorTargetsWithCarrier(
        address verifier_,
        bytes32 commitment,
        address carrier,
        uint32 carrierProbes,
        uint256[] memory targetAgentIds
    ) internal returns (bytes32 batchRoot) {
        // NOTE: external self-call (`this.`) on purpose — it keeps the
        // signed-record construction out of the caller's inlined stack
        // frame; fully inlined under via-ir the accrue+claim test bodies
        // hit "stack too deep".
        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = this.buildCarrierBatch(verifier_, commitment, carrier, carrierProbes, targetAgentIds);
        vm.prank(verifier_);
        batchRoot = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        for (uint256 i = 0; i < targetAgentIds.length; i++) {
            _batchTargetAgents[batchRoot].push(targetAgentIds[i]);
        }
        _commitmentFirstAgent[keccak256(abi.encodePacked(verifier_, commitment))] = targetAgentIds[0];
    }

    /// @dev See `_anchorWithCarrier` — called via `this.` only.
    function buildCarrierBatch(
        address verifier_,
        bytes32 commitment,
        address carrier,
        uint32 carrierProbes,
        uint256[] calldata targetAgentIds
    )
        external
        view
        returns (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        )
    {
        records = new IAntseedVerifierRegistry.ExchangeRecord[](targetAgentIds.length * PROBE_COUNT);
        payloads = new bytes[](records.length);
        counts = new uint32[](records.length);
        require(carrierProbes <= records.length, "carrier probes exceed target capacity");
        for (uint256 i = 0; i < records.length; i++) {
            uint256 targetAgentId = targetAgentIds[i / PROBE_COUNT];
            address buyer = i < carrierProbes ? carrier : verifier_;
            (records[i], payloads[i]) = makeSignedRecord(
                targetAgentId, RECORD_SELLER_KEY, buyer, keccak256(abi.encode(commitment, commitSalt, i))
            );
            counts[i] = 1;
        }
    }

    /// @dev Anchor a fully SIGNED exchange batch bound to `commitment`,
    ///      self-carried by the verifier (no delegate accrual side effects).
    function _anchorBatch(address verifier_, bytes32 commitment) internal returns (bytes32 batchRoot) {
        return _anchorWithCarrier(verifier_, commitment, verifier_, 0);
    }

    /// @dev Credited attestation referencing `commitment`/`batchRoot` on a
    ///      fresh agent (fresh agent → the per-service cooldown never trips).
    function _attestOn(address verifier_, bytes32 commitment, bytes32 batchRoot) internal {
        uint256 cursor = _batchTargetCursor[batchRoot];
        uint256 agentId = _batchTargetAgents[batchRoot][cursor];
        _batchTargetCursor[batchRoot] = cursor + 1;
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, PROBE_COUNT, 3
        );
    }

    /// @dev One credited attestation on a fresh agent + fresh commitment,
    ///      no carrier accrual. Earns the verifier 1 epoch credit and
    ///      PROBE_COUNT delegate budget on the returned commitment.
    function _attest(address verifier_) internal returns (bytes32 commitment) {
        commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchorBatch(verifier_, commitment);
        _attestOn(verifier_, commitment, batchRoot);
    }

    /// @dev Commit + anchor with `credits` accrued to `carrier`, WITHOUT any
    ///      attestation — the commitment's delegate budget stays 0.
    function _accrueOnly(address verifier_, address carrier, uint32 credits) internal returns (bytes32 commitment) {
        commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        _anchorWithCarrier(verifier_, commitment, carrier, credits);
    }

    /// @dev Commit + anchor with `credits` accrued to `carrier` + enough
    ///      credited attestations (ceil(credits / PROBE_COUNT), min 1) that
    ///      the commitment budget covers the accrual.
    function _accrueAndAttest(address verifier_, address carrier, uint32 credits)
        internal
        returns (bytes32 commitment)
    {
        commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchorWithCarrier(verifier_, commitment, carrier, credits);
        uint256 cohort = (uint256(credits) + PROBE_COUNT - 1) / PROBE_COUNT;
        if (cohort == 0) cohort = 1;
        for (uint256 i = 0; i < cohort; i++) {
            _attestOn(verifier_, commitment, batchRoot);
        }
    }

    /// @dev The agentId carrier accrual landed on for `commitment`: the
    ///      anchored batch's first target (the batch builders route carrier
    ///      records to the front targets in order, PROBE_COUNT records
    ///      each). Tracked in test storage — NOT read back from the
    ///      registry — so `_claimAs`/`_key` make no external call and stay
    ///      safe inside vm.expectRevert / vm.expectEmit windows.
    function _accrualAgent(address verifier_, bytes32 commitment) internal view returns (uint256) {
        return _commitmentFirstAgent[keccak256(abi.encodePacked(verifier_, commitment))];
    }

    /// @dev Target key of the commitment's first target — where carrier
    ///      accrual (≤ PROBE_COUNT probes) and the first attestation's
    ///      budget both land. Local mirror of `delegateTargetKey`.
    function _key(address verifier_, bytes32 commitment) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_accrualAgent(verifier_, commitment), SERVICE_HASH));
    }

    /// @dev Claim `buyer`'s accrual on the commitment's first target as
    ///      `operator`.
    function _claimAs(address operator, address verifier_, bytes32 commitment, address buyer) internal {
        uint256 agentId = _accrualAgent(verifier_, commitment);
        vm.prank(operator);
        verifierRegistry.claimDelegateCredits(verifier_, commitment, buyer, agentId, SERVICE_HASH);
    }

    /// @dev Full happy path for one carrier: accrue + back with budget +
    ///      claim as the buyer's operator.
    function _carryAndClaim(address verifier_, address buyer, address operator, uint32 credits) internal {
        bytes32 commitment = _accrueAndAttest(verifier_, buyer, credits);
        _claimAs(operator, verifier_, commitment, buyer);
    }

    // ─── Registry: accrual bookkeeping ───────────────────────────────

    function test_anchorAccruesToCarrierNotSelf() public {
        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);

        _anchorWithCarrier(verifierA, commitment, buyerX, 4);

        bytes32 key = _key(verifierA, commitment);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key, buyerX), 4);
        // The verifier-carried pad record accrues nothing.
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key, verifierA), 0);
    }

    function test_verifierCarriedBatchAccruesNothing() public {
        // buyer == verifier in every signed payload → zero accrual.
        bytes32 commitment = _accrueOnly(verifierA, verifierA, 5);
        assertEq(
            verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, _key(verifierA, commitment), verifierA),
            0
        );
    }

    // ─── Registry: claimDelegateCredits ──────────────────────────────

    function test_claimAccumulatesAcrossVerifiersAndBuyers() public {
        _carryAndClaim(verifierA, buyerX, operatorX, 3);
        _carryAndClaim(verifierB, buyerX, operatorX, 2);
        _carryAndClaim(verifierA, buyerY, operatorY, 1);

        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 5);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorY), 1);
        assertEq(verifierRegistry.epochTotalDelegateCredits(5), 6);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierA), 4);
        assertEq(verifierRegistry.epochDelegateCreditsGrantedBy(5, verifierB), 2);
        // Buyer hot wallets are never credited.
        assertEq(verifierRegistry.epochDelegateCredits(5, buyerX), 0);
        assertEq(verifierRegistry.epochDelegateCredits(5, buyerY), 0);
    }

    function test_claimMarksAccrualAndCommitmentAccounting() public {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 4);
        bytes32 key = _key(verifierA, commitment);

        vm.expectEmit(true, true, true, true);
        emit DelegateCredited(5, verifierA, operatorX, commitment, key, 4);
        _claimAs(operatorX, verifierA, commitment, buyerX);

        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key, buyerX), 4);
        assertEq(verifierRegistry.commitmentDelegateClaimed(verifierA, commitment, key, buyerX), 4);
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, commitment, key), PROBE_COUNT);
        assertEq(verifierRegistry.commitmentDelegateCredits(verifierA, commitment, key), 4);
    }

    function test_doubleClaimYieldsNothing() public {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 2);

        _claimAs(operatorX, verifierA, commitment, buyerX);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 2);

        // Nothing left on the key: the second claim reverts.
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        _claimAs(operatorX, verifierA, commitment, buyerX);

        assertEq(
            verifierRegistry.commitmentDelegateClaimed(verifierA, commitment, _key(verifierA, commitment), buyerX), 2
        );
    }

    function test_sameCommitmentValueAccruesIndependentlyPerVerifier() public {
        // Accruals are keyed (verifier, commitment, buyer): two verifiers
        // using the SAME commitment value never touch each other's ledger.
        bytes32 shared = keccak256("shared commitment value");
        for (uint256 i = 0; i < 2; i++) {
            address v = i == 0 ? verifierA : verifierB;
            commitSalt++;
            vm.prank(v);
            verifierRegistry.commitProbeSet(shared);
            vm.warp(block.timestamp + 1);
            bytes32 root = _anchorWithCarrier(v, shared, buyerX, 2);
            _attestOn(v, shared, root);
        }

        _claimAs(operatorX, verifierA, shared, buyerX);
        _claimAs(operatorX, verifierB, shared, buyerX);

        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 4);
        assertEq(verifierRegistry.commitmentDelegateClaimed(verifierA, shared, _key(verifierA, shared), buyerX), 2);
        assertEq(verifierRegistry.commitmentDelegateClaimed(verifierB, shared, _key(verifierB, shared), buyerX), 2);
    }

    function test_claimRejectsNonOperatorCaller() public {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 1);
        uint256 agentId = _accrualAgent(verifierA, commitment);

        // The buyer hot wallet itself cannot claim…
        vm.prank(buyerX);
        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agentId, SERVICE_HASH);
        // …nor an unrelated operator.
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agentId, SERVICE_HASH);
    }

    function test_claimRejectsBuyerWithoutOperator() public {
        address orphanBuyer = address(0xBD3);
        bytes32 commitment = _accrueAndAttest(verifierA, orphanBuyer, 1);

        vm.expectRevert(AntseedVerifierRegistry.NotBuyerOperator.selector);
        _claimAs(operatorX, verifierA, commitment, orphanBuyer);
    }

    function test_claimRejectsUnapprovedVerifier() public {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 1);
        uint256 agentId = _accrualAgent(verifierA, commitment);

        // Naming a never-approved verifier (regardless of any accrual).
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.claimDelegateCredits(stranger, commitment, buyerX, agentId, SERVICE_HASH);
    }

    function test_claimValidation() public {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 1);
        uint256 agentId = _accrualAgent(verifierA, commitment);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.claimDelegateCredits(address(0), commitment, buyerX, agentId, SERVICE_HASH);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, address(0), agentId, SERVICE_HASH);
    }

    function test_claimRejectsSinceDewhitelistedVerifier() public {
        // Pins current behavior: the verifier's whitelist standing is checked
        // at CLAIM time, so credits accrued under a since-de-whitelisted
        // verifier are unclaimable while it is out.
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 1);

        verifierRegistry.setVerifier(verifierA, false);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        _claimAs(operatorX, verifierA, commitment, buyerX);

        // Re-approving restores claimability — the accrual itself is intact.
        verifierRegistry.setVerifier(verifierA, true);
        _claimAs(operatorX, verifierA, commitment, buyerX);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 1);
    }

    function test_claimRejectsSelfDelegate() public {
        // Verifier "carrying" its own probes: buyer == verifier. Nothing
        // accrues at anchor time AND the claim reverts outright.
        deposits.setOperator(verifierA, operatorX);
        bytes32 commitment = _accrueOnly(verifierA, verifierA, 1);
        assertEq(
            verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, _key(verifierA, commitment), verifierA),
            0
        );
        vm.expectRevert(AntseedVerifierRegistry.SelfDelegate.selector);
        _claimAs(operatorX, verifierA, commitment, verifierA);

        // Verifier as the buyer's operator: operator == verifier.
        deposits.setOperator(buyerX, verifierA);
        bytes32 commitment2 = _accrueAndAttest(verifierA, buyerX, 1);
        vm.expectRevert(AntseedVerifierRegistry.SelfDelegate.selector);
        _claimAs(verifierA, verifierA, commitment2, buyerX);
    }

    // ─── Registry: commitment budget anchoring ───────────────────────

    function test_claimBeforeCreditedAttestationYieldsNothing() public {
        // Accrued at anchor time but NO credited attestation exists: the
        // commitment budget is 0, so nothing is claimable — anchoring alone
        // can never farm the delegate pool.
        bytes32 commitment = _accrueOnly(verifierA, buyerX, 5);
        bytes32 key = _key(verifierA, commitment);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key, buyerX), 5);
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, commitment, key), 0);

        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        _claimAs(operatorX, verifierA, commitment, buyerX);
    }

    function test_claimNeverAccruedCommitmentReverts() public {
        _attest(verifierA); // budget exists on some OTHER commitment
        bytes32 commitment = keccak256("never accrued");
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, 1, SERVICE_HASH);
    }

    function test_claimClampsAtTargetBudget() public {
        // 15 carried probes span TWO targets (10 on target 0, 5 on target
        // 1). One credited attestation on target 0 backs ONLY target 0's
        // accrual; target 1's accrual stays unclaimable until its own
        // attestation is credited.
        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchorWithCarrier(verifierA, commitment, buyerX, 15);
        _attestOn(verifierA, commitment, batchRoot); // credits target 0

        uint256 agent0 = _batchTargetAgents[batchRoot][0];
        uint256 agent1 = _batchTargetAgents[batchRoot][1];
        bytes32 key0 = keccak256(abi.encodePacked(agent0, SERVICE_HASH));
        bytes32 key1 = keccak256(abi.encodePacked(agent1, SERVICE_HASH));
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, commitment, key0), PROBE_COUNT);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key0, buyerX), PROBE_COUNT);
        assertEq(verifierRegistry.commitmentDelegateAccrued(verifierA, commitment, key1, buyerX), 5);

        vm.expectEmit(true, true, true, true);
        emit DelegateCredited(5, verifierA, operatorX, commitment, key0, PROBE_COUNT);
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agent0, SERVICE_HASH);
        assertEq(verifierRegistry.commitmentDelegateCredits(verifierA, commitment, key0), PROBE_COUNT);
        assertEq(verifierRegistry.commitmentDelegateClaimed(verifierA, commitment, key0, buyerX), PROBE_COUNT);

        // Target 0 fully claimed → nothing more there.
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agent0, SERVICE_HASH);

        // Target 1 accrued but not attested → its budget is 0.
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agent1, SERVICE_HASH);

        // A credited attestation on target 1 unlocks exactly its accrual.
        _attestOn(verifierA, commitment, batchRoot); // credits target 1
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agent1, SERVICE_HASH);
        assertEq(verifierRegistry.commitmentDelegateClaimed(verifierA, commitment, key1, buyerX), 5);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 15);
    }

    function test_creditedBudgetIsTargetBound() public {
        // Regression for the cross-target siphon: an "ally" buyer that
        // carried probes ONLY for a never-attested target must not be able
        // to drain the budget minted by another target's credited
        // attestation — in any claim order.
        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);

        uint256 agentHonest = identity.register();
        identity.setOwner(agentHonest, vm.addr(RECORD_SELLER_KEY));
        uint256 agentAlly = identity.register();
        identity.setOwner(agentAlly, vm.addr(RECORD_SELLER_KEY));

        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](20);
        bytes[] memory payloads = new bytes[](20);
        uint32[] memory counts = new uint32[](20);
        for (uint256 i = 0; i < 10; i++) {
            (records[i], payloads[i]) = makeSignedRecord(
                agentHonest, RECORD_SELLER_KEY, buyerX, keccak256(abi.encode(commitment, "honest", i))
            );
            counts[i] = 1;
        }
        for (uint256 i = 10; i < 20; i++) {
            (records[i], payloads[i]) = makeSignedRecord(
                agentAlly, RECORD_SELLER_KEY, buyerY, keccak256(abi.encode(commitment, "ally", i))
            );
            counts[i] = 1;
        }
        vm.prank(verifierA);
        bytes32 batchRoot = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);

        // Only the honest target's attestation is credited.
        vm.prank(verifierA);
        verifierRegistry.submitAttestation(
            agentHonest, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, PROBE_COUNT, 3
        );

        // The ally front-running the claim gets nothing: no accrual on the
        // credited target, no budget on its own.
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerY, agentHonest, SERVICE_HASH);
        vm.prank(operatorY);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerY, agentAlly, SERVICE_HASH);

        // The honest carrier's full accrual is intact.
        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, agentHonest, SERVICE_HASH);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), PROBE_COUNT);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorY), 0);
    }

    function test_budgetIsSharedAcrossBuyersFirstComeFirstServed() public {
        // buyerX accrued 6, buyerY accrued 5, budget 10: X claims 6, Y gets
        // the remaining 4 (clamped).
        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);

        uint256 targetAgentId = identity.register();
        identity.setOwner(targetAgentId, vm.addr(RECORD_SELLER_KEY));
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](11);
        bytes[] memory payloads = new bytes[](11);
        uint32[] memory counts = new uint32[](11);
        for (uint256 i = 0; i < 6; i++) {
            (records[i], payloads[i]) = makeSignedRecord(
                targetAgentId, RECORD_SELLER_KEY, buyerX, keccak256(abi.encode(commitment, "x", i))
            );
            counts[i] = 1;
        }
        for (uint256 i = 0; i < 5; i++) {
            uint256 index = i + 6;
            (records[index], payloads[index]) = makeSignedRecord(
                targetAgentId, RECORD_SELLER_KEY, buyerY, keccak256(abi.encode(commitment, "y", i))
            );
            counts[index] = 1;
        }
        vm.prank(verifierA);
        bytes32 batchRoot = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
        _batchTargetAgents[batchRoot].push(targetAgentId);
        _attestOn(verifierA, commitment, batchRoot);

        vm.prank(operatorX);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerX, targetAgentId, SERVICE_HASH);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 6);

        vm.prank(operatorY);
        verifierRegistry.claimDelegateCredits(verifierA, commitment, buyerY, targetAgentId, SERVICE_HASH);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorY), 4);
        bytes32 key = keccak256(abi.encodePacked(targetAgentId, SERVICE_HASH));
        assertEq(verifierRegistry.commitmentDelegateCredits(verifierA, commitment, key), PROBE_COUNT);
    }

    function test_uncreditedAttestationGrowsNoBudget() public {
        // First attestation on the agent/service is credited (budget 10);
        // an immediate re-audit is inside the cooldown → uncredited.
        uint256 agentId = identity.register();
        identity.setOwner(agentId, vm.addr(RECORD_SELLER_KEY));

        bytes32 first = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(first);
        vm.warp(block.timestamp + 1);
        bytes32 firstRoot = _anchorForAgentWithCarrier(verifierA, first, agentId, buyerX, PROBE_COUNT);
        vm.prank(verifierA);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, first, firstRoot, PROBE_COUNT, 3);
        bytes32 key = keccak256(abi.encodePacked(agentId, SERVICE_HASH));
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, first, key), PROBE_COUNT);

        bytes32 second = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(second);
        vm.warp(block.timestamp + 1);
        bytes32 secondRoot = _anchorForAgentWithCarrier(verifierA, second, agentId, buyerX, PROBE_COUNT);
        vm.prank(verifierA);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, second, secondRoot, PROBE_COUNT, 3
        );
        assertEq(verifierRegistry.commitmentDelegateBudget(verifierA, second, key), 0);

        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        verifierRegistry.claimDelegateCredits(verifierA, second, buyerX, agentId, SERVICE_HASH);
    }

    // ─── Registry: per-epoch verifier cap ────────────────────────────

    function test_claimClampsAtPerEpochCapAndResumesNextEpoch() public {
        verifierRegistry.setMaxDelegateCreditsPerVerifierPerEpoch(5);

        // 8 accrued, budget 20 — the epoch cap (5) binds first.
        bytes32 commitment = keccak256(abi.encode(verifierA, ++commitSalt));
        vm.prank(verifierA);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchorWithCarrier(verifierA, commitment, buyerX, 8);
        _attestOn(verifierA, commitment, batchRoot);

        _claimAs(operatorX, verifierA, commitment, buyerX);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 5);

        // Cap exhausted for verifierA this epoch — no claim can proceed.
        vm.expectRevert(AntseedVerifierRegistry.NothingToClaim.selector);
        _claimAs(operatorX, verifierA, commitment, buyerX);

        // Another verifier still has its own allowance…
        _carryAndClaim(verifierB, buyerY, operatorY, 5);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorY), 5);

        // …and the cap resets next epoch: the clamped remainder (3) clears.
        _warpGateEpoch(6);
        _claimAs(operatorX, verifierA, commitment, buyerX);
        assertEq(verifierRegistry.epochDelegateCredits(6, operatorX), 3);
        assertEq(
            verifierRegistry.commitmentDelegateClaimed(verifierA, commitment, _key(verifierA, commitment), buyerX), 8
        );
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
        _carryAndClaim(verifierA, buyerX, operatorX, 3);
        _carryAndClaim(verifierB, buyerY, operatorY, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertGt(budget, 0);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        // _carryAndClaim adds one credited attestation per verifier on top
        // of the explicit _attest calls above: verifierA 3+1=4, verifierB
        // 1+1=2.
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
        uint256 minted = token.balanceOf(verifierA) + token.balanceOf(verifierB) + token.balanceOf(operatorX)
            + token.balanceOf(operatorY);
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
        _carryAndClaim(verifierA, buyerX, operatorX, 1);

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
        _carryAndClaim(verifierA, buyerX, operatorX, 1);
        _warpGateEpoch(6);

        uint256 budget = verifierRewards.verifierEpochBudget(5);
        uint256 delegatePool = (budget * 2000) / 10_000;
        uint256 verifierPool = budget - delegatePool;

        // _carryAndClaim added one credited attestation for verifierA: 2 vs 1.
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

    function test_lateDelegateCreditsAfterFreezeAreUnclaimable() public {
        // Epoch 5 freezes with verifier credits but NO delegate credits: the
        // delegate pool and delegate-credit total both freeze at zero.
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 2);
        _warpGateEpoch(6);
        vm.prank(verifierA);
        verifierRewards.claimVerifierReward(5);
        assertEq(verifierRewards.delegateEpochPool(5), 0);
        assertEq(verifierRewards.delegateEpochTotalCredits(5), 0);

        // A lagging registry epoch clock lands delegate credits in the
        // already frozen epoch 5.
        MockEpochClock laggingClock = new MockEpochClock();
        laggingClock.setCurrentEpoch(5);
        registry.setEmissions(address(laggingClock));
        _claimAs(operatorX, verifierA, commitment, buyerX);
        assertEq(verifierRegistry.epochDelegateCredits(5, operatorX), 2);
        assertEq(verifierRewards.delegateEpochTotalCredits(5), 0, "frozen total must not move");

        // Outside the frozen claim set: clean NothingToClaim, not a division
        // panic against the zero frozen total.
        assertEq(verifierRewards.pendingDelegateReward(5, operatorX), 0);
        vm.prank(operatorX);
        vm.expectRevert(AntseedVerifierRewards.NothingToClaim.selector);
        verifierRewards.claimDelegateReward(5);
    }

    /// @dev Attest in epoch 5, claim buyerX's 2 accrued credits in epoch 6.
    ///      (Hoisted out of the test body: the fully inlined accrue+claim
    ///      chain plus the test's own locals is "stack too deep" via-ir.)
    function _claimTwoCreditsInEpoch6() internal {
        bytes32 commitment = _accrueAndAttest(verifierA, buyerX, 2);
        _warpGateEpoch(6);
        _claimAs(operatorX, verifierA, commitment, buyerX);
    }

    function test_remainderSettlesOnlyVerifierPool() public {
        // Attest in epoch 5, claim the credits in epoch 6: commitment budget
        // is not epoch-scoped, so epoch 6 ends with delegate credits but zero
        // verifier credits. Only the verifier pool routes through
        // burn/reserve; the delegate pool stays claimable.
        _claimTwoCreditsInEpoch6();
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
