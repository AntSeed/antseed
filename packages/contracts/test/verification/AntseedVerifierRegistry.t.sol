// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistryV2 } from "../../core/AntseedRegistryV2.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockEpochClock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

contract AntseedVerifierRegistryTest is Test {
    AntseedRegistryV2 registry;
    MockERC8004Registry identity;
    MockEpochClock clock;
    AntseedVerifierRegistry verifierRegistry;

    address verifier = address(0x1001);
    address otherVerifier = address(0x1002);
    address outsider = address(0x1003);
    address sellerOwner = address(0x2001);

    uint256 agentId;
    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event ProbeSetCommitted(address indexed verifier, bytes32 indexed commitment);
    event AttestationSubmitted(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed verifier,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        uint32 probeCount,
        uint32 cohortSize,
        bool credited,
        uint256 epoch
    );

    function setUp() public {
        vm.warp(1_700_000_000);

        registry = new AntseedRegistryV2();
        identity = new MockERC8004Registry();
        clock = new MockEpochClock();
        clock.setCurrentEpoch(5);
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(clock));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRegistry.setVerifier(verifier, true);
        verifierRegistry.setVerifier(otherVerifier, true);

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

    function _attest(address verifier_, uint256 agentId_, bytes32 serviceHash, uint8 verdict, bytes32 commitment)
        internal
    {
        vm.prank(verifier_);
        verifierRegistry.submitAttestation(agentId_, serviceHash, verdict, EVIDENCE_HASH, commitment, 10, 3);
    }

    function _commitAndAttest(address verifier_, uint256 agentId_, bytes32 serviceHash, uint8 verdict) internal {
        bytes32 commitment = _commit(verifier_);
        vm.warp(block.timestamp + 1);
        _attest(verifier_, agentId_, serviceHash, verdict, commitment);
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
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("c"), 10, 3);
    }

    function test_submitZeroInputsRevert() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.startPrank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(0, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(agentId, bytes32(0), 1, EVIDENCE_HASH, commitment, 10, 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidValue.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, bytes32(0), commitment, 10, 3);
        vm.stopPrank();
    }

    function test_submitInvalidVerdictReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.startPrank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidVerdict.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 0, EVIDENCE_HASH, commitment, 10, 3);
        vm.expectRevert(AntseedVerifierRegistry.InvalidVerdict.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 4, EVIDENCE_HASH, commitment, 10, 3);
        vm.stopPrank();
    }

    function test_submitBelowMinProbeCountReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeCountTooLow.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 9, 3);
    }

    function test_submitUnknownCommitmentReverts() public {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("never"), 10, 3);
    }

    function test_submitOtherVerifiersCommitmentReverts() public {
        bytes32 commitment = _commit(otherVerifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetNotCommitted.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
    }

    function test_submitSameTimestampAsCommitReverts() public {
        bytes32 commitment = _commit(verifier);
        // No warp: commit and attest land in the same second.
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeSetTooRecent.selector);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
    }

    function test_submitUnknownAgentReverts() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        verifierRegistry.submitAttestation(999, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
    }

    function test_submitWithUnsetIdentityRegistryReverts() public {
        AntseedRegistryV2 bareRegistry = new AntseedRegistryV2();
        bareRegistry.setEmissions(address(clock));
        AntseedVerifierRegistry bareVerifierRegistry = new AntseedVerifierRegistry(address(bareRegistry));
        bareVerifierRegistry.setVerifier(verifier, true);

        vm.prank(verifier);
        bareVerifierRegistry.commitProbeSet(keccak256("c"));
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        bareVerifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, keccak256("c"), 10, 3);
    }

    function test_submitSelfAuditReverts() public {
        uint256 ownAgentId = _registerAgent(verifier);
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.SelfAudit.selector);
        verifierRegistry.submitAttestation(ownAgentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
    }

    // ─── Attestation storage ─────────────────────────────────────────

    function test_attestationStoredAndCredited() public {
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);

        vm.expectEmit(true, true, true, true);
        emit AttestationSubmitted(agentId, SERVICE_HASH, verifier, 1, EVIDENCE_HASH, commitment, 12, 4, true, 5);
        vm.prank(verifier);
        verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 12, 4);

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
        bytes32 otherServiceHash = keccak256("model:gpt-100");
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
        bytes32 otherServiceHash = keccak256("model:gpt-100");

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
        bytes32 otherServiceHash = keccak256("model:gpt-100");

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

    // ─── Crediting ───────────────────────────────────────────────────

    function test_cooldownBlocksSecondCreditThenAllowsAfterWarp() public {
        _commitAndAttest(verifier, agentId, SERVICE_HASH, 1);
        uint64 firstCreditedAt = verifierRegistry.lastCreditedAt(agentId, SERVICE_HASH);
        assertEq(verifierRegistry.epochCredits(5, verifier), 1);

        // Within the cooldown the attestation is stored but not credited.
        bytes32 commitment = _commit(verifier);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true);
        emit AttestationSubmitted(agentId, SERVICE_HASH, verifier, 2, EVIDENCE_HASH, commitment, 10, 3, false, 5);
        _attest(verifier, agentId, SERVICE_HASH, 2, commitment);

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
