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
    }

    /// @notice Per-(agentId, serviceHash) reputation accumulators. The stats
    ///         timestamp is `lastAuditedAt(agentId, serviceHash)` — it is not
    ///         duplicated here.
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

    function registry() external view returns (IAntseedRegistry);
    function currentEpoch() external view returns (uint256);

    function approvedVerifiers(address verifier) external view returns (bool);
    function commitProbeSet(bytes32 commitment) external;
    function probeCommittedAt(address verifier, bytes32 commitment) external view returns (uint64);
    function submitAttestation(
        uint256 agentId,
        bytes32 serviceHash,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32 probeCommitment,
        uint32 probeCount,
        uint32 cohortSize
    ) external;

    function lastAuditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64);
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

    /// @notice Off-chain EIP-712 voucher a verifier signs for a buyer that
    ///         carried its probe traffic. `buyer` is the delegate's peer
    ///         identity (hot wallet); the claim resolves and credits its
    ///         deposits operator.
    struct DelegateVoucher {
        address buyer;
        bytes32 probeCommitment;
        uint32 credits;
        uint256 nonce;
        uint256 deadline;
    }

    function delegateShareBps() external view returns (uint16);
    function maxDelegateCreditsPerVerifierPerEpoch() external view returns (uint32);
    function claimDelegateCredits(DelegateVoucher calldata voucher, bytes calldata signature) external;
    function voucherClaimed(address verifier, bytes32 digest) external view returns (bool);
    function commitmentDelegateBudget(address verifier, bytes32 commitment) external view returns (uint256);
    function commitmentDelegateCredits(address verifier, bytes32 commitment) external view returns (uint256);
    function epochDelegateCredits(uint256 epoch, address delegate) external view returns (uint256);
    function epochTotalDelegateCredits(uint256 epoch) external view returns (uint256);
    function epochDelegateCreditsGrantedBy(uint256 epoch, address verifier) external view returns (uint256);
}
