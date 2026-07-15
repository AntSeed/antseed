// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

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
 *         follows commit → anchor → attest → reveal: the probe set is sealed
 *         on-chain before it runs (`commitProbeSet`), every probed exchange
 *         is hash+signature-anchored under an on-chain-recomputed Merkle root
 *         (`anchorExchangeBatch`) before any verdict, verdicts must reference
 *         that anchored batch (`submitAttestation`), and the probe set is
 *         opened on-chain afterward (`revealProbeSet`) — so anyone can re-run
 *         the entire audit from public data and reach the same verdict.
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
    /// @dev Upper bound on records per anchored exchange batch. Keeps a
    ///      single anchor transaction within sane calldata/gas limits.
    uint256 public constant MAX_BATCH_RECORDS = 256;
    /// @dev Protocol-wide stealth request limit. The CLI validates the same
    ///      1..3 range; bounding it on-chain prevents a verifier from turning
    ///      one signed exchange into an arbitrary amount of delegate credit.
    uint32 public constant MAX_PROBES_PER_RECORD = 3;
    /// @dev EIP-191 domain tag every peer-signed data blob carries — FROZEN,
    ///      mirrors `signData` in packages/node/src/p2p/identity.ts: the
    ///      signed digest is the personal-sign hash of
    ///      ("antseed-data-v1:" || payload).
    bytes private constant DATA_DOMAIN = "antseed-data-v1:";
    /// @dev keccak256 of the first (domain) field every ResponseAuth signing
    ///      payload must open with — FROZEN, mirrors RESPONSE_AUTH_DOMAIN in
    ///      packages/node/src/verification/response-auth.ts.
    bytes32 private constant RESPONSE_AUTH_DOMAIN_HASH = keccak256("antseed-response-auth-v1");
    /// @dev Number of length-prefixed fields in a ResponseAuth signing
    ///      payload (see `parseResponseAuthPayload`).
    uint256 private constant RESPONSE_AUTH_FIELD_COUNT = 13;

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

    // ─── Exchange Anchoring & Probe Reveal (transparent audits) ──────
    // Order enforced on-chain: commit strictly before anchor; anchor before
    // (or in the same second as) attest; reveal only after at least one
    // attestation referenced the commitment. This makes every audit fully
    // recomputable from public data: the probe set is sealed before it runs,
    // every seller answer is hash+signature-anchored before anything is
    // revealed, and the probes are opened afterward.

    /// @notice Anchor state per (verifier, batchRoot): when it was anchored
    ///         (anchoredAt == 0 means never), how many exchange records it
    ///         holds, the verifier-declared total probe count bundled across
    ///         those records, and the probe-set commitment it was anchored
    ///         under. One `ExchangeRecord` covers one signed stealth request,
    ///         which bundles 1..3 probes — so the batch's
    ///         probe count is declared explicitly at anchor time rather than
    ///         inferred from the record count. The declared `probeCount`
    ///         caps the `probeCount` any attestation referencing the batch
    ///         may claim, so credited work (and the delegate budget it
    ///         backs) is bounded by a claim sealed before the verdict —
    ///         and the claim is recomputable by third parties from the
    ///         revealed probe set + anchored records.
    mapping(address verifier => mapping(bytes32 batchRoot => BatchAnchor anchor)) public batchAnchors;
    mapping(
        address verifier
            => mapping(bytes32 batchRoot => mapping(uint256 agentId => mapping(bytes32 serviceHash => uint32 probeCount)))
    ) public batchTargetProbeCount;
    mapping(
        address verifier
            => mapping(bytes32 batchRoot => mapping(uint256 agentId => mapping(bytes32 serviceHash => bool attested)))
    ) public batchTargetAttested;
    /// @notice The sole batch root anchored for a verifier's probe commitment.
    ///         One batch per commitment prevents replaying the same signed
    ///         exchange across several roots to multiply delegate accrual.
    mapping(address verifier => mapping(bytes32 commitment => bytes32 batchRoot)) public commitmentBatchRoot;
    /// @notice When `verifier` opened `commitment` on-chain (0 = never).
    mapping(address verifier => mapping(bytes32 commitment => uint64 revealedAt)) public probeRevealedAt;
    /// @notice Attestations by `verifier` that referenced `commitment` —
    ///         gates `revealProbeSet` (no reveal-then-probe).
    mapping(address verifier => mapping(bytes32 commitment => uint32 count)) public attestationCountByCommitment;

    // ─── Delegate Crediting ──────────────────────────────────────────
    // Probe execution is delegated to organic buyer peers so probe traffic
    // is indistinguishable from real usage (the verifier whitelist is
    // public, so verifier-originated traffic is linkable and a cheating
    // seller could serve the real model only to verifiers).
    //
    // Which buyer carried which exchange is NOT the verifier's word: every
    // anchored ExchangeRecord's seller-signed ResponseAuth payload names the
    // buyer peer the seller actually answered, the signature is verified
    // on-chain at anchor time, and the carried probe counts accrue here per
    // (verifier, commitment, buyer). The buyer's OPERATOR later claims the
    // accrued credits and collects the delegate share of the verification
    // emissions bucket via AntseedVerifierRewards.
    //
    // The claim resolves and pays the buyer's deposits operator, so the
    // iron rule holds — the buyer hot wallet never receives funds — and the
    // "is this a real, operator-bound buyer" check is enforced on-chain.
    //
    // Grants remain anchored to audit work: every CREDITED attestation adds
    // its probeCount to the referenced commitment's delegate budget, and
    // cumulative claims against a commitment may never exceed that budget.
    // Since credited attestations are themselves rate-limited (per-service
    // cooldown + per-verifier epoch cap), a verifier cannot farm the
    // delegate pool without doing real, commit-anchor-attest-reveal audit
    // work — accrued-but-unbacked credits are simply unclaimable.

    /// @notice Share of the verification bucket reserved for delegates, in
    ///         bps of the epoch budget. Applied by AntseedVerifierRewards
    ///         only for epochs that have delegate credits.
    uint16 public delegateShareBps = 2000;
    /// @notice Cap on delegate credits a single verifier may grant per epoch.
    uint32 public maxDelegateCreditsPerVerifierPerEpoch = 200;

    mapping(uint256 epoch => mapping(address delegate => uint256 credits)) public epochDelegateCredits;
    mapping(uint256 epoch => uint256 credits) public epochTotalDelegateCredits;
    mapping(uint256 epoch => mapping(address verifier => uint256 credits)) public epochDelegateCreditsGrantedBy;
    /// @notice Delegate-credit budget per (verifier, probeCommitment): the
    ///         sum of probeCount over the verifier's CREDITED attestations
    ///         that referenced the commitment.
    mapping(address verifier => mapping(bytes32 commitment => uint256 budget)) public commitmentDelegateBudget;
    /// @notice Credits already granted (claimed) against (verifier,
    ///         commitment), across all buyers. Never exceeds
    ///         `commitmentDelegateBudget` for the same key.
    mapping(address verifier => mapping(bytes32 commitment => uint256 granted)) public commitmentDelegateCredits;
    /// @notice Probe counts accrued at anchor time per carrier buyer, from
    ///         the buyer named inside each seller-signed ResponseAuth
    ///         payload: (verifier, probeCommitment, buyer) → carried probes.
    mapping(address verifier => mapping(bytes32 commitment => mapping(address buyer => uint32 accrued))) public
        commitmentDelegateAccrued;
    /// @notice Portion of `commitmentDelegateAccrued` already claimed for
    ///         the same (verifier, probeCommitment, buyer) triple.
    mapping(address verifier => mapping(bytes32 commitment => mapping(address buyer => uint32 claimed))) public
        commitmentDelegateClaimed;

    // ─── Events ──────────────────────────────────────────────────────
    event VerifierApprovalSet(address indexed verifier, bool approved);
    event AuditCooldownSet(uint64 auditCooldown);
    event MaxCreditsPerVerifierPerEpochSet(uint32 maxCreditsPerVerifierPerEpoch);
    event MinProbeCountSet(uint32 minProbeCount);
    event ProbeSetCommitted(address indexed verifier, bytes32 indexed commitment);
    event ExchangeBatchAnchored(
        address indexed verifier,
        bytes32 indexed probeCommitment,
        bytes32 indexed batchRoot,
        uint32 recordCount,
        uint32 probeCount
    );
    event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri);
    event DelegateShareBpsSet(uint16 delegateShareBps);
    event MaxDelegateCreditsPerVerifierPerEpochSet(uint32 maxDelegateCreditsPerVerifierPerEpoch);
    /// @notice Probe credits accrued to a carrier buyer at anchor time,
    ///         derived from the buyer named inside the seller-signed
    ///         ResponseAuth payloads (aggregated per distinct buyer per
    ///         anchor call).
    event DelegateCreditsAccrued(
        address indexed verifier, bytes32 indexed probeCommitment, address indexed buyer, uint32 credits
    );
    event DelegateCredited(
        uint256 indexed epoch, address indexed verifier, address indexed delegate, bytes32 probeCommitment,
        uint32 credits
    );
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
    error NotBuyerOperator();
    error NothingToClaim();
    error NoStandingDiff();
    error BatchNotAnchored();
    error BatchAlreadyAnchored();
    error CommitmentBatchAlreadyAnchored();
    error BatchCommitmentMismatch();
    error EmptyBatch();
    error BatchTooLarge();
    error ArrayLengthMismatch();
    error MalformedSigningPayload();
    error RecordSignerMismatch(uint256 index);
    error RecordHashMismatch(uint256 index);
    error RecordProbeCountZero(uint256 index);
    error RecordProbeCountTooHigh(uint256 index);
    error DuplicateExchangeRecord(uint256 index);
    error ZeroRecordHash(uint256 index);
    error ProbeCountOverflow();
    error RevealMismatch();
    error RevealBeforeAttest();
    error AlreadyRevealed();
    error ProbeCountExceedsBatch();
    error TargetNotInBatch();
    error TargetAlreadyAttested();
    error ProbeCountExceedsTarget();

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
    //                CORE — COMMIT / ANCHOR / ATTEST / REVEAL
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

    /// @notice Anchor the full probe exchange batch on-chain as calldata,
    ///         BEFORE attesting and before anything is revealed. The Merkle
    ///         root is recomputed on-chain from the calldata records (see
    ///         `computeBatchRoot`), so the root ↔ data binding is chain-
    ///         verified rather than verifier-claimed, AND every record's
    ///         seller signature is verified on-chain: `signingPayloads[i]`
    ///         is the exact ResponseAuth signing preimage (13 length-
    ///         prefixed fields, see `parseResponseAuthPayload`),
    ///         `records[i].responseAuthSig` must recover — over the EIP-191
    ///         digest of ("antseed-data-v1:" || payload) — to the ERC-8004
    ///         owner of `records[i].agentId`, and the payload's embedded
    ///         request/response hashes must equal the anchored ones. A
    ///         verifier therefore cannot anchor an exchange the audited
    ///         seller never signed.
    ///
    ///         The referenced probe-set commitment must have been committed
    ///         in a strictly earlier second (commit before anchor), and the
    ///         same root cannot be anchored twice by the same verifier.
    ///
    ///         `recordProbeCounts[i]` is the number of probes bundled in
    ///         record i's signed stealth request (each request carries
    ///         1..3 probes); every entry must be in that range. The
    ///         batch's total probe count — which caps the `probeCount` any
    ///         attestation referencing the batch may claim — is the enforced
    ///         SUM of these declarations, fixed here before any verdict.
    ///         Third parties can recompute the true per-record values from
    ///         the revealed probe set + anchored records, so an inflated
    ///         declaration is publicly detectable.
    ///
    ///         Delegate crediting happens here as well: each verified
    ///         payload names the buyer peer that carried the exchange; for
    ///         every buyer that is neither the verifier itself nor the
    ///         record's seller, `recordProbeCounts[i]` accrues to
    ///         `commitmentDelegateAccrued[msg.sender][probeCommitment][buyer]`
    ///         (aggregated per distinct buyer — one store + one
    ///         `DelegateCreditsAccrued` event per buyer per call), claimable
    ///         later by the buyer's deposits operator via
    ///         `claimDelegateCredits` within the commitment's budget.
    function anchorExchangeBatch(
        bytes32 probeCommitment,
        ExchangeRecord[] calldata records,
        bytes[] calldata signingPayloads,
        uint32[] calldata recordProbeCounts
    ) external onlyApprovedVerifier returns (bytes32 batchRoot) {
        if (records.length == 0) revert EmptyBatch();
        if (records.length > MAX_BATCH_RECORDS) revert BatchTooLarge();
        if (signingPayloads.length != records.length || recordProbeCounts.length != records.length) {
            revert ArrayLengthMismatch();
        }
        uint64 committedAt = probeCommittedAt[msg.sender][probeCommitment];
        if (committedAt == 0) revert ProbeSetNotCommitted();
        if (committedAt >= block.timestamp) revert ProbeSetTooRecent();
        // One commitment = one sealed lifecycle: once its probes are public,
        // no further exchange may be anchored under it. Otherwise a verifier
        // could reveal, then anchor a fresh batch against a seller that has
        // now seen the probes ("reveal-then-probe").
        if (probeRevealedAt[msg.sender][probeCommitment] != 0) revert AlreadyRevealed();
        if (commitmentBatchRoot[msg.sender][probeCommitment] != bytes32(0)) {
            revert CommitmentBatchAlreadyAnchored();
        }

        _checkUniqueRequestHashes(records);

        batchRoot = computeBatchRoot(records);
        if (batchAnchors[msg.sender][batchRoot].anchoredAt != 0) revert BatchAlreadyAnchored();

        uint32 probeCount =
            _verifyRecordsAndAccrue(probeCommitment, batchRoot, records, signingPayloads, recordProbeCounts);

        // Single struct assignment: anchoredAt/recordCount/probeCount pack
        // into one slot, commitment takes the second — two SSTOREs total.
        batchAnchors[msg.sender][batchRoot] = BatchAnchor({
            anchoredAt: uint64(block.timestamp),
            recordCount: uint32(records.length),
            probeCount: probeCount,
            commitment: probeCommitment
        });
        commitmentBatchRoot[msg.sender][probeCommitment] = batchRoot;
        emit ExchangeBatchAnchored(msg.sender, probeCommitment, batchRoot, uint32(records.length), probeCount);
    }

    /// @dev Reject a zero request/response hash and duplicate request hashes in
    ///      one batch. Combined with one-batch-per-commitment, this makes every
    ///      seller-signed request usable for delegate accrual at most once.
    function _checkUniqueRequestHashes(ExchangeRecord[] calldata records) private pure {
        uint256 tableSize = 1;
        while (tableSize < records.length * 2) tableSize <<= 1;
        bytes32[] memory table = new bytes32[](tableSize);
        uint256 mask = tableSize - 1;

        for (uint256 i = 0; i < records.length; i++) {
            bytes32 requestHash = records[i].requestHash;
            if (requestHash == bytes32(0) || records[i].responseHash == bytes32(0)) revert ZeroRecordHash(i);
            uint256 slot = uint256(requestHash) & mask;
            while (table[slot] != bytes32(0)) {
                if (table[slot] == requestHash) revert DuplicateExchangeRecord(i);
                slot = (slot + 1) & mask;
            }
            table[slot] = requestHash;
        }
    }

    /// @dev Per-record on-chain authentication + delegate accrual for
    ///      `anchorExchangeBatch`. For each record: resolve the seller as
    ///      the ERC-8004 owner of the record's agentId (resolution cached in
    ///      memory — cohorts repeat few sellers), verify the 65-byte
    ///      ResponseAuth signature over the EIP-191 digest of
    ///      ("antseed-data-v1:" || signingPayloads[i]) recovers to that
    ///      seller, and require the payload's embedded request/response
    ///      hashes to match the anchored record. Buyer credits (the payload's
    ///      buyer field) are aggregated in memory per distinct buyer and
    ///      flushed as one SSTORE + one event each. Returns the checked
    ///      uint32 sum of `recordProbeCounts`.
    function _verifyRecordsAndAccrue(
        bytes32 probeCommitment,
        bytes32 batchRoot,
        ExchangeRecord[] calldata records,
        bytes[] calldata signingPayloads,
        uint32[] calldata recordProbeCounts
    ) private returns (uint32) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();

        uint256 n = records.length;
        // agentId → seller memory cache (linear scan; distinct sellers per
        // batch are few — one cohort's members).
        uint256[] memory cachedAgentIds = new uint256[](n);
        address[] memory cachedSellers = new address[](n);
        uint256 cachedCount = 0;
        // Per-buyer accrual aggregation.
        address[] memory buyers = new address[](n);
        uint256[] memory buyerProbes = new uint256[](n);
        uint256 buyerCount = 0;
        uint256[] memory targetAgentIds = new uint256[](n);
        bytes32[] memory targetServiceHashes = new bytes32[](n);
        uint256[] memory targetProbes = new uint256[](n);
        uint256 targetCount = 0;

        uint256 totalProbes = 0;
        for (uint256 i = 0; i < n; i++) {
            if (recordProbeCounts[i] == 0) revert RecordProbeCountZero(i);
            if (recordProbeCounts[i] > MAX_PROBES_PER_RECORD) revert RecordProbeCountTooHigh(i);
            totalProbes += recordProbeCounts[i];

            // Resolve (or reuse) the seller address for this agentId.
            address seller = address(0);
            uint256 agentId = records[i].agentId;
            for (uint256 j = 0; j < cachedCount; j++) {
                if (cachedAgentIds[j] == agentId) {
                    seller = cachedSellers[j];
                    break;
                }
            }
            if (seller == address(0)) {
                seller = _resolveAgentOwner(identityRegistry, agentId);
                cachedAgentIds[cachedCount] = agentId;
                cachedSellers[cachedCount] = seller;
                cachedCount++;
            }

            // The seller must have signed exactly this payload.
            (address recovered, ECDSA.RecoverError err,) =
                ECDSA.tryRecover(responseAuthDigest(signingPayloads[i]), records[i].responseAuthSig);
            if (err != ECDSA.RecoverError.NoError || recovered != seller) revert RecordSignerMismatch(i);

            // The payload must describe the anchored exchange.
            (address buyer, bytes32 advertisedServiceHash, bytes32 requestHash, bytes32 responseHash) =
                parseResponseAuthPayload(signingPayloads[i]);
            if (requestHash != records[i].requestHash || responseHash != records[i].responseHash) {
                revert RecordHashMismatch(i);
            }
            bool targetFound = false;
            for (uint256 j = 0; j < targetCount; j++) {
                if (targetAgentIds[j] == agentId && targetServiceHashes[j] == advertisedServiceHash) {
                    targetProbes[j] += recordProbeCounts[i];
                    targetFound = true;
                    break;
                }
            }
            if (!targetFound) {
                targetAgentIds[targetCount] = agentId;
                targetServiceHashes[targetCount] = advertisedServiceHash;
                targetProbes[targetCount] = recordProbeCounts[i];
                targetCount++;
            }

            // A verifier probing directly (buyer == verifier) and a seller
            // "carrying" its own audit (buyer == seller) earn no delegate
            // credits.
            if (buyer != msg.sender && buyer != seller) {
                bool found = false;
                for (uint256 j = 0; j < buyerCount; j++) {
                    if (buyers[j] == buyer) {
                        buyerProbes[j] += recordProbeCounts[i];
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    buyers[buyerCount] = buyer;
                    buyerProbes[buyerCount] = recordProbeCounts[i];
                    buyerCount++;
                }
            }
        }
        if (totalProbes > type(uint32).max) revert ProbeCountOverflow();

        for (uint256 j = 0; j < targetCount; j++) {
            batchTargetProbeCount[msg.sender][batchRoot][targetAgentIds[j]][targetServiceHashes[j]] =
                uint32(targetProbes[j]);
        }

        for (uint256 j = 0; j < buyerCount; j++) {
            uint32 credits = uint32(buyerProbes[j]); // <= totalProbes, checked above
            commitmentDelegateAccrued[msg.sender][probeCommitment][buyers[j]] += credits;
            emit DelegateCreditsAccrued(msg.sender, probeCommitment, buyers[j], credits);
        }
        return uint32(totalProbes);
    }

    /// @dev agentId → seller address, resolved the way the protocol
    ///      canonically binds peers to agents: the ERC-8004 IdentityRegistry
    ///      owner IS the peer's signing address (see `_checkAuditedAgent`
    ///      and AntseedStaking, which requires `ownerOf(agentId) == seller`
    ///      at stake time).
    function _resolveAgentOwner(address identityRegistry, uint256 agentId) private view returns (address) {
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address agentOwner) {
            if (agentOwner == address(0)) revert UnknownAgent();
            return agentOwner;
        } catch {
            revert UnknownAgent();
        }
    }

    /// @notice EIP-191 digest a peer signs over a data payload — FROZEN,
    ///         mirrors `signData` in packages/node/src/p2p/identity.ts:
    ///         personal-sign hash of ("antseed-data-v1:" || payload), i.e.
    ///         keccak256("\x19Ethereum Signed Message:\n" || decimal(16 +
    ///         payload.length) || "antseed-data-v1:" || payload). Public
    ///         pure so off-chain mirrors can cross-check via `eth_call`.
    ///
    ///         Built in a single buffer (equivalent to OZ
    ///         MessageHashUtils.toEthSignedMessageHash over the tagged
    ///         bytes, pinned against it in the test suite) — the two-step
    ///         concat-then-wrap version copies the payload twice, and this
    ///         digest runs once per anchored record.
    function responseAuthDigest(bytes calldata signingPayload) public pure returns (bytes32) {
        bytes memory lengthDecimal = bytes(Strings.toString(DATA_DOMAIN.length + signingPayload.length));
        return keccak256(bytes.concat("\x19Ethereum Signed Message:\n", lengthDecimal, DATA_DOMAIN, signingPayload));
    }

    /// @notice Parse a ResponseAuth signing payload and extract the fields
    ///         the contract binds on-chain. FROZEN wire format — mirrors
    ///         `buildResponseAuthSigningBytes` in
    ///         packages/node/src/verification/response-auth.ts: exactly 13
    ///         fields, each prefixed with a 4-byte big-endian uint32 byte
    ///         length, UTF-8 encoded, in order:
    ///           [0] "antseed-response-auth-v1" (domain — enforced, so no
    ///               other `signData`-domain blob can pose as a ResponseAuth)
    ///           [1] version          [2] requestId      [3] channelId ("" ok)
    ///           [4] buyerPeerId      [5] sellerPeerId   [6] advertisedService
    ///           [7] provider         [8] statusCode     [9] requestHash
    ///           [10] responseHash    [11] responseStartedAt
    ///           [12] responseCompletedAt
    ///         Peer ids are lowercase hex EVM addresses (40 nibbles, the
    ///         protocol writes them without a 0x prefix; a 0x prefix is
    ///         tolerated), hashes are 64-nibble hex (the protocol writes
    ///         them 0x-prefixed). The payload must be consumed exactly —
    ///         no trailing bytes.
    function parseResponseAuthPayload(bytes calldata payload)
        public
        pure
        returns (address buyer, bytes32 advertisedServiceHash, bytes32 requestHash, bytes32 responseHash)
    {
        uint256 offset = 0;
        for (uint256 f = 0; f < RESPONSE_AUTH_FIELD_COUNT; f++) {
            if (offset + 4 > payload.length) revert MalformedSigningPayload();
            uint256 fieldLength;
            // 4-byte big-endian length prefix. Bounds checked above;
            // calldata reads past the end are zero-padded, never unsafe.
            assembly ("memory-safe") {
                fieldLength := shr(224, calldataload(add(payload.offset, offset)))
            }
            offset += 4;
            if (payload.length - offset < fieldLength) revert MalformedSigningPayload();
            bytes calldata field = payload[offset:offset + fieldLength];
            offset += fieldLength;

            if (f == 0) {
                if (keccak256(field) != RESPONSE_AUTH_DOMAIN_HASH) revert MalformedSigningPayload();
            } else if (f == 4) {
                buyer = address(uint160(_parseHex(field, 40)));
            } else if (f == 6) {
                advertisedServiceHash = _normalizedServiceHash(field);
            } else if (f == 9) {
                requestHash = bytes32(_parseHex(field, 64));
            } else if (f == 10) {
                responseHash = bytes32(_parseHex(field, 64));
            }
        }
        if (offset != payload.length) revert MalformedSigningPayload();
    }

    function _normalizedServiceHash(bytes calldata field) private pure returns (bytes32) {
        uint256 start;
        uint256 end = field.length;
        while (start < end && _isAsciiWhitespace(uint8(field[start]))) start++;
        while (end > start && _isAsciiWhitespace(uint8(field[end - 1]))) end--;
        if (start == end) revert MalformedSigningPayload();

        bytes memory normalized = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            uint8 c = uint8(field[i]);
            if (c >= 0x41 && c <= 0x5A) c += 0x20;
            normalized[i - start] = bytes1(c);
        }
        return keccak256(normalized);
    }

    function _isAsciiWhitespace(uint8 c) private pure returns (bool) {
        return c == 0x20 || (c >= 0x09 && c <= 0x0D);
    }

    /// @dev Parse an ASCII-hex field (optionally 0x-prefixed, either case)
    ///      of exactly `expectedNibbles` (33..64) hex digits into its
    ///      integer value.
    ///
    ///      GAS: this runs on ~170 hex digits per anchored record, so the
    ///      decode is word-parallel assembly (32 ASCII chars per step, two
    ///      overlapping calldata words per field) instead of a per-digit
    ///      loop — per-digit decoding measured ~120 gas/nibble, ~20k per
    ///      record, and dominated `anchorExchangeBatch`.
    ///
    ///      Per byte b of a loaded word: case-fold c = b | 0x20, nibble
    ///      v = (c & 0x0F) + 9 * (c >> 6); valid iff every v <= 15 AND the
    ///      re-encoding v -> ASCII lowercase reproduces c exactly. This
    ///      rejects every byte except: digits, a-f, A-F — and, as a KNOWN
    ///      quirk of case-folding, the control bytes 0x10..0x19, which
    ///      alias '0'..'9'. That leniency is harmless here: the seller's
    ///      signature binds the exact payload bytes, and the strict
    ///      off-chain parser (packages/node response-auth.ts) rejects such
    ///      payloads anyway — a seller signing control bytes only breaks
    ///      its own exchanges' recomputability.
    function _parseHex(bytes calldata field, uint256 expectedNibbles) private pure returns (uint256 value) {
        uint256 start = 0;
        if (field.length >= 2 && field[0] == "0" && field[1] == "x") start = 2;
        if (field.length - start != expectedNibbles) revert MalformedSigningPayload();
        // Callers pass 40 (addresses) or 64 (bytes32) only; the two-word
        // overlapping-load scheme below needs 32 < n <= 64.
        if (expectedNibbles <= 32 || expectedNibbles > 64) revert MalformedSigningPayload();
        bool malformed = false;
        assembly ("memory-safe") {
            // Decode one 32-char ASCII-hex calldata word into a 128-bit
            // value, word-parallel. Masks operate per byte lane.
            function decodeHexWord(word) -> v, ok {
                let cf := or(word, 0x2020202020202020202020202020202020202020202020202020202020202020)
                v :=
                    add(
                        and(cf, 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f),
                        mul(and(shr(6, cf), 0x0303030303030303030303030303030303030303030303030303030303030303), 9)
                    )
                // Every nibble value must fit in 4 bits...
                ok := iszero(and(v, 0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0))
                // ...and re-encoding to ASCII lowercase must reproduce the
                // folded input ('0'-'9' -> +0x30, 'a'-'f' -> +0x57).
                let gap :=
                    shr(4, and(add(v, 0x0606060606060606060606060606060606060606060606060606060606060606),
                        0x1010101010101010101010101010101010101010101010101010101010101010))
                ok :=
                    and(
                        ok,
                        eq(
                            add(
                                add(v, 0x3030303030303030303030303030303030303030303030303030303030303030),
                                mul(gap, 0x27)
                            ),
                            cf
                        )
                    )
                // Pack the 32 byte-lane nibbles into the low 128 bits.
                v := and(or(v, shr(4, v)), 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
                v := and(or(v, shr(8, v)), 0xffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
                v := and(or(v, shr(16, v)), 0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
                v := and(or(v, shr(32, v)), 0xffffffffffffffff0000000000000000ffffffffffffffff)
                v := and(or(v, shr(64, v)), 0xffffffffffffffffffffffffffffffff)
            }

            let ptr := add(field.offset, start)
            // Chars 0..31 (the high 32 nibbles) and the last 32 chars
            // (overlapping — overlapped chars decode identically twice).
            let hi, okHi := decodeHexWord(calldataload(ptr))
            let lo, okLo := decodeHexWord(calldataload(add(ptr, sub(expectedNibbles, 32))))
            let tailBits := shl(2, sub(expectedNibbles, 32)) // (n - 32) * 4
            value := or(shl(tailBits, hi), and(lo, sub(shl(tailBits, 1), 1)))
            malformed := iszero(and(okHi, okLo))
        }
        if (malformed) revert MalformedSigningPayload();
    }

    /// @notice Merkle root over an exchange batch. Public pure so off-chain
    ///         mirrors (packages/node `exchange-batch.ts`) can cross-check
    ///         their implementation against the contract via `eth_call`.
    ///
    ///         Tree shape (MUST stay in lockstep with the TypeScript mirror):
    ///           leaf   = keccak256(abi.encode(
    ///                        agentId, requestHash, responseHash,
    ///                        keccak256(responseAuthSig)))
    ///           parent = keccak256(left || right)   (pairwise, in order)
    ///           an odd trailing node is promoted to the next level as-is;
    ///           a single-record batch's root is its leaf.
    function computeBatchRoot(ExchangeRecord[] calldata records) public pure returns (bytes32) {
        uint256 n = records.length;
        if (n == 0) revert EmptyBatch();
        bytes32[] memory nodes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            nodes[i] = keccak256(
                abi.encode(
                    records[i].agentId,
                    records[i].requestHash,
                    records[i].responseHash,
                    keccak256(records[i].responseAuthSig)
                )
            );
        }
        while (n > 1) {
            uint256 next = (n + 1) >> 1;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                nodes[i >> 1] = keccak256(bytes.concat(nodes[i], nodes[i + 1]));
            }
            if (n & 1 == 1) nodes[next - 1] = nodes[n - 1];
            n = next;
        }
        return nodes[0];
    }

    /// @notice Open a probe-set commitment on-chain: publish the exact
    ///         canonical probe-set JSON bytes and verify them against the
    ///         commitment. Allowed only after at least one attestation has
    ///         referenced the commitment, so a verifier can never reveal
    ///         probes and then probe with them ("reveal-then-probe"). The
    ///         opened bytes live in this transaction's calldata — the event
    ///         carries no bytes; auditors read them from the tx input.
    ///
    ///         `packUri` is an OPTIONAL on-chain pointer to the off-chain
    ///         response pack (request/response plaintexts + ResponseAuths,
    ///         whose hashes are already anchored) so a third party can locate
    ///         it from chain data alone. It is emitted verbatim in the event
    ///         and otherwise unvalidated; an empty string is allowed when the
    ///         verifier publishes the pack out of band.
    ///
    ///         BYTE DERIVATION — mirrors `computeProbeCommitment` in
    ///         packages/fingerprints/src/types.ts exactly: the commitment is
    ///         `sha256(utf8(canonicalJsonStringify({service, probes, nonce})))`
    ///         (canonicalHashBytes32 hashes the UTF-8 canonical-JSON string
    ///         DIRECTLY — no domain prefix, no length framing), so a plain
    ///         `sha256(probeSetJson)` over the exact canonical bytes is the
    ///         correct opening check.
    ///
    ///         NOT `onlyApprovedVerifier`: the opening is self-authenticating
    ///         (sha256 must equal the commitment) and the reveal is keyed by
    ///         the caller's own commit/attest state, so a verifier that has
    ///         since been removed from the whitelist can still complete the
    ///         transparency of its own past audits — the audits people most
    ///         want to re-run — rather than having them permanently sealed.
    function revealProbeSet(bytes32 probeCommitment, bytes calldata probeSetJson, string calldata packUri) external {
        if (probeCommittedAt[msg.sender][probeCommitment] == 0) revert ProbeSetNotCommitted();
        if (probeRevealedAt[msg.sender][probeCommitment] != 0) revert AlreadyRevealed();
        if (attestationCountByCommitment[msg.sender][probeCommitment] == 0) revert RevealBeforeAttest();
        if (sha256(probeSetJson) != probeCommitment) revert RevealMismatch();
        probeRevealedAt[msg.sender][probeCommitment] = uint64(block.timestamp);
        emit ProbeSetRevealed(msg.sender, probeCommitment, packUri);
    }

    /// @notice Record an audit verdict for `(agentId, serviceHash)`. The
    ///         attestation is credited toward the verifier's epoch reward
    ///         share only when the per-service cooldown has elapsed and the
    ///         verifier is below its per-epoch credit cap; the attestation
    ///         itself is stored either way.
    ///
    ///         TRUST MODEL — whitelist plus total recomputability, not ZK
    ///         proof. The verdict itself is still the verifier's claim, but
    ///         it must reference an exchange batch anchored on-chain under
    ///         the same pre-audit probe-set commitment, and the commitment
    ///         is opened on-chain afterward (`revealProbeSet`) — so anyone
    ///         can re-run the audit from public data and check the verdict.
    ///         `evidenceHash` remains a pointer to the off-chain response
    ///         pack (plaintexts whose hashes are anchored in the batch).
    ///         Verifiers are owner-whitelisted and the whitelist is the
    ///         enforcement lever; integrators MUST NOT treat epoch credits
    ///         or stored attestations alone as cryptographic proof of audit
    ///         work — recompute via the anchored batch + revealed probes.
    function submitAttestation(
        uint256 agentId,
        bytes32 serviceHash,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        bytes32 batchRoot,
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

        // The verdict must reference an exchange batch this verifier anchored
        // under the SAME probe-set commitment (anchor before / with attest).
        BatchAnchor storage anchor = batchAnchors[msg.sender][batchRoot];
        if (anchor.anchoredAt == 0) revert BatchNotAnchored();
        if (anchor.commitment != probeCommitment) revert BatchCommitmentMismatch();
        // The claimed probe count can never exceed the probe count declared
        // when the batch was anchored (records bundle multiple probes, so
        // this is a per-PROBE cap, not the record count), so credited work —
        // and the delegate budget it backs — is bounded by a claim fixed
        // before the verdict, not by the verifier's later word.
        if (probeCount > anchor.probeCount) revert ProbeCountExceedsBatch();
        // Once the commitment's probes are public no new verdict may credit
        // against it (matches the anchor-after-reveal seal).
        if (probeRevealedAt[msg.sender][probeCommitment] != 0) revert AlreadyRevealed();
        _checkAuditedAgent(agentId);

        uint32 targetProbeCount = batchTargetProbeCount[msg.sender][batchRoot][agentId][serviceHash];
        if (targetProbeCount == 0) revert TargetNotInBatch();
        if (probeCount > targetProbeCount) revert ProbeCountExceedsTarget();
        if (batchTargetAttested[msg.sender][batchRoot][agentId][serviceHash]) revert TargetAlreadyAttested();

        batchTargetAttested[msg.sender][batchRoot][agentId][serviceHash] = true;

        uint64 nowTs = uint64(block.timestamp);
        uint256 epoch = currentEpoch();

        _latestAttestations[agentId][serviceHash] = Attestation({
            verifier: msg.sender,
            attestedAt: nowTs,
            verdict: verdict,
            probeCount: probeCount,
            cohortSize: cohortSize,
            evidenceHash: evidenceHash,
            probeCommitment: probeCommitment,
            batchRoot: batchRoot
        });
        lastAuditedAt[agentId][serviceHash] = nowTs;
        // Gate for revealProbeSet: the probe set may be opened only once at
        // least one verdict has referenced it.
        attestationCountByCommitment[msg.sender][probeCommitment]++;

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
            agentId,
            serviceHash,
            msg.sender,
            verdict,
            evidenceHash,
            probeCommitment,
            batchRoot,
            probeCount,
            cohortSize,
            credited,
            epoch
        );
    }

    /// @notice Claim the delegate credits accrued to `buyer` at anchor time
    ///         for probe traffic it carried for `verifier` under
    ///         `probeCommitment`. Replaces the off-chain EIP-712
    ///         DelegateVoucher: which buyer carried which exchange is proven
    ///         by the seller-signed ResponseAuth payloads verified in
    ///         `anchorExchangeBatch`, not vouched by the verifier.
    ///
    ///         Callable only by the buyer's deposits operator; credits land
    ///         in the CURRENT epoch, keyed by that operator, and drive the
    ///         delegate share of the verification bucket in
    ///         AntseedVerifierRewards.
    ///
    ///         The claimable amount is the buyer's unclaimed accrual on the
    ///         (verifier, commitment) pair, clamped to
    ///           - the commitment's remaining delegate budget (the summed
    ///             probeCount of the verifier's CREDITED attestations on the
    ///             commitment, minus credits already granted) — so nothing
    ///             is claimable before a credited attestation exists, and a
    ///             verifier cannot farm the delegate pool by anchoring
    ///             unattested batches; and
    ///           - the verifier's remaining per-epoch delegate-credit
    ///             allowance (`maxDelegateCreditsPerVerifierPerEpoch`).
    ///         A clamped remainder stays claimable later (next epoch, or
    ///         after further credited attestations grow the budget).
    function claimDelegateCredits(address verifier, bytes32 probeCommitment, address buyer) external {
        if (verifier == address(0) || buyer == address(0)) revert InvalidValue();
        if (!approvedVerifiers[verifier]) revert NotApprovedVerifier();
        if (buyer == verifier) revert SelfDelegate();

        address operator = IAntseedDeposits(registry.deposits()).getOperator(buyer);
        if (operator == address(0) || msg.sender != operator) revert NotBuyerOperator();
        if (operator == verifier) revert SelfDelegate();

        uint256 alreadyClaimed = commitmentDelegateClaimed[verifier][probeCommitment][buyer];
        uint256 claimable = commitmentDelegateAccrued[verifier][probeCommitment][buyer] - alreadyClaimed;

        uint256 granted = commitmentDelegateCredits[verifier][probeCommitment];
        uint256 budget = commitmentDelegateBudget[verifier][probeCommitment];
        uint256 budgetLeft = budget > granted ? budget - granted : 0;
        if (claimable > budgetLeft) claimable = budgetLeft;

        uint256 epoch = currentEpoch();
        uint256 epochGranted = epochDelegateCreditsGrantedBy[epoch][verifier];
        uint256 cap = maxDelegateCreditsPerVerifierPerEpoch;
        uint256 capLeft = cap > epochGranted ? cap - epochGranted : 0;
        if (claimable > capLeft) claimable = capLeft;

        if (claimable == 0) revert NothingToClaim();

        commitmentDelegateClaimed[verifier][probeCommitment][buyer] = uint32(alreadyClaimed + claimable);
        commitmentDelegateCredits[verifier][probeCommitment] = granted + claimable;
        epochDelegateCreditsGrantedBy[epoch][verifier] = epochGranted + claimable;
        epochDelegateCredits[epoch][operator] += claimable;
        epochTotalDelegateCredits[epoch] += claimable;

        emit DelegateCredited(epoch, verifier, operator, probeCommitment, uint32(claimable));
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
