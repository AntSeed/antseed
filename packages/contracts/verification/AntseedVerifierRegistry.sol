// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

contract AntseedVerifierRegistry is IAntseedVerifierRegistry, Ownable2Step {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint64 public constant MAX_AUDIT_COOLDOWN = 30 days;

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;

    mapping(address verifier => bool approved) public override approvedVerifiers;
    uint64 public override auditCooldown = 1 days;
    uint32 public override maxCreditsPerVerifierPerEpoch = 100;
    uint32 public override minProbeCount = 10;

    mapping(bytes32 auditId => Attestation attestation) private _attestations;
    mapping(bytes32 auditId => string uri) public override evidenceUris;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => Attestation attestation)) private _latestAttestations;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceVerificationStats stats)) private
        _verificationStats;
    mapping(uint256 agentId => ServiceVerificationStats stats) private _agentStats;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => mapping(address verifier => bool seen))) private
        _hasAttested;
    mapping(uint256 agentId => mapping(address verifier => bool seen)) private _hasAttestedAgent;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => mapping(address verifier => Verdict verdict))) private
        _lastVerdictByVerifier;
    mapping(uint256 agentId => mapping(address verifier => uint32 serviceCount)) private _verifierDiffServiceCount;

    mapping(bytes32 serviceKey => uint16 penaltyBps) private _servicePointsPenaltyBps;
    mapping(bytes32 serviceKey => address verifier) private _servicePointsPenaltyVerifier;
    mapping(uint256 agentId => uint256 penaltyBps) private _agentPointsPenaltyBps;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint64 timestamp)) public override lastCreditedAt;
    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public override epochCredits;
    mapping(uint256 epoch => uint256 credits) public override epochTotalCredits;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event AuditCooldownSet(uint64 cooldown);
    event MaxCreditsPerVerifierPerEpochSet(uint32 maximum);
    event MinProbeCountSet(uint32 minimum);
    event VerifierStandingCleared(address indexed verifier, uint256 indexed agentId, bytes32 indexed serviceHash);
    event AttestationSubmitted(
        bytes32 indexed auditId,
        address indexed verifier,
        uint256 indexed agentId,
        bytes32 serviceHash,
        Verdict verdict,
        uint16 modelShareBps,
        bytes32 evidenceHash,
        uint32 probeCount,
        bool credited,
        uint256 epoch
    );
    event MetricSnapshotSubmitted(
        bytes32 indexed auditId,
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        uint64 windowStartedAt,
        uint64 windowEndedAt,
        uint16 eligibleAttempts,
        uint16 successfulAttempts,
        uint32 p50TtftMs,
        uint32 p95TtftMs,
        uint32 p50OutputTokensPerSecondMilli,
        uint16 schemaVersion,
        bytes32 observationsRoot
    );
    event EvidencePublished(bytes32 indexed auditId, string evidenceUri);
    event ServicePointsPenaltySet(uint256 indexed agentId, bytes32 indexed serviceHash, uint16 penaltyBps);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error InvalidModelShare();
    error EpochChanged();
    error ProbeCountTooLow();
    error AuditAlreadyExists();
    error AuditNotFound();
    error EvidenceAlreadyPublished();
    error UnknownAgent();
    error SelfAudit();
    error NoStandingDiff();
    error EmissionsGateMismatch();

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_, address emissionsGate_) Ownable(msg.sender) {
        if (registry_ == address(0) || emissionsGate_ == address(0)) revert InvalidAddress();
        if (registry_.code.length == 0 || emissionsGate_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        emissionsGate = IAntseedEmissionsGate(emissionsGate_);
        if (address(emissionsGate.registry()) != registry_) revert EmissionsGateMismatch();
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setAuditCooldown(uint64 cooldown) external override onlyOwner {
        if (cooldown > MAX_AUDIT_COOLDOWN) revert InvalidValue();
        auditCooldown = cooldown;
        emit AuditCooldownSet(cooldown);
    }

    function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external override onlyOwner {
        if (maximum == 0) revert InvalidValue();
        maxCreditsPerVerifierPerEpoch = maximum;
        emit MaxCreditsPerVerifierPerEpochSet(maximum);
    }

    function setMinProbeCount(uint32 minimum) external override onlyOwner {
        if (minimum == 0) revert InvalidValue();
        minProbeCount = minimum;
        emit MinProbeCountSet(minimum);
    }

    function clearVerifierStanding(address verifier, uint256 agentId, bytes32 serviceHash)
        external
        override
        onlyOwner
    {
        if (_lastVerdictByVerifier[agentId][serviceHash][verifier] != Verdict.DIFF) revert NoStandingDiff();
        _lastVerdictByVerifier[agentId][serviceHash][verifier] = Verdict.UNKNOWN;
        ServiceVerificationStats storage serviceStats = _verificationStats[agentId][serviceHash];
        ServiceVerificationStats storage agentStats = _agentStats[agentId];
        serviceStats.activeDiffVerifierCount--;
        if (--_verifierDiffServiceCount[agentId][verifier] == 0) agentStats.activeDiffVerifierCount--;
        bytes32 key = _serviceKey(agentId, serviceHash);
        if (_servicePointsPenaltyVerifier[key] == verifier) _setServicePenalty(agentId, serviceHash, 0, address(0));
        emit VerifierStandingCleared(verifier, agentId, serviceHash);
    }

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
    ) external override onlyApprovedVerifier {
        if (auditId == bytes32(0) || agentId == 0 || serviceHash == bytes32(0) || evidenceHash == bytes32(0)) {
            revert InvalidValue();
        }
        if (_attestations[auditId].verifier != address(0)) revert AuditAlreadyExists();
        if (verdict == Verdict.UNKNOWN || uint8(verdict) > uint8(Verdict.UNDETERMINED)) revert InvalidVerdict();
        if (probeCount < minProbeCount) revert ProbeCountTooLow();
        if (modelShareBps > BPS_DENOMINATOR) revert InvalidModelShare();
        if (verdict != Verdict.DIFF && modelShareBps != 0) revert InvalidModelShare();
        if (metrics.successfulAttempts > metrics.eligibleAttempts || metrics.windowEndedAt < metrics.windowStartedAt) {
            revert InvalidValue();
        }

        address seller = _resolveAgentOwner(agentId);
        if (seller == msg.sender) revert SelfAudit();

        uint64 nowTs = uint64(block.timestamp);
        uint256 epoch = currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();
        Attestation memory attestation = Attestation({
            auditId: auditId,
            verifier: msg.sender,
            agentId: agentId,
            serviceHash: serviceHash,
            verdict: verdict,
            modelShareBps: modelShareBps,
            probeCount: probeCount,
            attestedAt: nowTs,
            evidenceHash: evidenceHash
        });
        _attestations[auditId] = attestation;
        _latestAttestations[agentId][serviceHash] = attestation;

        ServiceVerificationStats storage serviceStats = _verificationStats[agentId][serviceHash];
        ServiceVerificationStats storage agentStats = _agentStats[agentId];
        bool firstForService = !_hasAttested[agentId][serviceHash][msg.sender];
        if (firstForService) {
            _hasAttested[agentId][serviceHash][msg.sender] = true;
        }
        bool firstForAgent = !_hasAttestedAgent[agentId][msg.sender];
        if (firstForAgent) _hasAttestedAgent[agentId][msg.sender] = true;
        _bumpStats(serviceStats, verdict, msg.sender, firstForService);
        _bumpStats(agentStats, verdict, msg.sender, firstForAgent);
        _updateStandingDiff(agentId, serviceHash, msg.sender, verdict, serviceStats, agentStats);
        _applyAttestationPenalty(agentId, serviceHash, verdict, modelShareBps);

        bool credited = nowTs - lastCreditedAt[agentId][serviceHash] >= auditCooldown
            && epochCredits[epoch][msg.sender] < maxCreditsPerVerifierPerEpoch;
        if (credited) {
            lastCreditedAt[agentId][serviceHash] = nowTs;
            epochCredits[epoch][msg.sender]++;
            epochTotalCredits[epoch]++;
        }

        emit AttestationSubmitted(
            auditId, msg.sender, agentId, serviceHash, verdict, modelShareBps, evidenceHash, probeCount, credited, epoch
        );
        emit MetricSnapshotSubmitted(
            auditId,
            agentId,
            serviceHash,
            metrics.windowStartedAt,
            metrics.windowEndedAt,
            metrics.eligibleAttempts,
            metrics.successfulAttempts,
            metrics.p50TtftMs,
            metrics.p95TtftMs,
            metrics.p50OutputTokensPerSecondMilli,
            metrics.schemaVersion,
            metrics.observationsRoot
        );
    }

    function publishEvidence(bytes32 auditId, string calldata evidenceUri) external override {
        Attestation storage attestation = _attestations[auditId];
        if (attestation.verifier == address(0)) revert AuditNotFound();
        if (attestation.verifier != msg.sender) revert NotApprovedVerifier();
        if (bytes(evidenceUri).length == 0) revert InvalidValue();
        if (bytes(evidenceUris[auditId]).length != 0) revert EvidenceAlreadyPublished();
        evidenceUris[auditId] = evidenceUri;
        emit EvidencePublished(auditId, evidenceUri);
    }

    function getAttestation(bytes32 auditId) external view override returns (Attestation memory) {
        return _attestations[auditId];
    }

    function latestAttestation(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (Attestation memory)
    {
        return _latestAttestations[agentId][serviceHash];
    }

    function verificationStats(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (ServiceVerificationStats memory)
    {
        return _verificationStats[agentId][serviceHash];
    }

    function agentVerificationStats(uint256 agentId) external view override returns (ServiceVerificationStats memory) {
        return _agentStats[agentId];
    }

    function currentEpoch() public view override returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    function servicePointsPenaltyBps(uint256 agentId, bytes32 serviceHash) external view override returns (uint16) {
        return _servicePointsPenaltyBps[_serviceKey(agentId, serviceHash)];
    }

    function agentPointsPenaltyBps(uint256 agentId) external view override returns (uint256) {
        return _agentPointsPenaltyBps[agentId];
    }

    function _resolveAgentOwner(uint256 agentId) private view returns (address) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
        }
    }

    function _bumpStats(ServiceVerificationStats storage stats, Verdict verdict, address verifier, bool first)
        private
    {
        if (verdict == Verdict.SAME) stats.sameCount++;
        else if (verdict == Verdict.DIFF) stats.diffCount++;
        else stats.undeterminedCount++;
        if (first) stats.distinctVerifierCount++;
        stats.lastVerdict = verdict;
        stats.lastVerifier = verifier;
    }

    function _updateStandingDiff(
        uint256 agentId,
        bytes32 serviceHash,
        address verifier,
        Verdict verdict,
        ServiceVerificationStats storage serviceStats,
        ServiceVerificationStats storage agentStats
    ) private {
        if (verdict == Verdict.UNDETERMINED) return;

        Verdict previous = _lastVerdictByVerifier[agentId][serviceHash][verifier];
        if (previous == verdict) return;
        _lastVerdictByVerifier[agentId][serviceHash][verifier] = verdict;
        if (previous == Verdict.DIFF) {
            serviceStats.activeDiffVerifierCount--;
            if (--_verifierDiffServiceCount[agentId][verifier] == 0) agentStats.activeDiffVerifierCount--;
        } else if (verdict == Verdict.DIFF) {
            serviceStats.activeDiffVerifierCount++;
            if (++_verifierDiffServiceCount[agentId][verifier] == 1) agentStats.activeDiffVerifierCount++;
        }
    }

    function _applyAttestationPenalty(uint256 agentId, bytes32 serviceHash, Verdict verdict, uint16 modelShareBps)
        private
    {
        if (verdict == Verdict.DIFF) _setServicePenalty(agentId, serviceHash, modelShareBps, msg.sender);
        else if (verdict == Verdict.SAME) _setServicePenalty(agentId, serviceHash, 0, address(0));
    }

    function _setServicePenalty(uint256 agentId, bytes32 serviceHash, uint16 nextPenalty, address verifier) private {
        bytes32 key = _serviceKey(agentId, serviceHash);
        uint16 previousPenalty = _servicePointsPenaltyBps[key];
        address previousVerifier = _servicePointsPenaltyVerifier[key];
        if (previousPenalty == nextPenalty && previousVerifier == verifier) return;
        _servicePointsPenaltyBps[key] = nextPenalty;
        _servicePointsPenaltyVerifier[key] = verifier;
        _agentPointsPenaltyBps[agentId] = _agentPointsPenaltyBps[agentId] - previousPenalty + nextPenalty;
        emit ServicePointsPenaltySet(agentId, serviceHash, nextPenalty);
    }

    function _serviceKey(uint256 agentId, bytes32 serviceHash) private pure returns (bytes32) {
        return keccak256(abi.encode(agentId, serviceHash));
    }
}
