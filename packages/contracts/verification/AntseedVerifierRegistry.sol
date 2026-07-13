// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
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
contract AntseedVerifierRegistry is IAntseedVerifierRegistry, Ownable2Step, EIP712 {
    // ─── Constants ───────────────────────────────────────────────────
    /// @dev Upper bound on the audit cooldown so a misconfigured value can
    ///      never block crediting for unreasonably long.
    uint64 public constant MAX_AUDIT_COOLDOWN = 30 days;
    /// @dev EIP-712 type of the voucher a verifier signs off-chain for each
    ///      delegate buyer that carried its probe traffic.
    bytes32 public constant DELEGATE_VOUCHER_TYPEHASH = keccak256(
        "DelegateVoucher(address buyer,bytes32 probeCommitment,uint32 credits,uint256 nonce,uint256 deadline)"
    );

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
    /// @dev Each verifier's latest verdict per (agentId, serviceHash)
    ///      (0 = never attested). Drives `activeDiffVerifierCount`: a DIFF
    ///      raises it once per verifier, and the same verifier's later
    ///      SAME/UNDETERMINED on the SAME service lowers it — a standing,
    ///      retractable accusation rather than a permanent historical mark.
    mapping(uint256 => mapping(bytes32 => mapping(address => uint8))) private _lastVerdictByVerifier;
    /// @dev Services of `agentId` on which `verifier` currently stands at
    ///      DIFF. The agent-level `activeDiffVerifierCount` counts verifiers
    ///      with a standing DIFF on ANY service — a SAME on an honestly
    ///      served service must never launder a standing DIFF on the
    ///      substituted one.
    mapping(uint256 => mapping(address => uint32)) private _verifierDiffServiceCount;
    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public epochCredits;
    mapping(uint256 epoch => uint256 credits) public epochTotalCredits;

    // ─── Delegate Crediting ──────────────────────────────────────────
    // Probe execution is delegated to organic buyer peers so probe traffic
    // is indistinguishable from real usage (the verifier whitelist is
    // public, so verifier-originated traffic is linkable and a cheating
    // seller could serve the real model only to verifiers). A verifier
    // signs an off-chain EIP-712 DelegateVoucher for each buyer that
    // carried its probes; the buyer's OPERATOR claims it here and later
    // collects the delegate share of the verification emissions bucket via
    // AntseedVerifierRewards.
    //
    // The voucher names the buyer (the peer identity the verifier actually
    // talked to); this contract resolves and pays its deposits operator at
    // claim time, so the iron rule holds — the buyer hot wallet never
    // receives funds — and the "is this a real, operator-bound buyer"
    // check is enforced on-chain rather than promised off-chain.
    //
    // Grants are anchored to audit work: every CREDITED attestation adds
    // its probeCount to the referenced commitment's delegate budget, and
    // cumulative voucher claims against a commitment may never exceed that
    // budget. Since credited attestations are themselves rate-limited
    // (per-service cooldown + per-verifier epoch cap), a verifier cannot
    // farm the delegate pool without doing real, commit-reveal audit work.

    /// @notice Share of the verification bucket reserved for delegates, in
    ///         bps of the epoch budget. Applied by AntseedVerifierRewards
    ///         only for epochs that have delegate credits.
    uint16 public delegateShareBps = 2000;
    /// @notice Cap on delegate credits a single verifier may grant per epoch.
    uint32 public maxDelegateCreditsPerVerifierPerEpoch = 200;

    mapping(uint256 epoch => mapping(address delegate => uint256 credits)) public epochDelegateCredits;
    mapping(uint256 epoch => uint256 credits) public epochTotalDelegateCredits;
    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public epochDelegateCreditsGrantedBy;
    /// @notice EIP-712 voucher digests already claimed, keyed by the
    ///         recovered signing verifier (replay protection). The digest
    ///         itself does not bind the signer — two approved verifiers
    ///         signing identical voucher fields produce ONE digest — so a
    ///         signer-keyed guard is required to keep the first claim from
    ///         permanently consuming the other verifier's voucher.
    mapping(address verifier => mapping(bytes32 digest => bool claimed)) public voucherClaimed;
    /// @notice Delegate-credit budget per (verifier, probeCommitment): the
    ///         sum of probeCount over the verifier's CREDITED attestations
    ///         that referenced the commitment.
    mapping(address verifier => mapping(bytes32 commitment => uint256 budget)) public commitmentDelegateBudget;
    /// @notice Voucher credits already claimed against (verifier, commitment).
    mapping(address verifier => mapping(bytes32 commitment => uint256 granted)) public commitmentDelegateCredits;

    // ─── Events ──────────────────────────────────────────────────────
    event VerifierApprovalSet(address indexed verifier, bool approved);
    event AuditCooldownSet(uint64 auditCooldown);
    event MaxCreditsPerVerifierPerEpochSet(uint32 maxCreditsPerVerifierPerEpoch);
    event MinProbeCountSet(uint32 minProbeCount);
    event ProbeSetCommitted(address indexed verifier, bytes32 indexed commitment);
    event DelegateShareBpsSet(uint16 delegateShareBps);
    event MaxDelegateCreditsPerVerifierPerEpochSet(uint32 maxDelegateCreditsPerVerifierPerEpoch);
    event DelegateCredited(uint256 indexed epoch, address indexed verifier, address indexed delegate, uint32 credits);
    event VerifierStandingCleared(address indexed verifier, uint256 indexed agentId, bytes32 indexed serviceHash);
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
    error SelfDelegate();
    error DelegateCreditCapExceeded();
    error VoucherExpired();
    error VoucherAlreadyClaimed();
    error NotBuyerOperator();
    error CommitmentBudgetExceeded();
    error NoStandingDiff();

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry) Ownable(msg.sender) EIP712("AntseedVerifierRegistry", "1") {
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

    function setDelegateShareBps(uint16 _delegateShareBps) external onlyOwner {
        if (_delegateShareBps > 10_000) revert InvalidValue();
        delegateShareBps = _delegateShareBps;
        emit DelegateShareBpsSet(_delegateShareBps);
    }

    function setMaxDelegateCreditsPerVerifierPerEpoch(uint32 _max) external onlyOwner {
        if (_max == 0) revert InvalidValue();
        maxDelegateCreditsPerVerifierPerEpoch = _max;
        emit MaxDelegateCreditsPerVerifierPerEpochSet(_max);
    }

    /// @notice Retract `verifier`'s standing DIFF on `(agentId, serviceHash)`
    ///         exactly as the verifier's own SAME/UNDETERMINED re-attestation
    ///         would: both `activeDiffVerifierCount` accumulators drop via
    ///         the shared `_updateActiveDiff` bookkeeping, and the verifier's
    ///         stored verdict on the key resets to 0 ("never attested" — no
    ///         fabricated SAME). Historical counters, the stored latest
    ///         attestation and epoch credits are untouched, and nothing is
    ///         credited.
    ///
    ///         Remediation tool for rogue-verifier damage: a verifier removed
    ///         from the whitelist can no longer attest, so its standing DIFF
    ///         accusations — and the points-policy penalty they drive — would
    ///         otherwise stand forever. Reverts with `NoStandingDiff` when
    ///         the verifier holds no standing DIFF on the key, so a mistyped
    ///         key fails loudly instead of emitting a misleading event.
    function clearVerifierStanding(address verifier, uint256 agentId, bytes32 serviceHash) external onlyOwner {
        if (_lastVerdictByVerifier[agentId][serviceHash][verifier] != uint8(Verdict.DIFF)) revert NoStandingDiff();
        _updateActiveDiff(
            agentId,
            serviceHash,
            verifier,
            uint8(Verdict.UNKNOWN),
            _verificationStats[agentId][serviceHash],
            _agentStats[agentId]
        );
        emit VerifierStandingCleared(verifier, agentId, serviceHash);
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
    ///
    ///         TRUST MODEL — whitelist, not proof. On-chain, credited audit
    ///         work requires neither a real relationship with the audited
    ///         seller nor evidence that any probing happened: the probe-set
    ///         commitment is an opaque hash unbound to the audited target,
    ///         is never revealed or consumed on-chain, and only needs to be
    ///         one second old; `evidenceHash` is likewise just a pointer to
    ///         off-chain material. This is by design — verifiers are
    ///         owner-whitelisted and their evidence is reviewed off-chain,
    ///         with the whitelist as the enforcement lever. Integrators MUST
    ///         NOT treat epoch credits or stored attestations as
    ///         cryptographic proof of audit work.
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

        _updateActiveDiff(agentId, serviceHash, msg.sender, verdict, stats, agentStats);

        bool credited = nowTs - lastCreditedAt[agentId][serviceHash] >= auditCooldown
            && epochCredits[epoch][msg.sender] < maxCreditsPerVerifierPerEpoch;
        if (credited) {
            lastCreditedAt[agentId][serviceHash] = nowTs;
            epochCredits[epoch][msg.sender]++;
            epochTotalCredits[epoch]++;
            // Credited audit work backs delegate vouchers: cumulative voucher
            // claims against this commitment are capped by the probes it
            // attested to. Only CREDITED attestations grow the budget —
            // uncredited re-attestations are unlimited and would otherwise
            // let a verifier mint voucher budget for free.
            commitmentDelegateBudget[msg.sender][probeCommitment] += probeCount;
        }

        emit AttestationSubmitted(
            agentId, serviceHash, msg.sender, verdict, evidenceHash, probeCommitment, probeCount, cohortSize, credited, epoch
        );
    }

    /// @notice Claim a verifier-signed DelegateVoucher for probe traffic the
    ///         buyer carried. Callable only by the buyer's deposits operator;
    ///         credits land in the CURRENT epoch, keyed by that operator, and
    ///         drive the delegate share of the verification bucket in
    ///         AntseedVerifierRewards.
    ///
    ///         Enforced here rather than trusted off-chain:
    ///           - the signer is a whitelisted verifier;
    ///           - the caller is the operator registered for `voucher.buyer`
    ///             in AntseedDeposits (a buyer without a funded, operator-
    ///             bound deposit account cannot be paid — the sybil filter);
    ///           - cumulative claims against `voucher.probeCommitment` never
    ///             exceed the delegate budget earned by the verifier's
    ///             credited attestations on that commitment;
    ///           - total credits granted per verifier per epoch stay within
    ///             `maxDelegateCreditsPerVerifierPerEpoch`.
    ///
    ///         The voucher itself proves the verifier vouched for the work;
    ///         which carrier earned how much remains the verifier's word,
    ///         bounded by the caps above. Delegates should claim aggregated
    ///         and unhurried — the deadline is the only timing constraint.
    function claimDelegateCredits(DelegateVoucher calldata voucher, bytes calldata signature) external {
        if (voucher.buyer == address(0) || voucher.credits == 0) revert InvalidValue();
        if (block.timestamp > voucher.deadline) revert VoucherExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DELEGATE_VOUCHER_TYPEHASH,
                    voucher.buyer,
                    voucher.probeCommitment,
                    voucher.credits,
                    voucher.nonce,
                    voucher.deadline
                )
            )
        );
        address verifier = ECDSA.recover(digest, signature);
        if (voucherClaimed[verifier][digest]) revert VoucherAlreadyClaimed();
        if (!approvedVerifiers[verifier]) revert NotApprovedVerifier();
        if (voucher.buyer == verifier) revert SelfDelegate();

        address operator = IAntseedDeposits(registry.deposits()).getOperator(voucher.buyer);
        if (operator == address(0) || msg.sender != operator) revert NotBuyerOperator();
        if (operator == verifier) revert SelfDelegate();

        uint256 commitmentGranted = commitmentDelegateCredits[verifier][voucher.probeCommitment] + voucher.credits;
        if (commitmentGranted > commitmentDelegateBudget[verifier][voucher.probeCommitment]) {
            revert CommitmentBudgetExceeded();
        }

        uint256 epoch = currentEpoch();
        uint256 epochGranted = epochDelegateCreditsGrantedBy[epoch][verifier] + voucher.credits;
        if (epochGranted > maxDelegateCreditsPerVerifierPerEpoch) revert DelegateCreditCapExceeded();

        voucherClaimed[verifier][digest] = true;
        commitmentDelegateCredits[verifier][voucher.probeCommitment] = commitmentGranted;
        epochDelegateCreditsGrantedBy[epoch][verifier] = epochGranted;
        epochDelegateCredits[epoch][operator] += voucher.credits;
        epochTotalDelegateCredits[epoch] += voucher.credits;

        emit DelegateCredited(epoch, verifier, operator, voucher.credits);
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

    /// @dev Maintain both `activeDiffVerifierCount` accumulators from
    ///      `verifier`'s per-service verdict transition (the attesting
    ///      caller, or the owner's remediation target in
    ///      `clearVerifierStanding`). Entering DIFF raises the service-level
    ///      count once per verifier; leaving DIFF (a later SAME/UNDETERMINED
    ///      on the same service, or an owner clearance to 0) lowers it. The
    ///      agent-level count tracks verifiers with a standing DIFF on ANY of
    ///      the agent's services via `_verifierDiffServiceCount`, so a SAME
    ///      on an honestly served service never launders a standing DIFF on
    ///      the substituted one. A stored verdict of 0 means "never attested
    ///      / cleared" (UNKNOWN is not attestable, so 0 is unambiguous). No
    ///      counter can underflow: every decrement requires this verifier's
    ///      stored DIFF on this exact key, which implies the matching earlier
    ///      increment.
    function _updateActiveDiff(
        uint256 agentId,
        bytes32 serviceHash,
        address verifier,
        uint8 verdict,
        ServiceVerificationStats storage stats,
        ServiceVerificationStats storage agentStats
    ) internal {
        uint8 previous = _lastVerdictByVerifier[agentId][serviceHash][verifier];
        if (previous == verdict) return;
        _lastVerdictByVerifier[agentId][serviceHash][verifier] = verdict;

        if (verdict == uint8(Verdict.DIFF)) {
            stats.activeDiffVerifierCount++;
            if (++_verifierDiffServiceCount[agentId][verifier] == 1) {
                agentStats.activeDiffVerifierCount++;
            }
        } else if (previous == uint8(Verdict.DIFF)) {
            stats.activeDiffVerifierCount--;
            if (--_verifierDiffServiceCount[agentId][verifier] == 0) {
                agentStats.activeDiffVerifierCount--;
            }
        }
    }
}
