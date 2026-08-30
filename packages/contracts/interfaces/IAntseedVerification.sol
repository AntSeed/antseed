// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedRegistry } from "./IAntseedRegistry.sol";
import { IAntseedVerificationStatus } from "./IAntseedVerificationStatus.sol";

interface IAntseedVerification is IAntseedVerificationStatus {
    struct VerificationResult {
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
        uint16 modelShareBps;
    }

    struct VerificationBundle {
        address verifier;
        uint64 submittedAt;
        uint32 resultCount;
        string evidenceUri;
    }

    enum Verdict {
        UNKNOWN,
        SAME,
        DIFF,
        UNDETERMINED
    }

    function registry() external view returns (IAntseedRegistry);
    function approvedVerifiers(address verifier) external view returns (bool);

    function setVerifier(address verifier, bool approved) external;

    /// @notice Submits all audited seller results for one model.
    /// @dev `evidenceHash` is the canonical hash of the model bundle evidence and doubles as the
    ///      replay-protection key. `evidenceUri` optionally locates the public evidence package.
    ///      Reward eligibility and accounting are intentionally outside this registry.
    function submitVerificationBundle(
        bytes32 evidenceHash,
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external;

    function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool);
    function verificationBundle(bytes32 evidenceHash) external view returns (VerificationBundle memory);
    function clearVerifierVerdict(uint256 agentId, bytes32 serviceHash, address verifier) external;
}
