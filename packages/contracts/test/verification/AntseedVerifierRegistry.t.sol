// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { ResponseAuthFixture } from "./ResponseAuthFixture.sol";

contract MockEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract AntseedVerifierRegistryTest is Test, ResponseAuthFixture {
    AntseedRegistry registry;
    MockERC8004Registry identity;
    MockEpochClock clock;
    AntseedVerifierRegistry verifierRegistry;

    address verifier = address(0x1001);
    address otherVerifier = address(0x1002);
    address outsider = address(0x1003);
    address sellerOwner;

    uint256 agentId;
    bytes32 constant SERVICE_HASH = keccak256("anthropic/claude-opus-4");
    bytes32 constant OTHER_SERVICE_HASH = keccak256("model:gpt-100");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    /// @dev Signing key + registered agent for the sellers whose signed
    ///      exchanges are anchored by `_anchor` (anchorExchangeBatch verifies
    ///      each record's ResponseAuth signature on-chain against the
    ///      ERC-8004 owner of the record's agentId).
    uint256 constant RECORD_SELLER_KEY = 0x5E11E4;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event ProbeSetCommitted(address indexed verifier, bytes32 indexed commitment);
    event VerifierStandingCleared(address indexed verifier, uint256 indexed agentId, bytes32 indexed serviceHash);
    event AttestationSubmitted(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed verifier,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        bytes32 batchRoot,
        uint32 probeCount,
        uint32 cohortSize,
        bool credited,
        uint256 epoch
    );

    function setUp() public {
        vm.warp(1_700_000_000);

        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        clock = new MockEpochClock();
        clock.setCurrentEpoch(5);
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(clock));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRegistry.setVerifier(verifier, true);
        verifierRegistry.setVerifier(otherVerifier, true);

        sellerOwner = vm.addr(RECORD_SELLER_KEY);
        agentId = _registerAgent(sellerOwner);
    }

    function _registerAgent(address owner) internal returns (uint256 id) {
        id = identity.register();
        identity.setOwner(id, owner);
    }

    function _commit(address verifier_) internal returns (bytes32 commitment) {
        commitment = keccak256(abi.encode(verifier_, ++commitSalt));
        vm.prank(verifier_);
        verifierRegistry.commitProbeSet(commitment);
    }

    /// @dev Anchor a fully SIGNED exchange batch bound to `commitment`,
    ///      sized to cover the probe counts these tests attest (>= 12) so
    ///      the anchored probe-count cap never trips. Records derive from
    ///      the commitment so every batch has a distinct root; the buyer in
    ///      every signed payload is the anchoring verifier (no delegate
    ///      accrual side effects).
    function _anchor(address verifier_, bytes32 commitment, uint256 targetAgentId, bytes32 serviceHash)
        internal
        returns (bytes32 batchRoot)
    {
        string memory advertisedService = serviceHash == SERVICE_HASH ? "anthropic/claude-opus-4" : "model:gpt-100";
        IAntseedVerifierRegistry.ExchangeRecord[] memory records = new IAntseedVerifierRegistry.ExchangeRecord[](16);
        bytes[] memory payloads = new bytes[](16);
        uint32[] memory counts = new uint32[](16);
        for (uint256 i = 0; i < records.length; i++) {
            (records[i], payloads[i]) = makeSignedRecordForService(
                targetAgentId,
                RECORD_SELLER_KEY,
                verifier_,
                keccak256(abi.encode(commitment, i)),
                advertisedService
            );
            counts[i] = 1;
        }
        vm.prank(verifier_);
        batchRoot = verifierRegistry.anchorExchangeBatch(commitment, records, payloads, counts);
    }

    function _attest(
        address verifier_,
        uint256 agentId_,
        bytes32 serviceHash,
        uint8 verdict,
        bytes32 commitment,
        bytes32 batchRoot
    ) internal {
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(agentId_, serviceHash, verdict, EVIDENCE_HASH, commitment, batchRoot, 10, 3);
    }

    function _commitAndAttest(address verifier_, uint256 agentId_, bytes32 serviceHash, uint8 verdict) internal {
        bytes32 commitment = _commit(verifier_);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchor(verifier_, commitment, agentId_, serviceHash);
        _attest(verifier_, agentId_, serviceHash, verdict, commitment, batchRoot);
    }

    function _stats(uint256 agentId_, bytes32 serviceHash)
        internal
        view
        returns (IAntseedVerifierRegistry.ServiceVerificationStats memory)
    {
        return verifierRegistry.verificationStats(agentId_, serviceHash);
    }

    function _assertStats(
        IAntseedVerifierRegistry.ServiceVerificationStats memory stats,
        uint32 sameCount,
        uint32 diffCount,
        uint32 undeterminedCount,
        uint32 distinctVerifierCount,
        uint8 lastVerdict,
        address lastVerifier
    ) internal pure {
        assertEq(stats.sameCount, sameCount, "sameCount");
        assertEq(stats.diffCount, diffCount, "diffCount");
        assertEq(stats.undeterminedCount, undeterminedCount, "undeterminedCount");
        assertEq(stats.distinctVerifierCount, distinctVerifierCount, "distinctVerifierCount");
        assertEq(stats.lastVerdict, lastVerdict, "lastVerdict");
        assertEq(stats.lastVerifier, lastVerifier, "lastVerifier");
    }

    // ─── Constructor & defaults ──────────────────────────────────────

    function test_constructorZeroRegistryReverts() public {
        vm.expectRevert(AntseedVerifierRegistry.InvalidAddress.selector);
        new AntseedVerifierRegistry(address(0));
    }

    function test_defaults() public view {
        assertEq(verifierRegistry.auditCooldown(), 1 days);
        assertEq(verifierRegistry.maxCreditsPerVerifierPerEpoch(), 100);
        assertEq(verifierRegistry.minProbeCount(), 10);
        assertEq(address(verifierRegistry.registry()), address(registry));
    }

    function test_currentEpochResolvesRegistryEmissions() public {
        assertEq(verifierRegistry.currentEpoch(), 5);
        clock.setCurrentEpoch(9);
        assertEq(verifierRegistry.currentEpoch(), 9);
    }

    // ─── Whitelist ───────────────────────────────────────────────────

    function test_setVerifierOnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        verifierRegistry.setVerifier(outsider, true);
    }

    function test_setVerifierZeroAddressReverts() public {
        vm.expectRevert(AntseedVerifierRegistry.InvalidAddress.selector);
        verifierRegistry.setVerifier(address(0), true);
    }

    function test_setVerifierTogglesAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit VerifierApprovalSet(outsider, true);
        verifierRegistry.setVerifier(outsider, true);
        assertTrue(verifierRegistry.approvedVerifiers(outsider));

        vm.expectEmit(true, false, false, true);
        emit VerifierApprovalSet(outsider, false);
        verifierRegistry.setVerifier(outsider, false);
        assertFalse(verifierRegistry.approvedVerifiers(outsider));
    }

    function test_removedVerifierLosesAccess() public {
        verifierRegistry.setVerifier(verifier, false);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.commitProbeSet(keccak256("x"));
    }

    // ─── Owner config ────────────────────────────────────────────────

    function test_configSettersOnlyOwner() public {
        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        verifierRegistry.setAuditCooldown(1 hours);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        verifierRegistry.setMaxCreditsPerVerifierPerEpoch(5);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        verifierRegistry.setMinProbeCount(5);
        vm.stopPrank();
    }

    function test_configSettersApplyAndBound() public {
        verifierRegistry.setAuditCooldown(2 hours);
        assertEq(verifierRegistry.auditCooldown(), 2 hours);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setAuditCooldown(uint64(30 days) + 1);

        verifierRegistry.setMaxCreditsPerVerifierPerEpoch(7);
        assertEq(verifierRegistry.maxCreditsPerVerifierPerEpoch(), 7);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setMaxCreditsPerVerifierPerEpoch(0);

        verifierRegistry.setMinProbeCount(3);
        assertEq(verifierRegistry.minProbeCount(), 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.setMinProbeCount(0);
    }

    // ─── Probe commitments ───────────────────────────────────────────

    function test_commitOnlyApprovedVerifier() public {
        vm.prank(outsider);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.commitProbeSet(keccak256("probes"));
    }

    function test_commitZeroCommitmentReverts() public {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.commitProbeSet(bytes32(0));
    }

    function test_commitStoresTimestampAndEmits() public {
        bytes32 commitment = keccak256("probes");
        vm.expectEmit(true, true, false, true);
        emit ProbeSetCommitted(verifier, commitment);
        vm.prank(verifier);
        verifierRegistry.commitProbeSet(commitment);
        assertEq(verifierRegistry.probeCommittedAt(verifier, commitment), uint64(block.timestamp));
    }

    function test_commitReuseReverts() public {
        bytes32 commitment = keccak256("probes");
        vm.prank(verifier);
        verifierRegistry.commitProbeSet(commitment);
        vm.warp(block.timestamp + 1);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.CommitmentAlreadySet.selector);
        verifierRegistry.commitProbeSet(commitment);
    }

    // ─── Attestation validation ──────────────────────────────────────

    function test_submitOnlyApprovedVerifier() public {
        vm.prank(outsider);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("c"), keccak256("root"), 10, 3
        );
    }

    function test_submitZeroInputsRevert() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.startPrank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(0, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(agentId, bytes32(0), 1, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, bytes32(0), commitment, keccak256("root"), 10, 3);
        vm.stopPrank();
    }

    function test_submitInvalidVerdictReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.startPrank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidVerdict.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 0, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3
        );
        vm.expectRevert(AntseedVerifierRegistry.InvalidVerdict.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 4, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3
        );
        vm.stopPrank();
    }

    function test_submitBelowMinProbeCountReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeCountTooLow.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, keccak256("root"), 9, 3
        );
    }

    function test_submitUnknownCommitmentReverts() public {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("never"), keccak256("root"), 10, 3
        );
    }

    function test_submitOtherVerifiersCommitmentReverts() public {
        bytes32 commitment = _commit(otherVerifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3
        );
    }

    function test_submitSameTimestampAsCommitReverts() public {
        bytes32 commitment = _commit(verifier);
        // No warp: commit and attest land in the same second.
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetTooRecent.selector);
        verifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, keccak256("root"), 10, 3
        );
    }

    function test_submitUnknownAgentReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchor(verifier, commitment, agentId, SERVICE_HASH);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        verifierRegistry.submitAttestation(999, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, 10, 3);
    }

    function test_submitWithUnsetIdentityRegistryReverts() public {
        // With no identity registry set, agentId → seller resolution is
        // impossible, so the pipeline now fails at ANCHOR time (every
        // anchored record must be signature-verified against the agent's
        // owner) — and submitAttestation against any root stays unreachable.
        AntseedRegistry bareRegistry = new AntseedRegistry();
        bareRegistry.setEmissions(address(clock));
        AntseedVerifierRegistry bareVerifierRegistry = new AntseedVerifierRegistry(address(bareRegistry));
        bareVerifierRegistry.setVerifier(verifier, true);

        vm.prank(verifier);
        bareVerifierRegistry.commitProbeSet(keccak256("c"));
        vm.warp(block.timestamp + 1);

        (
            IAntseedVerifierRegistry.ExchangeRecord[] memory records,
            bytes[] memory payloads,
            uint32[] memory counts
        ) = makeSignedBatch(10, agentId, RECORD_SELLER_KEY, verifier, keccak256("c"));
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        bareVerifierRegistry.anchorExchangeBatch(keccak256("c"), records, payloads, counts);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.BatchNotAnchored.selector);
        bareVerifierRegistry.submitAttestation(
            agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("c"), keccak256("no-root"), 10, 3
        );
    }

    function test_submitSelfAuditReverts() public {
        uint256 ownAgentId = _registerAgent(verifier);
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchor(verifier, commitment, agentId, SERVICE_HASH);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.SelfAudit.selector);
        verifierRegistry.submitAttestation(ownAgentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, 10, 3);
    }

    // ─── Attestation storage ─────────────────────────────────────────

    function test_attestationStoredAndCredited() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchor(verifier, commitment, agentId, SERVICE_HASH);

        vm.expectEmit(true, true, true, true);
        emit AttestationSubmitted(
            agentId, SERVICE_HASH, verifier, 1, EVIDENCE_HASH, commitment, batchRoot, 12, 4, true, 5
        );
        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, batchRoot, 12, 4);

        IAntseedVerifierRegistry.Attestation memory attestation =
            verifierRegistry.latestAttestation(agentId, SERVICE_HASH);
        assertEq(attestation.verifier, verifier);
        assertEq(attestation.attestedAt, uint64(block.timestamp));
        assertEq(attestation.verdict, 1);
        assertEq(attestation.probeCount, 12);
        assertEq(attestation.cohortSize, 4);
        assertEq(attestation.evidenceHash, EVIDENCE_HASH);
        assertEq(attestation.probeCommitment, commitment);

        assertEq(verifierRegistry.lastAuditedAt(agentId, SERVICE_HASH), uint64(block.timestamp));
        assertEq(verifierRegistry.lastCreditedAt(agentId, SERVICE_HASH), uint64(block.timestamp));
        assertEq(verifierRegistry.epochCredits(5, verifier), 1);
        assertEq(verifierRegistry.epochTotalCredits(5), 1);
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 0, 0, 1, 1, verifier);
    }

    // ─── Verification stats ──────────────────────────────────────────

    function test_verificationStatsDefaultsToZero() public view {
        _assertStats(_stats(agentId, SERVICE_HASH), 0, 0, 0, 0, 0, address(0));
    }

    function test_verificationStatsCountersAccumulatePerVerdict() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 0, 0, 1, 1, verifier);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 1, 0, 1, 2, verifier);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 3);
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 1, 1, 1, 3, verifier);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _assertStats(_stats(agentId, SERVICE_HASH), 3, 2, 1, 1, 1, verifier);
    }

    function test_verificationStatsCountersAccumulateEvenWhenNotCredited() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        // Within the cooldown the attestation earns no credit but still
        // lands in the stats accumulators.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        assertEq(verifierRegistry.epochCredits(5, verifier), 1);
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 1, 0, 1, 2, verifier);
    }

    function test_distinctVerifierCountCountsEachVerifierOncePerPair() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).distinctVerifierCount, 1);

        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 3);
        assertEq(_stats(agentId, SERVICE_HASH).distinctVerifierCount, 2);

        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 1);
        assertEq(_stats(agentId, SERVICE_HASH).distinctVerifierCount, 2);
    }

    function test_distinctVerifierCountIsPerPair() public {
        bytes32 otherServiceHash = OTHER_SERVICE_HASH;
        uint256 otherAgentId = _registerAgent(sellerOwner);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _commitAndAttest(verifier, agentId, otherServiceHash, 2);
        _commitAndAttest(verifier, otherAgentId, SERVICE_HASH, 3);

        // Same verifier counts once per (agentId, serviceHash) pair, and
        // pairs never bleed into each other.
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 0, 0, 1, 1, verifier);
        _assertStats(_stats(agentId, otherServiceHash), 0, 1, 0, 1, 2, verifier);
        _assertStats(_stats(otherAgentId, SERVICE_HASH), 0, 0, 1, 1, 3, verifier);
        _assertStats(_stats(otherAgentId, otherServiceHash), 0, 0, 0, 0, 0, address(0));
    }

    function test_activeDiffVerifierCountRaisesOncePerVerifier() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);

        // Repeated DIFF from the same verifier is still one standing accusation.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);

        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 2);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 2);
    }

    function test_activeDiffVerifierCountClearsOnRetraction() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 2);

        // A verifier's later SAME retracts its own standing DIFF; another
        // verifier's SAME never clears someone else's accusation.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);

        // UNDETERMINED also retracts, and DIFF re-raises.
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 3);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 0);
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);

        // diffCount stays a monotonic historical record throughout.
        assertEq(_stats(agentId, SERVICE_HASH).diffCount, 3);
    }

    function test_activeDiffVerifierCountIsPerPairAndAnyServiceAtAgentLevel() public {
        bytes32 otherServiceHash = OTHER_SERVICE_HASH;

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _commitAndAttest(verifier, agentId, otherServiceHash, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);
        assertEq(_stats(agentId, otherServiceHash).activeDiffVerifierCount, 1);
        // Agent-level standing counts each verifier once, not per service.
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);

        // A SAME on one service retracts only that pair. The agent-level
        // accusation stands while ANY service still carries this verifier's
        // DIFF — an honestly served second model must not launder a
        // substituted one.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 0);
        assertEq(_stats(agentId, otherServiceHash).activeDiffVerifierCount, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);

        // Only retracting the last standing DIFF clears the agent level.
        _commitAndAttest(verifier, agentId, otherServiceHash, 3);
        assertEq(_stats(agentId, otherServiceHash).activeDiffVerifierCount, 0);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 0);
    }

    function test_lastVerdictAndVerifierTrackLatestSubmission() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        IAntseedVerifierRegistry.ServiceVerificationStats memory stats = _stats(agentId, SERVICE_HASH);
        assertEq(stats.lastVerdict, 2);
        assertEq(stats.lastVerifier, verifier);

        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 1);
        stats = _stats(agentId, SERVICE_HASH);
        assertEq(stats.lastVerdict, 1);
        assertEq(stats.lastVerifier, otherVerifier);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 3);
        stats = _stats(agentId, SERVICE_HASH);
        assertEq(stats.lastVerdict, 3);
        assertEq(stats.lastVerifier, verifier);
    }

    // ─── Agent-level aggregate stats ─────────────────────────────────

    function test_agentVerificationStatsDefaultsToZero() public view {
        _assertStats(verifierRegistry.agentVerificationStats(agentId), 0, 0, 0, 0, 0, address(0));
    }

    function test_agentVerificationStatsAggregatesAcrossServices() public {
        bytes32 otherServiceHash = OTHER_SERVICE_HASH;

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _commitAndAttest(verifier, agentId, otherServiceHash, 2);
        _commitAndAttest(otherVerifier, agentId, otherServiceHash, 3);

        // Per-service stats stay isolated...
        _assertStats(_stats(agentId, SERVICE_HASH), 1, 0, 0, 1, 1, verifier);
        _assertStats(_stats(agentId, otherServiceHash), 0, 1, 1, 2, 3, otherVerifier);
        // ...while the agent aggregate sums both services.
        _assertStats(verifierRegistry.agentVerificationStats(agentId), 1, 1, 1, 2, 3, otherVerifier);
    }

    function test_agentDistinctVerifierCountCountsVerifierOnceAcrossServices() public {
        bytes32 otherServiceHash = OTHER_SERVICE_HASH;

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        _commitAndAttest(verifier, agentId, otherServiceHash, 1);

        // Same verifier on two services: once per service, once per agent.
        assertEq(_stats(agentId, SERVICE_HASH).distinctVerifierCount, 1);
        assertEq(_stats(agentId, otherServiceHash).distinctVerifierCount, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).distinctVerifierCount, 1);

        // A second verifier bumps the agent-level count.
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).distinctVerifierCount, 2);
    }

    function test_agentVerificationStatsIsolatedPerAgent() public {
        uint256 otherAgentId = _registerAgent(sellerOwner);

        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);

        _assertStats(verifierRegistry.agentVerificationStats(agentId), 0, 1, 0, 1, 2, verifier);
        _assertStats(verifierRegistry.agentVerificationStats(otherAgentId), 0, 0, 0, 0, 0, address(0));
    }

    // ─── Owner standing clearance ────────────────────────────────────

    function test_clearVerifierStandingRetractsDiff() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 2);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 2);
        uint256 totalCreditsBefore = verifierRegistry.epochTotalCredits(5);

        // The rogue verifier is de-whitelisted first — it can no longer
        // retract its own DIFF, so the owner clears the standing instead.
        verifierRegistry.setVerifier(verifier, false);
        vm.expectEmit(true, true, true, true);
        emit VerifierStandingCleared(verifier, agentId, SERVICE_HASH);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);

        // The standing accusation drops at both levels…
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);
        // …while historical counters stay untouched and no credits mint.
        assertEq(_stats(agentId, SERVICE_HASH).diffCount, 2);
        assertEq(verifierRegistry.agentVerificationStats(agentId).diffCount, 2);
        assertEq(verifierRegistry.epochTotalCredits(5), totalCreditsBefore);
    }

    function test_clearVerifierStandingOnlyOwner() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", outsider));
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);
    }

    function test_clearVerifierStandingWithoutDiffReverts() public {
        // Documented choice: clearing a key without a standing DIFF reverts
        // (not a silent no-op), so a mistyped key fails loudly instead of
        // emitting a misleading event. Never attested…
        vm.expectRevert(AntseedVerifierRegistry.NoStandingDiff.selector);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);

        // …standing SAME…
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        vm.expectRevert(AntseedVerifierRegistry.NoStandingDiff.selector);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);

        // …and an already-cleared standing all revert.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);
        vm.expectRevert(AntseedVerifierRegistry.NoStandingDiff.selector);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);
    }

    function test_clearVerifierStandingIsPerServiceAtAgentLevel() public {
        bytes32 otherServiceHash = OTHER_SERVICE_HASH;
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        _commitAndAttest(verifier, agentId, otherServiceHash, 2);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);

        // Clearing one service behaves exactly like the verifier's own SAME
        // on that service: the agent-level accusation stands while ANY other
        // service still carries this verifier's DIFF.
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 0);
        assertEq(_stats(agentId, otherServiceHash).activeDiffVerifierCount, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);

        verifierRegistry.clearVerifierStanding(verifier, agentId, otherServiceHash);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 0);
    }

    function test_clearVerifierStandingAllowsReRaise() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        verifierRegistry.clearVerifierStanding(verifier, agentId, SERVICE_HASH);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 0);

        // The cleared verdict resets to "never attested": a still-approved
        // verifier re-attesting DIFF re-raises the standing without any
        // double counting or underflow.
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 2);
        assertEq(_stats(agentId, SERVICE_HASH).activeDiffVerifierCount, 1);
        assertEq(verifierRegistry.agentVerificationStats(agentId).activeDiffVerifierCount, 1);
    }

    // ─── Crediting ───────────────────────────────────────────────────

    function test_cooldownBlocksSecondCreditThenAllowsAfterWarp() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        uint64 firstCreditedAt = verifierRegistry.lastCreditedAt(agentId, SERVICE_HASH);
        assertEq(verifierRegistry.epochCredits(5, verifier), 1);

        // Within the cooldown the attestation is stored but not credited.
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);
        bytes32 batchRoot = _anchor(verifier, commitment, agentId, SERVICE_HASH);
        vm.expectEmit(true, true, true, true);
        emit AttestationSubmitted(
            agentId, SERVICE_HASH, verifier, 2, EVIDENCE_HASH, commitment, batchRoot, 10, 3, false, 5
        );
        _attest(verifier, agentId, SERVICE_HASH, 2, commitment, batchRoot);

        assertEq(verifierRegistry.epochCredits(5, verifier), 1);
        assertEq(verifierRegistry.epochTotalCredits(5), 1);
        assertEq(verifierRegistry.lastCreditedAt(agentId, SERVICE_HASH), firstCreditedAt);
        assertEq(_stats(agentId, SERVICE_HASH).diffCount, 1);

        // Past the cooldown the same service credits again.
        vm.warp(uint256(firstCreditedAt) + 1 days);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        assertEq(verifierRegistry.epochCredits(5, verifier), 2);
        assertEq(verifierRegistry.epochTotalCredits(5), 2);
    }

    function test_cooldownIsSharedAcrossVerifiers() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);

        // A second verifier re-auditing the same (agent, service) within the
        // cooldown gets no credit — the window is per audited service.
        _commitAndAttest(otherVerifier, agentId, SERVICE_HASH, 1);
        assertEq(verifierRegistry.epochCredits(5, otherVerifier), 0);
        assertEq(verifierRegistry.epochTotalCredits(5), 1);
    }

    function test_perEpochCreditCapStopsCrediting() public {
        verifierRegistry.setMaxCreditsPerVerifierPerEpoch(2);

        for (uint256 i = 0; i < 3; i++) {
            uint256 freshAgentId = _registerAgent(sellerOwner);
            _commitAndAttest(verifier, freshAgentId, SERVICE_HASH, 1);
        }

        assertEq(verifierRegistry.epochCredits(5, verifier), 2);
        assertEq(verifierRegistry.epochTotalCredits(5), 2);

        // The cap is per verifier: another verifier still earns credits.
        uint256 otherAgentId = _registerAgent(sellerOwner);
        _commitAndAttest(otherVerifier, otherAgentId, SERVICE_HASH, 1);
        assertEq(verifierRegistry.epochCredits(5, otherVerifier), 1);
        assertEq(verifierRegistry.epochTotalCredits(5), 3);
    }

    function test_creditsBucketByEpoch() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        assertEq(verifierRegistry.epochCredits(5, verifier), 1);

        clock.setCurrentEpoch(6);
        vm.warp(block.timestamp + 1 days);
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        uint256 otherAgentId = _registerAgent(sellerOwner);
        _commitAndAttest(verifier, otherAgentId, SERVICE_HASH, 1);

        assertEq(verifierRegistry.epochCredits(5, verifier), 1);
        assertEq(verifierRegistry.epochTotalCredits(5), 1);
        assertEq(verifierRegistry.epochCredits(6, verifier), 2);
        assertEq(verifierRegistry.epochTotalCredits(6), 2);
    }
}
