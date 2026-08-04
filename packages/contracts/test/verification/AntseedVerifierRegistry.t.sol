// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract AntseedVerifierRegistryTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");
    bytes32 private constant OTHER_SERVICE_HASH = keccak256("gpt-5.6-luna");

    address private verifier = address(0xA11CE);
    address private secondVerifier = address(0xB0B);
    address private seller = address(0xCAFE);

    AntseedRegistry private registry;
    AntseedEmissionsGate private gate;
    MockERC8004Registry private identityRegistry;
    AntseedVerifierRegistry private verifierRegistry;
    uint256 private agentId;

    function setUp() public {
        vm.warp(GENESIS + 8 days);
        registry = new AntseedRegistry();
        registry.setAntsToken(address(new ANTSToken()));
        registry.setTeamWallet(address(0x1111));
        registry.setProtocolReserve(address(0x2222));
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        gate = new AntseedEmissionsGate(address(registry), 15_000, 15_000);
        verifierRegistry = new AntseedVerifierRegistry(address(registry), address(gate));
        verifierRegistry.setVerifier(verifier, true);
        verifierRegistry.setVerifier(secondVerifier, true);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    function test_submitStoresDirectAttestationAndCreditsVerifier() public {
        bytes32 auditId = keccak256("audit-1");
        vm.prank(verifier);
        verifierRegistry.submitVerificationResult(
            auditId,
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            _metrics(100, 100),
            keccak256("evidence-1")
        );

        IAntseedVerifierRegistry.Attestation memory attestation = verifierRegistry.getAttestation(auditId);
        assertEq(attestation.auditId, auditId);
        assertEq(attestation.verifier, verifier);
        assertEq(attestation.agentId, agentId);
        assertEq(attestation.serviceHash, SERVICE_HASH);
        assertEq(uint8(attestation.verdict), uint8(IAntseedVerifierRegistry.Verdict.SAME));
        assertEq(attestation.probeCount, 100);
        assertEq(verifierRegistry.epochCredits(verifierRegistry.currentEpoch(), verifier), 1);
        assertEq(verifierRegistry.epochTotalCredits(verifierRegistry.currentEpoch()), 1);
    }

    function test_attestationInsideCooldownIsStoredButNotCredited() public {
        _submit(verifier, keccak256("audit-a"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);
        _submit(verifier, keccak256("audit-b"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.UNDETERMINED, 0);

        IAntseedVerifierRegistry.Attestation memory latest = verifierRegistry.latestAttestation(agentId, SERVICE_HASH);
        assertEq(latest.auditId, keccak256("audit-b"));
        assertEq(uint8(latest.verdict), uint8(IAntseedVerifierRegistry.Verdict.UNDETERMINED));
        assertEq(verifierRegistry.epochCredits(verifierRegistry.currentEpoch(), verifier), 1);
    }

    function test_allFinalVerdictsCanEarnCredits() public {
        _submit(verifier, keccak256("same"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);
        vm.warp(GENESIS + 9 days);
        _submit(verifier, keccak256("diff"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 2_500);
        vm.warp(GENESIS + 10 days);
        _submit(
            verifier, keccak256("undetermined"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.UNDETERMINED, 0
        );

        assertEq(verifierRegistry.epochCredits(verifierRegistry.currentEpoch(), verifier), 3);
    }

    function test_penaltyFollowsLatestConclusiveAttestation() public {
        _submit(verifier, keccak256("diff-a"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 2_500);
        vm.warp(block.timestamp + 1);
        _submit(
            secondVerifier, keccak256("diff-b"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 4_000
        );
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 4_000);
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 4_000);

        vm.warp(block.timestamp + 1);
        _submit(verifier, keccak256("same-a"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 0);
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 0);

        vm.warp(block.timestamp + 1);
        _submit(
            secondVerifier,
            keccak256("diff-b-latest"),
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.DIFF,
            3_000
        );
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 3_000);
        verifierRegistry.clearVerifierStanding(secondVerifier, agentId, SERVICE_HASH);
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 0);
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 0);
    }

    function test_zeroShareDiffIsStoredWithoutPenalty() public {
        _submit(verifier, keccak256("zero-share-diff"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 0);

        IAntseedVerifierRegistry.Attestation memory attestation =
            verifierRegistry.latestAttestation(agentId, SERVICE_HASH);
        assertEq(uint8(attestation.verdict), uint8(IAntseedVerifierRegistry.Verdict.DIFF));
        assertEq(attestation.modelShareBps, 0);
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 0);
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 0);
    }

    function test_rejectsResultAfterExpectedEpochChanges() public {
        uint256 expectedEpoch = verifierRegistry.currentEpoch();
        vm.warp(block.timestamp + 7 days);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.EpochChanged.selector);
        verifierRegistry.submitVerificationResult(
            keccak256("stale-epoch"),
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            expectedEpoch,
            0,
            100,
            _metrics(100, 100),
            keccak256("stale-epoch-evidence")
        );
    }

    function test_undeterminedLeavesStandingDiffPenaltyUnchanged() public {
        _submit(verifier, keccak256("diff"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 2_500);

        vm.warp(block.timestamp + 1);
        _submit(
            verifier, keccak256("undetermined"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.UNDETERMINED, 0
        );

        IAntseedVerifierRegistry.ServiceVerificationStats memory stats =
            verifierRegistry.verificationStats(agentId, SERVICE_HASH);
        assertEq(stats.activeDiffVerifierCount, 1);
        assertEq(verifierRegistry.servicePointsPenaltyBps(agentId, SERVICE_HASH), 2_500);
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 2_500);
    }

    function test_penaltiesAggregateAcrossServices() public {
        _submit(verifier, keccak256("diff-one"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 2_000);
        _submit(
            secondVerifier,
            keccak256("diff-two"),
            agentId,
            OTHER_SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.DIFF,
            3_000
        );
        assertEq(verifierRegistry.agentPointsPenaltyBps(agentId), 5_000);
    }

    function test_agentActiveDiffCountTracksDistinctVerifierAcrossServices() public {
        _submit(verifier, keccak256("diff-one"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 2_000);
        _submit(
            verifier, keccak256("diff-two"), agentId, OTHER_SERVICE_HASH, IAntseedVerifierRegistry.Verdict.DIFF, 3_000
        );

        IAntseedVerifierRegistry.ServiceVerificationStats memory agentStats =
            verifierRegistry.agentVerificationStats(agentId);
        assertEq(agentStats.activeDiffVerifierCount, 1);

        vm.warp(block.timestamp + 1);
        _submit(verifier, keccak256("same-one"), agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);
        agentStats = verifierRegistry.agentVerificationStats(agentId);
        assertEq(agentStats.activeDiffVerifierCount, 1);

        verifierRegistry.clearVerifierStanding(verifier, agentId, OTHER_SERVICE_HASH);
        agentStats = verifierRegistry.agentVerificationStats(agentId);
        assertEq(agentStats.activeDiffVerifierCount, 0);
    }

    function test_publishEvidenceIsOptionalOwnedAndOneTime() public {
        bytes32 auditId = keccak256("publish");
        _submit(verifier, auditId, agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);

        vm.prank(verifier);
        verifierRegistry.publishEvidence(auditId, "ipfs://evidence");
        assertEq(verifierRegistry.evidenceUris(auditId), "ipfs://evidence");

        vm.prank(secondVerifier);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.publishEvidence(auditId, "ipfs://other");

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.EvidenceAlreadyPublished.selector);
        verifierRegistry.publishEvidence(auditId, "ipfs://again");
    }

    function test_rejectsDuplicateUnknownSelfAndInvalidInputs() public {
        bytes32 auditId = keccak256("validation");
        _submit(verifier, auditId, agentId, SERVICE_HASH, IAntseedVerifierRegistry.Verdict.SAME, 0);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.AuditAlreadyExists.selector);
        verifierRegistry.submitVerificationResult(
            auditId,
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            _metrics(100, 100),
            keccak256("duplicate")
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.UnknownAgent.selector);
        verifierRegistry.submitVerificationResult(
            keccak256("unknown"),
            999,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            _metrics(100, 100),
            keccak256("unknown-evidence")
        );

        verifierRegistry.setVerifier(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedVerifierRegistry.SelfAudit.selector);
        verifierRegistry.submitVerificationResult(
            keccak256("self"),
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            100,
            _metrics(100, 100),
            keccak256("self-evidence")
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.InvalidModelShare.selector);
        verifierRegistry.submitVerificationResult(
            keccak256("bad-share"),
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            1,
            100,
            _metrics(100, 100),
            keccak256("bad-share-evidence")
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.ProbeCountTooLow.selector);
        verifierRegistry.submitVerificationResult(
            keccak256("few-probes"),
            agentId,
            SERVICE_HASH,
            IAntseedVerifierRegistry.Verdict.SAME,
            _currentEpoch(),
            0,
            9,
            _metrics(9, 9),
            keccak256("few-probe-evidence")
        );
    }

    function _submit(
        address caller,
        bytes32 auditId,
        uint256 targetAgentId,
        bytes32 serviceHash,
        IAntseedVerifierRegistry.Verdict verdict,
        uint16 modelShareBps
    ) private {
        vm.prank(caller);
        verifierRegistry.submitVerificationResult(
            auditId,
            targetAgentId,
            serviceHash,
            verdict,
            _currentEpoch(),
            modelShareBps,
            100,
            _metrics(100, 100),
            keccak256(abi.encode(auditId, caller))
        );
    }

    function _metrics(uint16 eligible, uint16 successful)
        private
        view
        returns (IAntseedVerifierRegistry.MetricSnapshot memory)
    {
        return IAntseedVerifierRegistry.MetricSnapshot({
            windowStartedAt: uint64(block.timestamp - 60),
            windowEndedAt: uint64(block.timestamp),
            eligibleAttempts: eligible,
            successfulAttempts: successful,
            p50TtftMs: 100,
            p95TtftMs: 200,
            p50OutputTokensPerSecondMilli: 12_000,
            schemaVersion: 1,
            observationsRoot: keccak256("observations")
        });
    }

    function _currentEpoch() private view returns (uint256) {
        return (block.timestamp - GENESIS) / 7 days;
    }
}
