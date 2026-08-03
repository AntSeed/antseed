// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedRelayTreasury } from "../interfaces/IAntseedRelayTreasury.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

contract AntseedVerifierRegistry is IAntseedVerifierRegistry, Ownable2Step, ReentrancyGuard, EIP712 {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FORCE_CLAIM_DELAY = 6 hours;
    uint256 public constant FORCE_CLAIM_WINDOW = 30 days;
    uint256 public constant MAX_AUDIT_JOBS = 100;
    uint256 public constant MAX_RELAY_CLAIMS = 50;
    uint8 public constant MAX_RELAY_ATTEMPTS = 3;

    bytes private constant DATA_DOMAIN = "antseed-data-v1:";
    bytes32 private constant RESPONSE_AUTH_DOMAIN_HASH = keccak256("antseed-response-auth-v1");
    bytes32 private constant RESPONSE_AUTH_VERSION_HASH = keccak256("1");
    bytes32 private constant RELAY_ASSIGNMENT_TYPEHASH = keccak256(
        "RelayAssignment(bytes32 auditId,uint16 jobIndex,uint8 attempt,address relayBuyer,uint96 payoutPerJobUsdc,uint64 executeAfter,uint64 executeBefore)"
    );
    uint256 private constant RESPONSE_AUTH_FIELD_COUNT = 13;
    uint256 private constant RESPONSE_AUTH_SIGNATURE_LENGTH = 65;

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    address private _relayTreasury;

    mapping(address verifier => bool approved) public override approvedVerifiers;
    mapping(bytes32 auditId => Audit audit) private _audits;
    mapping(bytes32 auditId => Attestation attestation) private _attestations;
    mapping(bytes32 auditId => uint256 paidBitmap) public override relayJobPaidBitmap;
    mapping(bytes32 requestHash => bytes32 paymentKey) public override paidRequestHashes;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => Attestation attestation)) private _latestAttestations;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 sequence)) public override
        lastAcceptedAuditSequence;
    uint256 public auditCommitSequence;

    mapping(bytes32 serviceKey => uint16 penaltyBps) private _servicePointsPenaltyBps;
    mapping(uint256 agentId => uint256 penaltyBps) private _agentPointsPenaltyBps;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event RelayTreasurySet(address indexed treasury);
    event AuditCommitted(
        bytes32 indexed auditId,
        address indexed committer,
        uint256 commitSequence,
        bytes32 targetCommitment,
        bytes32 probeRoot,
        bytes32 auditJobRoot,
        uint32 probeCount,
        uint16 jobCount,
        uint96 payoutPerJobUsdc,
        uint96 reservedRelayBudgetUsdc,
        uint64 executeAfter,
        uint64 executeBefore
    );
    event RelayJobPaid(
        bytes32 indexed auditId,
        uint16 indexed jobIndex,
        address indexed relayBuyer,
        address recipient,
        uint96 amount,
        bool forced
    );
    event ServicePointsPenaltySet(uint256 indexed agentId, bytes32 indexed serviceHash, uint16 modelShareBps);
    event AttestationSubmitted(
        bytes32 indexed auditId,
        address indexed verifier,
        uint256 indexed agentId,
        bytes32 serviceHash,
        Verdict verdict,
        uint16 modelShareBps,
        bytes32 evidenceHash,
        uint256 relayClaimCount,
        uint96 relayPayoutUsdc
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

    error InvalidAddress();
    error InvalidValue();
    error EmissionsGateMismatch();
    error NotApprovedVerifier();
    error AuditAlreadyCommitted();
    error AuditNotFound();
    error AuditAlreadyAttested();
    error AuditNotReady();
    error AttestationExpired();
    error InvalidJobCount();
    error InvalidAuditWindow();
    error InvalidPayout();
    error RelayTreasuryNotConfigured();
    error RelayTreasuryAlreadyConfigured();
    error RelayTreasuryMismatch();
    error InvalidTargetOpening();
    error UnknownAgent();
    error SelfAudit();
    error StaleAudit();
    error InvalidVerdict();
    error InvalidModelShareBps();
    error TooManyRelayClaims();
    error InsufficientRelayCoverage();
    error InsufficientRelayDiversity();
    error InvalidJob();
    error InvalidJobProof();
    error InvalidRelayAssignment();
    error InvalidResponseAuth();
    error MalformedSigningPayload();
    error RelayJobAlreadyPaid();
    error RequestHashAlreadyPaid();
    error InconsistentPaymentState();
    error RelayOperatorUnavailable();
    error ForceClaimNotAvailable();
    error ForceClaimExpired();
    error EvidenceAlreadyPublished();
    error EvidenceNotAvailable();

    struct ParsedResponseAuth {
        address buyer;
        address seller;
        bytes32 advertisedServiceHash;
        uint16 statusCode;
        bytes32 requestHash;
        bytes32 responseHash;
        uint64 responseStartedAt;
        uint64 responseCompletedAt;
    }

    struct ValidatedRelayClaim {
        uint16 jobIndex;
        address relayBuyer;
        bytes32 requestHash;
    }

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_, address emissionsGate_)
        Ownable(msg.sender)
        EIP712("AntseedVerifierRegistry", "1")
    {
        if (
            registry_ == address(0) || emissionsGate_ == address(0) || registry_.code.length == 0
                || emissionsGate_.code.length == 0
        ) revert InvalidAddress();
        if (address(IAntseedEmissionsGate(emissionsGate_).registry()) != registry_) revert EmissionsGateMismatch();
        registry = IAntseedRegistry(registry_);
        emissionsGate = IAntseedEmissionsGate(emissionsGate_);
    }

    function relayTreasury() external view override returns (address) {
        return _relayTreasury;
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setRelayTreasury(address treasury) external override onlyOwner {
        if (treasury == address(0) || treasury.code.length == 0) revert InvalidAddress();
        if (_relayTreasury != address(0)) revert RelayTreasuryAlreadyConfigured();

        IAntseedRelayTreasury candidate = IAntseedRelayTreasury(treasury);
        if (candidate.verifierRegistry() != address(this)) revert RelayTreasuryMismatch();
        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0) || depositsAddress.code.length == 0) revert InvalidAddress();
        if (address(candidate.usdc()) != IAntseedDeposits(depositsAddress).usdc()) revert RelayTreasuryMismatch();

        _relayTreasury = treasury;
        emit RelayTreasurySet(treasury);
    }

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
    ) external override onlyApprovedVerifier {
        if (_relayTreasury == address(0)) revert RelayTreasuryNotConfigured();
        if (auditId == bytes32(0) || targetCommitment == bytes32(0)) revert InvalidValue();
        if (_audits[auditId].committer != address(0)) revert AuditAlreadyCommitted();
        if (probeRoot == bytes32(0) || auditJobRoot == bytes32(0) || probeCount == 0) revert InvalidValue();
        if (jobCount == 0 || jobCount > MAX_AUDIT_JOBS) revert InvalidJobCount();

        uint256 computedBudget = uint256(payoutPerJobUsdc) * jobCount;
        IAntseedRelayTreasury treasury = IAntseedRelayTreasury(_relayTreasury);
        if (
            payoutPerJobUsdc == 0 || payoutPerJobUsdc > treasury.maxPayoutPerJob()
                || computedBudget > treasury.maxPayoutPerAudit() || computedBudget > type(uint96).max
        ) revert InvalidPayout();

        uint64 committedAt = uint64(block.timestamp);
        (uint256 currentEpoch, uint64 executeBefore) = _currentEpochAndEnd();
        uint256 forceClaimAvailableAt = uint256(executeBefore) + FORCE_CLAIM_DELAY;
        uint256 forceClaimDeadline = forceClaimAvailableAt + FORCE_CLAIM_WINDOW;
        if (forceClaimDeadline > type(uint64).max) revert InvalidAuditWindow();

        treasury.reserveAuditBudget(auditId, currentEpoch, jobCount, payoutPerJobUsdc, uint64(forceClaimDeadline));
        uint256 commitSequence = ++auditCommitSequence;
        uint96 reservedRelayBudgetUsdc = uint96(computedBudget);

        _audits[auditId] = Audit({
            committer: msg.sender,
            targetCommitment: targetCommitment,
            probeRoot: probeRoot,
            auditJobRoot: auditJobRoot,
            referenceId: referenceId,
            verifierConfigHash: verifierConfigHash,
            commitSequence: commitSequence,
            probeCount: probeCount,
            jobCount: jobCount,
            payoutPerJobUsdc: payoutPerJobUsdc,
            reservedRelayBudgetUsdc: reservedRelayBudgetUsdc,
            totalRelayPaidUsdc: 0,
            committedAt: committedAt,
            executeAfter: committedAt,
            executeBefore: executeBefore,
            forceClaimAvailableAt: uint64(forceClaimAvailableAt),
            forceClaimDeadline: uint64(forceClaimDeadline),
            attestedAt: 0,
            attested: false,
            evidenceHash: bytes32(0),
            evidenceUri: ""
        });

        emit AuditCommitted(
            auditId,
            msg.sender,
            commitSequence,
            targetCommitment,
            probeRoot,
            auditJobRoot,
            probeCount,
            jobCount,
            payoutPerJobUsdc,
            reservedRelayBudgetUsdc,
            committedAt,
            executeBefore
        );
    }

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
    ) external override nonReentrant {
        Audit storage audit = _audits[auditId];
        if (audit.committer == address(0)) revert AuditNotFound();
        if (msg.sender != audit.committer) revert NotApprovedVerifier();
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        if (audit.attested) revert AuditAlreadyAttested();
        if (block.timestamp < audit.executeBefore) revert AuditNotReady();
        if (block.timestamp > audit.forceClaimDeadline) revert AttestationExpired();
        if (evidenceHash == bytes32(0)) revert EvidenceNotAvailable();
        if (audit.targetCommitment != hashAuditTarget(agentId, serviceHash, targetSalt)) revert InvalidTargetOpening();

        address seller = _resolveAgentOwner(agentId);
        if (seller == msg.sender) revert SelfAudit();
        if (audit.commitSequence <= lastAcceptedAuditSequence[agentId][serviceHash]) revert StaleAudit();
        _validateAttestation(verdict, modelShareBps);

        uint256 claimCount = relayClaims.length;
        if (claimCount > audit.jobCount || claimCount > MAX_RELAY_CLAIMS) revert TooManyRelayClaims();

        address[] memory recipients = new address[](claimCount);
        uint16[] memory recipientJobCounts = new uint16[](claimCount);
        address[] memory distinctRelays = new address[](claimCount);
        uint256 recipientCount;
        uint256 distinctRelayCount;
        uint256 suppliedJobBitmap;

        for (uint256 i = 0; i < claimCount; i++) {
            ValidatedRelayClaim memory claim =
                _validateRelayClaim(audit, auditId, relayClaims[i], seller, serviceHash, true);
            uint256 jobBit = uint256(1) << claim.jobIndex;
            if (suppliedJobBitmap & jobBit != 0) revert RelayJobAlreadyPaid();
            suppliedJobBitmap |= jobBit;

            bytes32 paymentKey = _paymentKey(auditId, claim.jobIndex);
            bool alreadyPaid = _isRelayJobPaid(auditId, claim.jobIndex);
            bytes32 requestPaymentKey = paidRequestHashes[claim.requestHash];
            if (alreadyPaid) {
                if (requestPaymentKey != paymentKey) revert InconsistentPaymentState();
            } else {
                if (requestPaymentKey != bytes32(0)) revert RequestHashAlreadyPaid();
                paidRequestHashes[claim.requestHash] = paymentKey;
                _markRelayJobPaid(auditId, claim.jobIndex);
                _addRelayPayout(audit);

                address operator = _relayOperator(claim.relayBuyer);
                recipientCount = _addRecipientJob(recipients, recipientJobCounts, recipientCount, operator);
                emit RelayJobPaid(auditId, claim.jobIndex, claim.relayBuyer, operator, audit.payoutPerJobUsdc, false);
            }
            distinctRelayCount = _addDistinctRelay(distinctRelays, distinctRelayCount, claim.relayBuyer);
        }

        _validateRelayDistribution(verdict, audit.jobCount, claimCount, distinctRelayCount);
        lastAcceptedAuditSequence[agentId][serviceHash] = audit.commitSequence;
        _applyAttestationPoints(agentId, serviceHash, verdict, modelShareBps);

        uint64 attestedAt = uint64(block.timestamp);
        Attestation memory attestation = Attestation({
            auditId: auditId,
            verifier: msg.sender,
            agentId: agentId,
            serviceHash: serviceHash,
            verdict: verdict,
            modelShareBps: modelShareBps,
            attestedAt: attestedAt,
            evidenceHash: evidenceHash
        });

        audit.attested = true;
        audit.attestedAt = attestedAt;
        audit.evidenceHash = evidenceHash;
        audit.evidenceUri = evidenceUri;
        _attestations[auditId] = attestation;
        _latestAttestations[agentId][serviceHash] = attestation;

        if (recipientCount != 0) {
            assembly ("memory-safe") {
                mstore(recipients, recipientCount)
                mstore(recipientJobCounts, recipientCount)
            }
            IAntseedRelayTreasury(_relayTreasury).payBatch(auditId, recipients, recipientJobCounts);
        }

        emit AttestationSubmitted(
            auditId,
            msg.sender,
            agentId,
            serviceHash,
            verdict,
            modelShareBps,
            evidenceHash,
            claimCount,
            audit.totalRelayPaidUsdc
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

    function forceClaimRelayJob(bytes32 auditId, RelayClaim calldata relayClaim) external override nonReentrant {
        Audit storage audit = _audits[auditId];
        if (audit.committer == address(0)) revert AuditNotFound();
        if (block.timestamp <= audit.forceClaimAvailableAt) revert ForceClaimNotAvailable();
        if (block.timestamp > audit.forceClaimDeadline) revert ForceClaimExpired();

        ValidatedRelayClaim memory claim =
            _validateRelayClaim(audit, auditId, relayClaim, address(0), bytes32(0), false);
        if (_isRelayJobPaid(auditId, claim.jobIndex)) revert RelayJobAlreadyPaid();
        if (paidRequestHashes[claim.requestHash] != bytes32(0)) revert RequestHashAlreadyPaid();

        paidRequestHashes[claim.requestHash] = _paymentKey(auditId, claim.jobIndex);
        _markRelayJobPaid(auditId, claim.jobIndex);
        _addRelayPayout(audit);

        address operator = _relayOperator(claim.relayBuyer);
        IAntseedRelayTreasury(_relayTreasury).payJob(auditId, operator);
        emit RelayJobPaid(auditId, claim.jobIndex, claim.relayBuyer, operator, audit.payoutPerJobUsdc, true);
    }

    function publishEvidence(bytes32 auditId, string calldata evidenceUri) external override {
        Audit storage audit = _audits[auditId];
        if (audit.committer == address(0)) revert AuditNotFound();
        if (msg.sender != audit.committer) revert NotApprovedVerifier();
        if (!audit.attested || audit.evidenceHash == bytes32(0)) revert EvidenceNotAvailable();
        if (bytes(audit.evidenceUri).length != 0) revert EvidenceAlreadyPublished();
        if (bytes(evidenceUri).length == 0) revert InvalidValue();
        audit.evidenceUri = evidenceUri;
        emit EvidencePublished(auditId, evidenceUri);
    }

    function getAudit(bytes32 auditId) external view override returns (Audit memory) {
        return _audits[auditId];
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

    function agentPointsPenaltyBps(uint256 agentId) external view override returns (uint16) {
        uint256 penaltyBps = _agentPointsPenaltyBps[agentId];
        if (penaltyBps > BPS_DENOMINATOR) penaltyBps = BPS_DENOMINATOR;
        return uint16(penaltyBps);
    }

    function hashAuditTarget(uint256 agentId, bytes32 serviceHash, bytes32 targetSalt)
        public
        view
        override
        returns (bytes32)
    {
        return keccak256(
            abi.encode("antseed-audit-target-v0", block.chainid, address(this), agentId, serviceHash, targetSalt)
        );
    }

    function hashAuditJob(AuditJob memory job) public view override returns (bytes32) {
        return keccak256(
            abi.encode(
                "antseed-audit-job-v1",
                block.chainid,
                address(this),
                job.auditId,
                job.jobIndex,
                job.sellerPeerId,
                job.serviceHash,
                job.requestHash,
                job.jobSalt,
                job.executeAfter,
                job.executeBefore
            )
        );
    }

    function hashRelayAssignment(RelayAssignment memory assignment) public view override returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RELAY_ASSIGNMENT_TYPEHASH,
                    assignment.auditId,
                    assignment.jobIndex,
                    assignment.attempt,
                    assignment.relayBuyer,
                    assignment.payoutPerJobUsdc,
                    assignment.executeAfter,
                    assignment.executeBefore
                )
            )
        );
    }

    function verifyAuditJobProof(bytes32 root, bytes32 leaf, uint16 jobIndex, uint16 jobCount, bytes32[] calldata proof)
        public
        pure
        override
        returns (bool)
    {
        if (root == bytes32(0) || leaf == bytes32(0) || jobCount == 0 || jobCount > MAX_AUDIT_JOBS) return false;
        if (jobIndex >= jobCount) return false;

        uint256 capacity = 1;
        uint256 depth;
        while (capacity < jobCount) {
            capacity <<= 1;
            depth++;
        }
        if (capacity > 128 || proof.length != depth) return false;

        bytes32 computed = leaf;
        uint256 index = jobIndex;
        for (uint256 i = 0; i < proof.length; i++) {
            computed = index & 1 == 0 ? _hashNode(computed, proof[i]) : _hashNode(proof[i], computed);
            index >>= 1;
        }
        return computed == root;
    }

    function hashNormalizedService(string calldata advertisedService) external pure override returns (bytes32) {
        return _normalizedServiceHashMemory(bytes(advertisedService));
    }

    function responseAuthDigest(bytes calldata signingPayload) external pure override returns (bytes32) {
        return _responseAuthDigest(signingPayload);
    }

    function parseResponseAuthPayload(bytes calldata payload)
        external
        pure
        override
        returns (
            address buyer,
            address seller,
            bytes32 advertisedServiceHash,
            uint16 statusCode,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        )
    {
        ParsedResponseAuth memory auth = _parseResponseAuthPayload(payload);
        return (
            auth.buyer,
            auth.seller,
            auth.advertisedServiceHash,
            auth.statusCode,
            auth.requestHash,
            auth.responseHash,
            auth.responseStartedAt,
            auth.responseCompletedAt
        );
    }

    function isRelayJobPaid(bytes32 auditId, uint16 jobIndex) external view override returns (bool) {
        return _isRelayJobPaid(auditId, jobIndex);
    }

    function requiredRelayCount(uint16 jobCount) public pure override returns (uint16) {
        if (jobCount == 0) return 0;
        uint16 required = uint16((uint256(jobCount) + 4) / 5);
        if (required < 3) required = 3;
        if (required > 10) required = 10;
        return required > jobCount ? jobCount : required;
    }

    function _validateRelayClaim(
        Audit storage audit,
        bytes32 auditId,
        RelayClaim calldata relayClaim,
        address expectedSeller,
        bytes32 expectedServiceHash,
        bool enforceTarget
    ) internal view returns (ValidatedRelayClaim memory claim) {
        AuditJob calldata job = relayClaim.job;
        _validateAuditJob(audit, auditId, job);
        if (
            !verifyAuditJobProof(
                audit.auditJobRoot, hashAuditJob(job), job.jobIndex, audit.jobCount, relayClaim.jobProof
            )
        ) {
            revert InvalidJobProof();
        }

        RelayAssignment calldata assignment = relayClaim.assignment;
        if (
            assignment.auditId != auditId || assignment.jobIndex != job.jobIndex
                || assignment.attempt >= MAX_RELAY_ATTEMPTS || assignment.relayBuyer == address(0)
                || assignment.payoutPerJobUsdc != audit.payoutPerJobUsdc
                || assignment.executeBefore <= assignment.executeAfter
                || assignment.executeAfter < job.executeAfter || assignment.executeBefore > job.executeBefore
        ) revert InvalidRelayAssignment();
        (address assignmentSigner, ECDSA.RecoverError assignmentError,) =
            ECDSA.tryRecover(hashRelayAssignment(assignment), relayClaim.verifierSignature);
        if (assignmentError != ECDSA.RecoverError.NoError || assignmentSigner != audit.committer) {
            revert InvalidRelayAssignment();
        }

        bytes calldata responseAuthPayload = relayClaim.responseAuthPayload;
        if (responseAuthPayload.length <= RESPONSE_AUTH_SIGNATURE_LENGTH) revert InvalidResponseAuth();
        uint256 signingPayloadLength = responseAuthPayload.length - RESPONSE_AUTH_SIGNATURE_LENGTH;
        bytes calldata signingPayload = responseAuthPayload[:signingPayloadLength];
        bytes calldata responseSignature = responseAuthPayload[signingPayloadLength:];

        ParsedResponseAuth memory auth = _parseResponseAuthPayload(signingPayload);
        (address responseSigner, ECDSA.RecoverError responseError,) =
            ECDSA.tryRecover(_responseAuthDigest(signingPayload), responseSignature);
        if (responseError != ECDSA.RecoverError.NoError || responseSigner != job.sellerPeerId) {
            revert InvalidResponseAuth();
        }
        if (
            auth.buyer != assignment.relayBuyer || auth.seller != job.sellerPeerId
                || auth.advertisedServiceHash != job.serviceHash || auth.statusCode != 200
                || auth.requestHash != job.requestHash || auth.responseHash == bytes32(0)
                || auth.responseCompletedAt < auth.responseStartedAt
                || uint256(auth.responseStartedAt) < uint256(assignment.executeAfter) * 1000
                || uint256(auth.responseCompletedAt) > uint256(assignment.executeBefore) * 1000
        ) revert InvalidResponseAuth();

        if (enforceTarget && (job.sellerPeerId != expectedSeller || job.serviceHash != expectedServiceHash)) {
            revert InvalidJob();
        }
        claim = ValidatedRelayClaim({
            jobIndex: job.jobIndex,
            relayBuyer: assignment.relayBuyer,
            requestHash: job.requestHash
        });
    }

    function _validateAuditJob(Audit storage audit, bytes32 auditId, AuditJob calldata job) internal view {
        if (
            job.auditId == bytes32(0) || job.auditId != auditId || job.jobIndex >= audit.jobCount
                || job.sellerPeerId == address(0) || job.serviceHash == bytes32(0) || job.requestHash == bytes32(0)
                || job.jobSalt == bytes32(0) || job.executeBefore <= job.executeAfter || job.executeAfter < audit.executeAfter
                || job.executeBefore > audit.executeBefore
        ) revert InvalidJob();
    }

    function _validateAttestation(Verdict verdict, uint16 modelShareBps) internal pure {
        if (verdict == Verdict.UNKNOWN) revert InvalidVerdict();
        if (verdict == Verdict.DIFF) {
            if (modelShareBps > BPS_DENOMINATOR) revert InvalidModelShareBps();
        } else if (modelShareBps != 0) {
            revert InvalidModelShareBps();
        }
    }

    function _validateRelayDistribution(
        Verdict verdict,
        uint16 jobCount,
        uint256 claimCount,
        uint256 distinctRelayCount
    ) internal pure {
        if (verdict != Verdict.SAME && verdict != Verdict.DIFF) return;
        if (claimCount * 2 < jobCount) revert InsufficientRelayCoverage();
        if (distinctRelayCount < requiredRelayCount(jobCount)) revert InsufficientRelayDiversity();
    }

    function _applyAttestationPoints(uint256 agentId, bytes32 serviceHash, Verdict verdict, uint16 modelShareBps)
        internal
    {
        if (verdict == Verdict.DIFF) {
            _setServicePointsPenalty(agentId, serviceHash, modelShareBps);
        } else if (verdict == Verdict.SAME) {
            _clearServicePointsPenalty(agentId, serviceHash);
        }
    }

    function _setServicePointsPenalty(uint256 agentId, bytes32 serviceHash, uint16 modelShareBps) internal {
        bytes32 key = _serviceKey(agentId, serviceHash);
        uint16 oldPenaltyBps = _servicePointsPenaltyBps[key];
        _servicePointsPenaltyBps[key] = modelShareBps;
        _agentPointsPenaltyBps[agentId] = _agentPointsPenaltyBps[agentId] - oldPenaltyBps + modelShareBps;
        emit ServicePointsPenaltySet(agentId, serviceHash, modelShareBps);
    }

    function _clearServicePointsPenalty(uint256 agentId, bytes32 serviceHash) internal {
        bytes32 key = _serviceKey(agentId, serviceHash);
        uint16 penaltyBps = _servicePointsPenaltyBps[key];
        if (penaltyBps == 0) return;
        delete _servicePointsPenaltyBps[key];
        _agentPointsPenaltyBps[agentId] -= penaltyBps;
        emit ServicePointsPenaltySet(agentId, serviceHash, 0);
    }

    function _addRelayPayout(Audit storage audit) internal {
        uint96 newTotal = audit.totalRelayPaidUsdc + audit.payoutPerJobUsdc;
        if (newTotal > audit.reservedRelayBudgetUsdc) revert InvalidPayout();
        audit.totalRelayPaidUsdc = newTotal;
    }

    function _addRecipientJob(
        address[] memory recipients,
        uint16[] memory jobCounts,
        uint256 recipientCount,
        address recipient
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < recipientCount; i++) {
            if (recipients[i] == recipient) {
                jobCounts[i]++;
                return recipientCount;
            }
        }
        recipients[recipientCount] = recipient;
        jobCounts[recipientCount] = 1;
        return recipientCount + 1;
    }

    function _addDistinctRelay(address[] memory relays, uint256 relayCount, address relay)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < relayCount; i++) {
            if (relays[i] == relay) return relayCount;
        }
        relays[relayCount] = relay;
        return relayCount + 1;
    }

    function _relayOperator(address relayBuyer) internal view returns (address operator) {
        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0) || depositsAddress.code.length == 0) revert RelayOperatorUnavailable();
        operator = IAntseedDeposits(depositsAddress).getOperator(relayBuyer);
        if (operator == address(0)) revert RelayOperatorUnavailable();
    }

    function _resolveAgentOwner(uint256 agentId) internal view returns (address agentOwner) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
        }
    }

    function _currentEpochAndEnd() internal view returns (uint256 epoch, uint64 epochEnd) {
        uint256 duration = emissionsGate.EPOCH_DURATION();
        if (duration == 0) revert InvalidAuditWindow();
        epoch = emissionsGate.currentEpoch();
        uint256 end = emissionsGate.GENESIS() + (epoch + 1) * duration;
        if (end <= block.timestamp || end > type(uint64).max) revert InvalidAuditWindow();
        return (epoch, uint64(end));
    }

    function _isRelayJobPaid(bytes32 auditId, uint16 jobIndex) internal view returns (bool) {
        return relayJobPaidBitmap[auditId] & (uint256(1) << jobIndex) != 0;
    }

    function _markRelayJobPaid(bytes32 auditId, uint16 jobIndex) internal {
        relayJobPaidBitmap[auditId] |= uint256(1) << jobIndex;
    }

    function _paymentKey(bytes32 auditId, uint16 jobIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(auditId, jobIndex));
    }

    function _hashNode(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), left, right));
    }

    function _serviceKey(uint256 agentId, bytes32 serviceHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(agentId, serviceHash));
    }

    function _responseAuthDigest(bytes calldata signingPayload) internal pure returns (bytes32) {
        bytes memory lengthDecimal = bytes(Strings.toString(DATA_DOMAIN.length + signingPayload.length));
        return keccak256(bytes.concat("\x19Ethereum Signed Message:\n", lengthDecimal, DATA_DOMAIN, signingPayload));
    }

    function _parseResponseAuthPayload(bytes calldata payload) internal pure returns (ParsedResponseAuth memory auth) {
        uint256 offset;
        for (uint256 fieldIndex = 0; fieldIndex < RESPONSE_AUTH_FIELD_COUNT; fieldIndex++) {
            if (offset + 4 > payload.length) revert MalformedSigningPayload();
            uint256 fieldLength;
            assembly ("memory-safe") {
                fieldLength := shr(224, calldataload(add(payload.offset, offset)))
            }
            offset += 4;
            if (payload.length - offset < fieldLength) revert MalformedSigningPayload();
            bytes calldata field = payload[offset:offset + fieldLength];
            offset += fieldLength;

            if (fieldIndex == 0) {
                if (keccak256(field) != RESPONSE_AUTH_DOMAIN_HASH) revert MalformedSigningPayload();
            } else if (fieldIndex == 1) {
                if (keccak256(field) != RESPONSE_AUTH_VERSION_HASH) revert MalformedSigningPayload();
            } else if (fieldIndex == 4) {
                auth.buyer = address(uint160(_parseHex(field, 40)));
            } else if (fieldIndex == 5) {
                auth.seller = address(uint160(_parseHex(field, 40)));
            } else if (fieldIndex == 6) {
                auth.advertisedServiceHash = _normalizedServiceHash(field);
            } else if (fieldIndex == 8) {
                uint64 statusCode = _parseUint64(field);
                if (statusCode > type(uint16).max) revert MalformedSigningPayload();
                auth.statusCode = uint16(statusCode);
            } else if (fieldIndex == 9) {
                auth.requestHash = bytes32(_parseHex(field, 64));
            } else if (fieldIndex == 10) {
                auth.responseHash = bytes32(_parseHex(field, 64));
            } else if (fieldIndex == 11) {
                auth.responseStartedAt = _parseUint64(field);
            } else if (fieldIndex == 12) {
                auth.responseCompletedAt = _parseUint64(field);
            }
        }
        if (offset != payload.length) revert MalformedSigningPayload();
    }

    function _normalizedServiceHashMemory(bytes memory field) internal pure returns (bytes32) {
        uint256 start;
        uint256 end = field.length;
        while (start < end && _isAsciiWhitespace(uint8(field[start]))) start++;
        while (end > start && _isAsciiWhitespace(uint8(field[end - 1]))) end--;
        if (start == end) revert MalformedSigningPayload();

        bytes memory normalized = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            uint8 character = uint8(field[i]);
            if (character >= 0x41 && character <= 0x5A) character += 0x20;
            normalized[i - start] = bytes1(character);
        }
        return keccak256(normalized);
    }

    function _normalizedServiceHash(bytes calldata field) internal pure returns (bytes32) {
        uint256 start;
        uint256 end = field.length;
        while (start < end && _isAsciiWhitespace(uint8(field[start]))) start++;
        while (end > start && _isAsciiWhitespace(uint8(field[end - 1]))) end--;
        if (start == end) revert MalformedSigningPayload();

        bytes memory normalized = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            uint8 character = uint8(field[i]);
            if (character >= 0x41 && character <= 0x5A) character += 0x20;
            normalized[i - start] = bytes1(character);
        }
        return keccak256(normalized);
    }

    function _isAsciiWhitespace(uint8 character) internal pure returns (bool) {
        return character == 0x20 || (character >= 0x09 && character <= 0x0D);
    }

    function _parseUint64(bytes calldata field) internal pure returns (uint64 value) {
        if (field.length == 0 || field.length > 20) revert MalformedSigningPayload();
        uint256 parsed;
        for (uint256 i = 0; i < field.length; i++) {
            uint8 character = uint8(field[i]);
            if (character < 0x30 || character > 0x39) revert MalformedSigningPayload();
            parsed = parsed * 10 + character - 0x30;
        }
        if (parsed > type(uint64).max) revert MalformedSigningPayload();
        return uint64(parsed);
    }

    function _parseHex(bytes calldata field, uint256 expectedNibbles) internal pure returns (uint256 value) {
        uint256 start;
        if (field.length >= 2 && field[0] == "0" && field[1] == "x") start = 2;
        if (field.length - start != expectedNibbles) revert MalformedSigningPayload();

        for (uint256 i = start; i < field.length; i++) {
            uint8 character = uint8(field[i]);
            uint8 nibble;
            if (character >= 0x30 && character <= 0x39) {
                nibble = character - 0x30;
            } else if (character >= 0x61 && character <= 0x66) {
                nibble = character - 0x57;
            } else if (character >= 0x41 && character <= 0x46) {
                nibble = character - 0x37;
            } else {
                revert MalformedSigningPayload();
            }
            value = (value << 4) | nibble;
        }
    }
}
