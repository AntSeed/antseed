// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/**
 * @title AntseedVerifierRegistry
 * @notice Whitelisted verifier registry and on-chain attestation log.
 *
 *         Approved verifier peers probe sellers as buyers and attest whether
 *         each seller truthfully serves the model it advertises. Every audit
 *         is bound to a pre-published probe-set commitment (commit-reveal) so
 *         a verifier cannot fabricate probe results after seeing responses.
 *
 *         Attestations earn per-epoch credits used by AntseedVerifierRewards
 *         to split the emissions verification bucket pro-rata. Crediting is
 *         rate-limited two ways:
 *           - per audited (agentId, serviceHash): at most one credit per
 *             `auditCooldown`, shared across all verifiers, so re-auditing
 *             the same service cannot be farmed;
 *           - per verifier: at most `maxCreditsPerVerifierPerEpoch` credits
 *             per epoch.
 *
 *         The epoch clock is resolved through `registry.emissions()`, which
 *         post-cutover points at AntseedUsageAccounting — the same clock the
 *         emissions gate runs on.
 */
contract AntseedVerifierRegistry is IAntseedVerifierRegistry, Ownable2Step {
    // ─── Constants ───────────────────────────────────────────────────
    /// @dev Upper bound on the audit cooldown so a misconfigured value can
    ///      never block crediting for unreasonably long.
    uint64 public constant MAX_AUDIT_COOLDOWN = 30 days;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedRegistry public immutable registry;

    // ─── Verifier Whitelist & Config ─────────────────────────────────
    mapping(address => bool) public approvedVerifiers;
    uint64 public auditCooldown = 1 days;
    uint32 public maxCreditsPerVerifierPerEpoch = 100;
    uint32 public minProbeCount = 10;

    // ─── Attestation State ───────────────────────────────────────────
    mapping(address verifier => mapping(bytes32 commitment => uint64 committedAt)) public probeCommittedAt;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint64 auditedAt)) public lastAuditedAt;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint64 creditedAt)) public lastCreditedAt;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => Attestation attestation)) private _latestAttestations;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceVerificationStats stats)) private
        _verificationStats;
    mapping(uint256 => mapping(bytes32 => mapping(address => bool))) private _hasAttested;
    mapping(uint256 => ServiceVerificationStats) private _agentStats;
    mapping(uint256 => mapping(address => bool)) private _hasAttestedAgent;
    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public epochCredits;
    mapping(uint256 epoch => uint256 credits) public epochTotalCredits;

    // ─── Events ──────────────────────────────────────────────────────
    event VerifierApprovalSet(address indexed verifier, bool approved);
    event AuditCooldownSet(uint64 auditCooldown);
    event MaxCreditsPerVerifierPerEpochSet(uint32 maxCreditsPerVerifierPerEpoch);
    event MinProbeCountSet(uint32 minProbeCount);
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

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error ProbeCountTooLow();
    error CommitmentAlreadySet();
    error ProbeSetNotCommitted();
    error ProbeSetTooRecent();
    error UnknownAgent();
    error SelfAudit();

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OWNER CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════

    function setVerifier(address verifier, bool approved) external onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setAuditCooldown(uint64 _auditCooldown) external onlyOwner {
        if (_auditCooldown > MAX_AUDIT_COOLDOWN) revert InvalidValue();
        auditCooldown = _auditCooldown;
        emit AuditCooldownSet(_auditCooldown);
    }

    function setMaxCreditsPerVerifierPerEpoch(uint32 _maxCreditsPerVerifierPerEpoch) external onlyOwner {
        if (_maxCreditsPerVerifierPerEpoch == 0) revert InvalidValue();
        maxCreditsPerVerifierPerEpoch = _maxCreditsPerVerifierPerEpoch;
        emit MaxCreditsPerVerifierPerEpochSet(_maxCreditsPerVerifierPerEpoch);
    }

    function setMinProbeCount(uint32 _minProbeCount) external onlyOwner {
        if (_minProbeCount == 0) revert InvalidValue();
        minProbeCount = _minProbeCount;
        emit MinProbeCountSet(_minProbeCount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — COMMIT / ATTEST
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Publish a commitment to a probe set before running it. The
    ///         attestation must reference a commitment recorded in a strictly
    ///         earlier second, so probe results cannot be fabricated after
    ///         the fact and committed in the same transaction.
    function commitProbeSet(bytes32 commitment) external onlyApprovedVerifier {
        if (commitment == bytes32(0)) revert InvalidValue();
        if (probeCommittedAt[msg.sender][commitment] != 0) revert CommitmentAlreadySet();
        probeCommittedAt[msg.sender][commitment] = uint64(block.timestamp);
        emit ProbeSetCommitted(msg.sender, commitment);
    }

    /// @notice Record an audit verdict for `(agentId, serviceHash)`. The
    ///         attestation is credited toward the verifier's epoch reward
    ///         share only when the per-service cooldown has elapsed and the
    ///         verifier is below its per-epoch credit cap; the attestation
    ///         itself is stored either way.
    function submitAttestation(
        uint256 agentId,
        bytes32 serviceHash,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        uint32 probeCount,
        uint32 cohortSize
    ) external onlyApprovedVerifier {
        if (agentId == 0 || serviceHash == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidValue();
        // UNKNOWN (0) is a placeholder, not an attestable verdict.
        if (verdict == uint8(Verdict.UNKNOWN) || verdict > uint8(Verdict.UNDETERMINED)) revert InvalidVerdict();
        if (probeCount < minProbeCount) revert ProbeCountTooLow();

        uint64 committedAt = probeCommittedAt[msg.sender][probeCommitment];
        if (committedAt == 0) revert ProbeSetNotCommitted();
        if (committedAt >= block.timestamp) revert ProbeSetTooRecent();

        _checkAuditedAgent(agentId);

        uint64 nowTs = uint64(block.timestamp);
        uint256 epoch = currentEpoch();

        _latestAttestations[agentId][serviceHash] = Attestation({
            verifier: msg.sender,
            attestedAt: nowTs,
            verdict: verdict,
            probeCount: probeCount,
            cohortSize: cohortSize,
            evidenceHash: evidenceHash,
            probeCommitment: probeCommitment
        });
        lastAuditedAt[agentId][serviceHash] = nowTs;

        ServiceVerificationStats storage stats = _verificationStats[agentId][serviceHash];
        if (verdict == uint8(Verdict.SAME)) stats.sameCount++;
        else if (verdict == uint8(Verdict.DIFF)) stats.diffCount++;
        else stats.undeterminedCount++;
        stats.lastVerdict = verdict;
        stats.lastVerifier = msg.sender;
        if (!_hasAttested[agentId][serviceHash][msg.sender]) {
            _hasAttested[agentId][serviceHash][msg.sender] = true;
            stats.distinctVerifierCount++;
        }

        ServiceVerificationStats storage agentStats = _agentStats[agentId];
        if (verdict == uint8(Verdict.SAME)) agentStats.sameCount++;
        else if (verdict == uint8(Verdict.DIFF)) agentStats.diffCount++;
        else agentStats.undeterminedCount++;
        agentStats.lastVerdict = verdict;
        agentStats.lastVerifier = msg.sender;
        if (!_hasAttestedAgent[agentId][msg.sender]) {
            _hasAttestedAgent[agentId][msg.sender] = true;
            agentStats.distinctVerifierCount++;
        }

        bool credited = nowTs - lastCreditedAt[agentId][serviceHash] >= auditCooldown
            && epochCredits[epoch][msg.sender] < maxCreditsPerVerifierPerEpoch;
        if (credited) {
            lastCreditedAt[agentId][serviceHash] = nowTs;
            epochCredits[epoch][msg.sender]++;
            epochTotalCredits[epoch]++;
        }

        emit AttestationSubmitted(
            agentId, serviceHash, msg.sender, verdict, evidenceHash, probeCommitment, probeCount, cohortSize, credited, epoch
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (Attestation memory) {
        return _latestAttestations[agentId][serviceHash];
    }

    /// @notice Reputation accumulators for `(agentId, serviceHash)`. The
    ///         stats timestamp is `lastAuditedAt[agentId][serviceHash]`.
    function verificationStats(uint256 agentId, bytes32 serviceHash)
        external
        view
        returns (ServiceVerificationStats memory)
    {
        return _verificationStats[agentId][serviceHash];
    }

    /// @notice Reputation accumulators aggregated across all services of
    ///         `agentId`, maintained incrementally on every attestation.
    ///         `distinctVerifierCount` counts each verifier once per agent
    ///         regardless of how many of its services it audited.
    function agentVerificationStats(uint256 agentId) external view returns (ServiceVerificationStats memory) {
        return _agentStats[agentId];
    }

    /// @notice Emission epoch clock, resolved through `registry.emissions()`
    ///         (AntseedUsageAccounting post-cutover) so verifier credits land
    ///         in the same epochs the emissions gate finalizes.
    function currentEpoch() public view returns (uint256) {
        return IAntseedUsageAccounting(registry.emissions()).currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev The audited agent must exist in the ERC-8004 identity registry,
    ///      and a verifier may never audit its own agent. `ownerOf` reverts
    ///      for unknown ids on the deployed registry; the explicit code-size
    ///      check keeps a missing/unset registry from decoding as success.
    function _checkAuditedAgent(uint256 agentId) internal view {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address agentOwner) {
            if (agentOwner == address(0)) revert UnknownAgent();
            if (agentOwner == msg.sender) revert SelfAudit();
        } catch {
            revert UnknownAgent();
        }
    }
}
