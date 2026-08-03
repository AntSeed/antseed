// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedRelayTreasury } from "../../interfaces/IAntseedRelayTreasury.sol";
import { IAntseedVerifierRegistry } from "../../interfaces/IAntseedVerifierRegistry.sol";
import { AntseedRelayTreasury } from "../../verification/AntseedRelayTreasury.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { MockDeposits } from "../mocks/MockDeposits.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";
import { ResponseAuthFixture } from "./ResponseAuthFixture.sol";

contract VerifierTestGate {
    address public immutable registry;
    uint256 public immutable GENESIS;
    uint256 public immutable EPOCH_DURATION;

    constructor(address registry_, uint256 genesis_, uint256 duration_) {
        registry = registry_;
        GENESIS = genesis_;
        EPOCH_DURATION = duration_;
    }

    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }
}

contract VerifierTestUsageAccounting { }

contract AntseedVerifierRegistryTest is ResponseAuthFixture {
    uint256 private constant VERIFIER_KEY = 0xA11CE;
    uint256 private constant SELLER_KEY = 0xB0B;
    uint96 private constant PAYOUT = 30_000;
    uint256 private constant TARGET_CHAIN_BLOCK_GAS_LIMIT = 30_000_000;

    AntseedRegistry private registry;
    AntseedVerifierRegistry private verifierRegistry;
    AntseedRelayTreasury private treasury;
    MockDeposits private deposits;
    MockERC8004Registry private identityRegistry;
    MockUSDC private usdc;
    VerifierTestGate private gate;

    address private verifier;
    address private seller;
    address[10] private relays;
    address[10] private operators;
    bytes32 private serviceHash;
    string private service = "openai/gpt-4o";
    uint256 private auditNonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        verifier = vm.addr(VERIFIER_KEY);
        seller = vm.addr(SELLER_KEY);
        registry = new AntseedRegistry();
        deposits = new MockDeposits();
        identityRegistry = new MockERC8004Registry();
        usdc = new MockUSDC();
        gate = new VerifierTestGate(address(registry), block.timestamp - 3 days, 7 days);

        for (uint256 i = 0; i < 10; i++) {
            relays[i] = address(uint160(0xA001 + i));
            operators[i] = address(uint160(0xB001 + i));
            deposits.setOperator(relays[i], operators[i]);
        }
        deposits.setUsdc(address(usdc));
        identityRegistry.setOwner(1, seller);
        registry.setDeposits(address(deposits));
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(new VerifierTestUsageAccounting()));

        verifierRegistry = new AntseedVerifierRegistry(address(registry), address(gate));
        treasury = new AntseedRelayTreasury(address(usdc), address(verifierRegistry), 100_000, 5_000_000, 20_000_000);
        verifierRegistry.setRelayTreasury(address(treasury));
        verifierRegistry.setVerifier(verifier, true);
        usdc.mint(address(treasury), 20_000_000);
        serviceHash = verifierRegistry.hashNormalizedService(service);
    }

    function test_constructorRejectsMismatchedGateRegistry() public {
        AntseedRegistry otherRegistry = new AntseedRegistry();
        vm.expectRevert(AntseedVerifierRegistry.EmissionsGateMismatch.selector);
        new AntseedVerifierRegistry(address(otherRegistry), address(gate));
    }

    function test_commitUsesExplicitGateAndReservesFixedBudget() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs,) = _commitAudit(4, bytes32(0));
        IAntseedVerifierRegistry.Audit memory audit = verifierRegistry.getAudit(auditId);
        IAntseedRelayTreasury.AuditReservation memory reservation = treasury.getReservation(auditId);
        assertEq(audit.payoutPerJobUsdc, PAYOUT);
        assertEq(audit.reservedRelayBudgetUsdc, PAYOUT * 4);
        assertEq(reservation.totalBudgetUsdc, PAYOUT * 4);
        assertEq(reservation.jobCount, 4);
        assertEq(address(verifierRegistry.emissionsGate()), address(gate));
        assertEq(jobs.length, 4);
    }

    function test_commitRevertsWhenTreasuryUnderfunded() public {
        AntseedVerifierRegistry emptyRegistry = new AntseedVerifierRegistry(address(registry), address(gate));
        AntseedRelayTreasury emptyTreasury =
            new AntseedRelayTreasury(address(usdc), address(emptyRegistry), PAYOUT, PAYOUT, PAYOUT);
        emptyRegistry.setRelayTreasury(address(emptyTreasury));
        emptyRegistry.setVerifier(verifier, true);
        vm.prank(verifier);
        vm.expectRevert(AntseedRelayTreasury.InsufficientTreasuryBalance.selector);
        emptyRegistry.commitProbes(
            bytes32("audit"), bytes32("target"), bytes32("probe"), bytes32("root"), 0, 0, 1, 1, PAYOUT
        );
    }

    function test_revokedVerifierCannotSubmitCommittedAudit() public {
        (bytes32 auditId, bytes32 targetSalt,,) = _commitAudit(1, bytes32(0));
        verifierRegistry.setVerifier(verifier, false);
        vm.warp(verifierRegistry.getAudit(auditId).executeBefore);

        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](0);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.NotApprovedVerifier.selector);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.UNDETERMINED,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );

        assertFalse(verifierRegistry.getAudit(auditId).attested);
    }

    function test_positionalProofRejectsWrongSideDepthAndIndex() public {
        (, bytes32 root, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _buildAudit(3, bytes32(0));
        bytes32 leaf = verifierRegistry.hashAuditJob(jobs[1]);
        assertTrue(verifierRegistry.verifyAuditJobProof(root, leaf, 1, 3, proofs[1]));

        bytes32[] memory shortProof = new bytes32[](1);
        shortProof[0] = proofs[1][0];
        assertFalse(verifierRegistry.verifyAuditJobProof(root, leaf, 1, 3, shortProof));
        assertFalse(verifierRegistry.verifyAuditJobProof(root, leaf, 0, 3, proofs[1]));
        assertFalse(verifierRegistry.verifyAuditJobProof(root, leaf, 3, 3, proofs[1]));
    }

    function test_non200ResponseCannotBePaid() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 500);
        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidResponseAuth.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_forcePaidClaimCountsInAttestationWithoutDoublePayment() public {
        (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        ) = _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        IAntseedVerifierRegistry.Audit memory audit = verifierRegistry.getAudit(auditId);
        vm.warp(audit.forceClaimAvailableAt + 1);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
        uint256 operatorBalance = usdc.balanceOf(operators[0]);

        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](1);
        claims[0] = claim;
        vm.prank(verifier);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.SAME,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );
        assertEq(usdc.balanceOf(operators[0]), operatorBalance);
        assertEq(verifierRegistry.getAudit(auditId).totalRelayPaidUsdc, PAYOUT);
    }

    function test_requestHashCannotBePaidAcrossAudits() public {
        bytes32 reusedRequest = keccak256("reused-request");
        _payOneAudit(reusedRequest);
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, reusedRequest);
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.RequestHashAlreadyPaid.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_requestReplayInsideAuditRollsBackEntireBatch() public {
        bytes32 reusedRequest = keccak256("same-audit-request");
        (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        ) = _commitAudit(2, reusedRequest);
        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](2);
        claims[0] = _claim(jobs[0], proofs[0], 200);
        claims[1] = _claim(jobs[1], proofs[1], 200);
        vm.warp(verifierRegistry.getAudit(auditId).executeBefore);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.RequestHashAlreadyPaid.selector);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.UNDETERMINED,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );
        assertFalse(verifierRegistry.isRelayJobPaid(auditId, 0));
        assertEq(verifierRegistry.paidRequestHashes(reusedRequest), bytes32(0));
        assertEq(treasury.totalLockedUsdc(), PAYOUT * 2);
        assertEq(usdc.balanceOf(operators[0]), 0);
    }

    function test_responseBuyerMustMatchCommittedRelayBuyer() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayAssignment memory assignment = _assignment(jobs[0], relays[0]);
        IAntseedVerifierRegistry.RelayClaim memory claim = IAntseedVerifierRegistry.RelayClaim({
            job: jobs[0],
            jobProof: proofs[0],
            assignment: assignment,
            verifierSignature: _signAssignment(assignment, VERIFIER_KEY),
            responseAuthPayload: _signedResponseAuth(
                verifierRegistry,
                SELLER_KEY,
                relays[1],
                seller,
                service,
                200,
                jobs[0].requestHash,
                jobs[0].executeAfter * 1000,
                jobs[0].executeBefore * 1000
            )
        });
        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidResponseAuth.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_assignmentSignerMustBeAuditCommitter() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        claim.verifierSignature = _signAssignment(claim.assignment, SELLER_KEY);

        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidRelayAssignment.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_assignmentPayoutMustMatchCommittedPayout() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        claim.assignment.payoutPerJobUsdc = PAYOUT - 1;
        claim.verifierSignature = _signAssignment(claim.assignment, VERIFIER_KEY);

        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidRelayAssignment.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_assignmentJobIndexMustMatchCommittedJob() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(2, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        claim.assignment.jobIndex = 1;
        claim.verifierSignature = _signAssignment(claim.assignment, VERIFIER_KEY);

        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidRelayAssignment.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_assignmentWindowMustFitCommittedJobWindow() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        claim.assignment.executeBefore = jobs[0].executeBefore + 1;
        claim.verifierSignature = _signAssignment(claim.assignment, VERIFIER_KEY);

        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        vm.expectRevert(AntseedVerifierRegistry.InvalidRelayAssignment.selector);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function test_attestationBatchesFixedPricePaymentsAndChecksDiversity() public {
        (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        ) = _commitAudit(4, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](3);
        for (uint256 i = 0; i < 3; i++) {
            claims[i] = _claim(jobs[i], proofs[i], 200);
        }
        vm.warp(verifierRegistry.getAudit(auditId).executeBefore);
        vm.prank(verifier);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.DIFF,
            2_500,
            _metrics(),
            bytes32("evidence"),
            "ipfs://evidence",
            claims
        );
        for (uint256 i = 0; i < 3; i++) {
            assertEq(usdc.balanceOf(operators[i]), PAYOUT);
        }
        assertEq(verifierRegistry.getAudit(auditId).totalRelayPaidUsdc, PAYOUT * 3);
        assertEq(treasury.totalLockedUsdc(), PAYOUT);
    }

    function test_fiftyClaimAttestationWithTenRelaysStaysBelowHalfTargetBlockGasLimit() public {
        (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        ) = _commitAudit(50, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](50);
        for (uint256 i = 0; i < claims.length; i++) {
            claims[i] = _claim(jobs[i], proofs[i], 200);
        }

        vm.warp(verifierRegistry.getAudit(auditId).executeBefore);
        vm.prank(verifier);
        uint256 gasBefore = gasleft();
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.SAME,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("50-claim attestation gas", gasUsed);
        assertLt(gasUsed, TARGET_CHAIN_BLOCK_GAS_LIMIT / 2);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(usdc.balanceOf(operators[i]), PAYOUT * 5);
        }
        assertEq(verifierRegistry.getAudit(auditId).totalRelayPaidUsdc, PAYOUT * 50);
        assertEq(treasury.totalLockedUsdc(), 0);
    }

    function test_evidenceCanBePublishedExactlyOnceAfterLocalHashAttestation() public {
        (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        ) = _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](1);
        claims[0] = _claim(jobs[0], proofs[0], 200);
        vm.warp(verifierRegistry.getAudit(auditId).executeBefore);
        vm.prank(verifier);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.SAME,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );

        vm.prank(verifier);
        verifierRegistry.publishEvidence(auditId, "ipfs://evidence");
        assertEq(verifierRegistry.getAudit(auditId).evidenceUri, "ipfs://evidence");
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.EvidenceAlreadyPublished.selector);
        verifierRegistry.publishEvidence(auditId, "ipfs://replacement");
    }

    function test_staleAttestationRejectedAfterFallbackDeadline() public {
        (bytes32 auditId, bytes32 targetSalt,,) = _commitAudit(1, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim[] memory claims = new IAntseedVerifierRegistry.RelayClaim[](0);
        vm.warp(verifierRegistry.getAudit(auditId).forceClaimDeadline + 1);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerifierRegistry.AttestationExpired.selector);
        verifierRegistry.submitAttestation(
            auditId,
            1,
            serviceHash,
            targetSalt,
            IAntseedVerifierRegistry.Verdict.UNDETERMINED,
            0,
            _metrics(),
            bytes32("evidence"),
            "",
            claims
        );
    }

    function test_expiredReservationReleasesOnlyOutstandingBudget() public {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(2, bytes32(0));
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        IAntseedVerifierRegistry.Audit memory audit = verifierRegistry.getAudit(auditId);
        vm.warp(audit.forceClaimAvailableAt + 1);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
        vm.warp(audit.forceClaimDeadline + 1);
        treasury.releaseExpiredAuditBudget(auditId);
        assertEq(treasury.totalLockedUsdc(), 0);
        assertEq(treasury.committedBudgetByEpoch(treasury.getReservation(auditId).epoch), PAYOUT * 2);
    }

    function _payOneAudit(bytes32 requestHash) private {
        (bytes32 auditId,, IAntseedVerifierRegistry.AuditJob[] memory jobs, bytes32[][] memory proofs) =
            _commitAudit(1, requestHash);
        IAntseedVerifierRegistry.RelayClaim memory claim = _claim(jobs[0], proofs[0], 200);
        vm.warp(verifierRegistry.getAudit(auditId).forceClaimAvailableAt + 1);
        verifierRegistry.forceClaimRelayJob(auditId, claim);
    }

    function _commitAudit(uint16 jobCount, bytes32 forcedRequestHash)
        private
        returns (
            bytes32 auditId,
            bytes32 targetSalt,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        )
    {
        bytes32 root;
        (auditId, root, jobs, proofs) = _buildAudit(jobCount, forcedRequestHash);
        targetSalt = keccak256(abi.encode(auditId, "target"));
        bytes32 targetCommitment = verifierRegistry.hashAuditTarget(1, serviceHash, targetSalt);
        vm.prank(verifier);
        verifierRegistry.commitProbes(
            auditId,
            targetCommitment,
            keccak256(abi.encode(auditId, "probes")),
            root,
            bytes32("reference"),
            bytes32("config"),
            jobCount,
            jobCount,
            PAYOUT
        );
    }

    function _buildAudit(uint16 jobCount, bytes32 forcedRequestHash)
        private
        returns (
            bytes32 auditId,
            bytes32 root,
            IAntseedVerifierRegistry.AuditJob[] memory jobs,
            bytes32[][] memory proofs
        )
    {
        auditId = keccak256(abi.encode(++auditNonce, block.timestamp));
        uint64 executeAfter = uint64(block.timestamp);
        uint64 executeBefore = uint64(gate.GENESIS() + (gate.currentEpoch() + 1) * gate.EPOCH_DURATION());
        jobs = new IAntseedVerifierRegistry.AuditJob[](jobCount);
        for (uint16 i = 0; i < jobCount; i++) {
            jobs[i] = IAntseedVerifierRegistry.AuditJob({
                auditId: auditId,
                jobIndex: i,
                sellerPeerId: seller,
                serviceHash: serviceHash,
                requestHash: forcedRequestHash == bytes32(0)
                    ? keccak256(abi.encode(auditId, i, "request"))
                    : forcedRequestHash,
                jobSalt: keccak256(abi.encode(auditId, i, "salt")),
                executeAfter: executeAfter,
                executeBefore: executeBefore
            });
        }
        (root, proofs) = _tree(jobs);
    }

    function _tree(IAntseedVerifierRegistry.AuditJob[] memory jobs)
        private
        view
        returns (bytes32 root, bytes32[][] memory proofs)
    {
        uint256 capacity = 1;
        uint256 depth;
        while (capacity < jobs.length) {
            capacity <<= 1;
            depth++;
        }
        bytes32[] memory nodes = new bytes32[](capacity * 2);
        for (uint256 i = 0; i < capacity; i++) {
            nodes[capacity + i] = i < jobs.length
                ? verifierRegistry.hashAuditJob(jobs[i])
                : keccak256(abi.encodePacked(bytes1(0x00), uint16(i)));
        }
        for (uint256 i = capacity - 1; i > 0; i--) {
            nodes[i] = keccak256(abi.encodePacked(bytes1(0x01), nodes[i * 2], nodes[i * 2 + 1]));
        }
        root = nodes[1];
        proofs = new bytes32[][](jobs.length);
        for (uint256 i = 0; i < jobs.length; i++) {
            proofs[i] = new bytes32[](depth);
            uint256 cursor = capacity + i;
            for (uint256 level = 0; level < depth; level++) {
                proofs[i][level] = nodes[cursor ^ 1];
                cursor >>= 1;
            }
        }
    }

    function _claim(IAntseedVerifierRegistry.AuditJob memory job, bytes32[] memory proof, uint256 statusCode)
        private
        returns (IAntseedVerifierRegistry.RelayClaim memory)
    {
        address relayBuyer = relays[job.jobIndex % 10];
        IAntseedVerifierRegistry.RelayAssignment memory assignment = _assignment(job, relayBuyer);
        return IAntseedVerifierRegistry.RelayClaim({
            job: job,
            jobProof: proof,
            assignment: assignment,
            verifierSignature: _signAssignment(assignment, VERIFIER_KEY),
            responseAuthPayload: _signedResponseAuth(
                verifierRegistry,
                SELLER_KEY,
                relayBuyer,
                seller,
                service,
                statusCode,
                job.requestHash,
                job.executeAfter * 1000,
                job.executeBefore * 1000
            )
        });
    }

    function _assignment(IAntseedVerifierRegistry.AuditJob memory job, address relayBuyer)
        private
        pure
        returns (IAntseedVerifierRegistry.RelayAssignment memory)
    {
        return IAntseedVerifierRegistry.RelayAssignment({
            auditId: job.auditId,
            jobIndex: job.jobIndex,
            attempt: 0,
            relayBuyer: relayBuyer,
            payoutPerJobUsdc: PAYOUT,
            executeAfter: job.executeAfter,
            executeBefore: job.executeBefore
        });
    }

    function _signAssignment(IAntseedVerifierRegistry.RelayAssignment memory assignment, uint256 signerKey)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, verifierRegistry.hashRelayAssignment(assignment));
        return abi.encodePacked(r, s, v);
    }

    function _metrics() private pure returns (IAntseedVerifierRegistry.MetricSnapshot memory) {
        return IAntseedVerifierRegistry.MetricSnapshot({
            windowStartedAt: 1,
            windowEndedAt: 2,
            eligibleAttempts: 1,
            successfulAttempts: 1,
            p50TtftMs: 10,
            p95TtftMs: 20,
            p50OutputTokensPerSecondMilli: 30,
            schemaVersion: 1,
            observationsRoot: bytes32("observations")
        });
    }
}
