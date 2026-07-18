// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedRegistry } from "./IAntseedRegistry.sol";

interface IAntseedVerifierRegistry {
    /// @notice Verdict codes. FROZEN mapping shared with the TypeScript
    ///         verifier daemon — never reorder or renumber:
    ///         0=UNKNOWN, 1=SAME, 2=DIFF, 3=UNDETERMINED.
    enum Verdict {
        UNKNOWN,
        SAME,
        DIFF,
        UNDETERMINED
    }

    struct Attestation {
        address verifier;
        uint64 attestedAt;
        uint8 verdict;
        uint32 probeCount;
        uint32 cohortSize;
        bytes32 evidenceHash;
        bytes32 probeCommitment;
        /// @dev Root of the on-chain-anchored exchange batch this verdict
        ///      references, so an indexer can walk verdict → batch → records.
        bytes32 batchRoot;
    }

    /// @notice Per-(agentId, serviceHash) reputation accumulators. The stats
    ///         timestamp is `latestAttestation(agentId, serviceHash)
    ///         .attestedAt` — it is not duplicated here.
    struct ServiceVerificationStats {
        uint32 sameCount;
        uint32 diffCount;
        uint32 undeterminedCount;
        uint32 distinctVerifierCount;
        uint8 lastVerdict;
        address lastVerifier;
        /// @dev Distinct verifiers whose LATEST verdict for this key is DIFF.
        ///      Unlike `diffCount` (monotonic history), this is a standing
        ///      flag: a verifier re-attesting SAME/UNDETERMINED retracts its
        ///      own DIFF. Penalty policies gate on this so an accusation is
        ///      both corroborated and reversible.
        uint32 activeDiffVerifierCount;
    }

    /// @notice One probed request/response exchange, anchored on-chain as
    ///         calldata BEFORE any probe content is revealed. `requestHash`
    ///         and `responseHash` are content hashes of the plaintexts kept
    ///         in the off-chain response pack; `responseAuthSig` is the
    ///         seller's 65-byte ECDSA signature over the ResponseAuth
    ///         signing payload — VERIFIED ON-CHAIN at anchor time against
    ///         the ERC-8004 owner of `agentId` (see `anchorExchangeBatch`).
    ///         One record per SIGNED STEALTH REQUEST — a record may bundle
    ///         several probes (up to the client's `maxProbesPerRequest`), so
    ///         a batch's probe count generally exceeds its record count.
    struct ExchangeRecord {
        uint256 agentId;
        bytes32 requestHash;
        bytes32 responseHash;
        bytes responseAuthSig;
    }

    /// @notice Anchor state per (verifier, batchRoot). All fields pack into
    ///         one storage slot. The probe-set commitment the batch was
    ///         anchored under is not duplicated here — it is the inverse of
    ///         `commitmentBatchRoot` (one batch per commitment).
    struct BatchAnchor {
        /// @dev When the batch was anchored (0 = never anchored).
        uint64 anchoredAt;
        /// @dev Number of `ExchangeRecord`s anchored under the root — one
        ///      per signed stealth request.
        uint32 recordCount;
        /// @dev Total probes bundled across the batch's records — the
        ///      contract-enforced SUM of the per-record `recordProbeCounts`
        ///      declared at anchor time. Publicly visible and recomputable
        ///      by third parties from the revealed probe set + response
        ///      pack. Caps the `probeCount` any attestation referencing the
        ///      batch may claim, so credited work (and the delegate budget
        ///      it backs) is bounded by a claim sealed before the verdict,
        ///      not by the verifier's later word.
        uint32 probeCount;
    }

    function registry() external view returns (IAntseedRegistry);
    function currentEpoch() external view returns (uint256);

    function approvedVerifiers(address verifier) external view returns (bool);
    function commitProbeSet(bytes32 commitment) external;
    function probeCommittedAt(address verifier, bytes32 commitment) external view returns (uint64);
    /// @notice Anchor an exchange batch. `signingPayloads[i]` is the exact
    ///         ResponseAuth signing preimage for `records[i]` (13 length-
    ///         prefixed UTF-8 fields — see `parseResponseAuthPayload`);
    ///         each record's signature is verified on-chain against the
    ///         ERC-8004 owner of its agentId. `recordProbeCounts[i]` (1..3)
    ///         declares the probes bundled in record i; the anchored batch's
    ///         probeCount is their checked sum. The buyer named in each
    ///         verified payload accrues delegate credits when it is neither
    ///         the anchoring verifier nor the record's seller. Each signed
    ///         response must start at or after the referenced commitment and
    ///         complete no earlier than it started.
    function anchorExchangeBatch(
        bytes32 probeCommitment,
        ExchangeRecord[] calldata records,
        bytes[] calldata signingPayloads,
        uint32[] calldata recordProbeCounts
    ) external returns (bytes32 batchRoot);
    function computeBatchRoot(ExchangeRecord[] calldata records) external pure returns (bytes32);
    function responseAuthDigest(bytes calldata signingPayload) external pure returns (bytes32);
    function parseResponseAuthPayload(bytes calldata payload)
        external
        pure
        returns (
            address buyer,
            bytes32 advertisedServiceHash,
            bytes32 requestHash,
            bytes32 responseHash,
            uint64 responseStartedAt,
            uint64 responseCompletedAt
        );
    function submitAttestation(
        uint256 agentId,
        bytes32 serviceHash,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        bytes32 batchRoot,
        uint32 probeCount,
        uint32 cohortSize
    ) external;
    function revealProbeSet(bytes32 probeCommitment, bytes calldata probeSetJson, string calldata packUri) external;

    function batchAnchors(address verifier, bytes32 batchRoot)
        external
        view
        returns (uint64 anchoredAt, uint32 recordCount, uint32 probeCount);
    function commitmentBatchRoot(address verifier, bytes32 commitment) external view returns (bytes32);
    function batchTargetProbeCount(address verifier, bytes32 batchRoot, uint256 agentId, bytes32 serviceHash)
        external
        view
        returns (uint32);
    function batchTargetAttested(address verifier, bytes32 batchRoot, uint256 agentId, bytes32 serviceHash)
        external
        view
        returns (bool);
    function probeRevealedAt(address verifier, bytes32 commitment) external view returns (uint64);
    function commitmentAttested(address verifier, bytes32 commitment) external view returns (bool);

    function lastCreditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64);
    function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (Attestation memory);
    function verificationStats(uint256 agentId, bytes32 serviceHash)
        external
        view
        returns (ServiceVerificationStats memory);
    function agentVerificationStats(uint256 agentId) external view returns (ServiceVerificationStats memory);
    function epochCredits(uint256 epoch, address verifier) external view returns (uint256);
    function epochTotalCredits(uint256 epoch) external view returns (uint256);

    // ─── Delegate crediting (organic probe carriers) ─────────────────
    // Delegate credits accrue at anchor time from the buyer named inside
    // each seller-signed ResponseAuth payload (verified on-chain in
    // `anchorExchangeBatch`), keyed by the audited target; the buyer's
    // deposits operator claims them via `claimDelegateCredits(verifier,
    // probeCommitment, buyer, agentId, serviceHash)`. This replaces the
    // former off-chain EIP-712 DelegateVoucher flow.

    function delegateShareBps() external view returns (uint16);
    function maxDelegateCreditsPerVerifierPerEpoch() external view returns (uint32);
    /// @notice Claim `buyer`'s unclaimed anchor-time accrual on
    ///         (verifier, probeCommitment, target) — the target being the
    ///         audited (agentId, serviceHash) from the accrual event —
    ///         clamped to that target's remaining credited-attestation
    ///         budget and the verifier's remaining per-epoch allowance.
    ///         Callable only by the buyer's deposits operator; credits are
    ///         keyed to that operator.
    function claimDelegateCredits(
        address verifier,
        bytes32 probeCommitment,
        address buyer,
        uint256 agentId,
        bytes32 serviceHash
    ) external;
    /// @notice keccak256(agentId || serviceHash) — the target key the
    ///         delegate mappings below are indexed by.
    function delegateTargetKey(uint256 agentId, bytes32 serviceHash) external pure returns (bytes32);
    function commitmentDelegateAccrued(address verifier, bytes32 commitment, bytes32 targetKey, address buyer)
        external
        view
        returns (uint32);
    function commitmentDelegateClaimed(address verifier, bytes32 commitment, bytes32 targetKey, address buyer)
        external
        view
        returns (uint32);
    function commitmentDelegateBudget(address verifier, bytes32 commitment, bytes32 targetKey)
        external
        view
        returns (uint256);
    function commitmentDelegateCredits(address verifier, bytes32 commitment, bytes32 targetKey)
        external
        view
        returns (uint256);
    /// @notice Which verifier anchored `requestHash` (address(0) = never).
    ///         Global anti-replay: a seller-signed exchange is anchorable
    ///         exactly once network-wide.
    function anchoredExchangeBy(bytes32 requestHash) external view returns (address);
    function epochDelegateCredits(uint256 epoch, address delegate) external view returns (uint256);
    function epochTotalDelegateCredits(uint256 epoch) external view returns (uint256);
    function epochDelegateCreditsGrantedBy(uint256 epoch, address verifier) external view returns (uint256);
}
