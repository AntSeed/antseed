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

    struct Attestation {
        bytes32 auditId;
        address verifier;
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
        uint16 modelShareBps;
        uint32 probeCount;
        uint64 attestedAt;
        bytes32 evidenceHash;
    }

    struct ServiceVerificationStats {
        uint32 sameCount;
        uint32 diffCount;
        uint32 undeterminedCount;
        Verdict lastVerdict;
        address lastVerifier;
    }

    function registry() external view returns (IAntseedRegistry);
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    function approvedVerifiers(address verifier) external view returns (bool);
    function maxCreditsPerVerifierPerEpoch() external view returns (uint32);

    function setVerifier(address verifier, bool approved) external;
    function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external;

    function submitVerificationResult(
        bytes32 auditId,
        uint256 agentId,
        bytes32 serviceHash,
        Verdict verdict,
        uint256 expectedEpoch,
        uint16 modelShareBps,
        uint32 probeCount,
        MetricSnapshot calldata metrics,
        bytes32 evidenceHash
    ) external;

    function getAttestation(bytes32 auditId) external view returns (Attestation memory);
    function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (Attestation memory);
    function verificationStats(uint256 agentId, bytes32 serviceHash)
        external
        view
        returns (ServiceVerificationStats memory);
    function agentVerificationStats(uint256 agentId) external view returns (ServiceVerificationStats memory);
    function epochCredits(uint256 epoch, address verifier) external view returns (uint256);
    function epochTotalCredits(uint256 epoch) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function servicePointsPenaltyBps(uint256 agentId, bytes32 serviceHash) external view returns (uint16);
    function agentPointsPenaltyBps(uint256 agentId) external view returns (uint256);
}
