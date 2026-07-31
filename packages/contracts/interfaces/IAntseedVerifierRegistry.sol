// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "./IAntseedRegistry.sol";

interface IAntseedVerifierRegistry {
    enum Verdict {
        UNKNOWN,
        SAME,
        DIFF,
        UNDETERMINED
    }

    struct AuditJob {
        bytes32 auditId;
        uint16 jobIndex;
        address relayBuyer;
        address sellerPeerId;
        bytes32 serviceHash;
        bytes32 requestHash;
        bytes32 jobSalt;
        uint8 attempt;
        uint64 executeAfter;
        uint64 executeBefore;
    }

    struct RelayClaim {
        AuditJob job;
        bytes32[] jobProof;
        bytes responseAuthPayload;
    }

    struct MetricSnapshot {
        uint64 windowStartedAt;
        uint64 windowEndedAt;
        uint16 eligibleAttempts;
        uint16 successfulAttempts;
        uint32 p50TtftMs;
        uint32 p95TtftMs;
        uint32 p50OutputTokensPerSecondMilli;
        uint16 schemaVersion;
        bytes32 observationsRoot;
    }

    struct Audit {
        address committer;
        bytes32 targetCommitment;
        bytes32 probeRoot;
        bytes32 auditJobRoot;
        bytes32 referenceId;
        bytes32 verifierConfigHash;
        uint256 commitSequence;
        uint32 probeCount;
        uint16 jobCount;
        uint96 payoutPerJobUsdc;
        uint96 reservedRelayBudgetUsdc;
        uint96 totalRelayPaidUsdc;
        uint64 committedAt;
        uint64 executeAfter;
        uint64 executeBefore;
        uint64 forceClaimAvailableAt;
        uint64 forceClaimDeadline;
        uint64 attestedAt;
        bool attested;
        bytes32 evidenceHash;
        string evidenceUri;
    }

    struct Attestation {
        bytes32 auditId;
        address verifier;
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
        uint16 modelShareBps;
        uint64 attestedAt;
        bytes32 evidenceHash;
    }

    function registry() external view returns (IAntseedRegistry);
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    function relayTreasury() external view returns (address);
    function approvedVerifiers(address verifier) external view returns (bool);
    function relayJobPaidBitmap(bytes32 auditId) external view returns (uint256);
    function paidRequestHashes(bytes32 requestHash) external view returns (bytes32);

    function setVerifier(address verifier, bool approved) external;
    function setRelayTreasury(address treasury) external;

    function commitProbes(
        bytes32 auditId,
        bytes32 targetCommitment,
        bytes32 probeRoot,
        bytes32 auditJobRoot,
        bytes32 referenceId,
        bytes32 verifierConfigHash,
        uint32 probeCount,
        uint16 jobCount,
        uint96 payoutPerJobUsdc
    ) external;

    function submitAttestation(
        bytes32 auditId,
        uint256 agentId,
        bytes32 serviceHash,
        bytes32 targetSalt,
        Verdict verdict,
        uint16 modelShareBps,
        MetricSnapshot calldata metrics,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        RelayClaim[] calldata relayClaims
    ) external;

    function forceClaimRelayJob(bytes32 auditId, RelayClaim calldata relayClaim) external;
    function publishEvidence(bytes32 auditId, string calldata evidenceUri) external;

    function getAudit(bytes32 auditId) external view returns (Audit memory);
    function getAttestation(bytes32 auditId) external view returns (Attestation memory);
    function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (Attestation memory);
    function lastAcceptedAuditSequence(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16);

    function hashAuditTarget(uint256 agentId, bytes32 serviceHash, bytes32 targetSalt)
        external
        view
        returns (bytes32);
    function hashAuditJob(AuditJob memory job) external view returns (bytes32);
    function verifyAuditJobProof(bytes32 root, bytes32 leaf, uint16 jobIndex, uint16 jobCount, bytes32[] calldata proof)
        external
        pure
        returns (bool);
    function hashNormalizedService(string calldata advertisedService) external pure returns (bytes32);
    function responseAuthDigest(bytes calldata signingPayload) external pure returns (bytes32);
    function parseResponseAuthPayload(bytes calldata payload)
        external
        pure
        returns (
            address buyer,
            address seller,
            bytes32 advertisedServiceHash,
            uint16 statusCode,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        );
    function isRelayJobPaid(bytes32 auditId, uint16 jobIndex) external view returns (bool);
    function requiredRelayCount(uint16 jobCount) external pure returns (uint16);
}
