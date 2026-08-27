// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "./IAntseedRegistry.sol";
import { IAntseedVerificationStatus } from "./IAntseedVerificationStatus.sol";

interface IAntseedVerification is IAntseedVerificationStatus {
    struct VerificationResult {
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
        uint16 modelShareBps;
    }

    enum Verdict {
        UNKNOWN,
        SAME,
        DIFF,
        UNDETERMINED
    }

    function registry() external view returns (IAntseedRegistry);
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    function firstRewardedEpoch() external view returns (uint256);
    function approvedVerifiers(address verifier) external view returns (bool);

    /// @notice Maximum verifier credit weight per epoch, stored in six-decimal USD micros.
    /// @dev One credit equals $1 = 1_000_000 units; for example, $1.20 = 1_200_000 units.
    function maxCreditUsdMicrosPerVerifierPerEpoch() external view returns (uint64);

    function setVerifier(address verifier, bool approved) external;
    function setMaxCreditUsdMicrosPerVerifierPerEpoch(uint64 maximum) external;

    /// @notice Submits all audited seller results for one model as the verifier credit weight.
    /// @dev `evidenceHash` is the canonical hash of the model bundle evidence and doubles as the
    ///      replay-protection key. `evidenceUri` optionally locates the public evidence package.
    ///      `totalAuditCostUsdMicros` preserves fractional credits exactly; no whole-dollar rounding occurs.
    function submitVerificationBundle(
        uint256 expectedEpoch,
        uint64 totalAuditCostUsdMicros,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external;

    function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool);

    function epochCreditUsdMicros(uint256 epoch, address verifier) external view returns (uint256);
    function epochTotalCreditUsdMicros(uint256 epoch) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16);

    function claimVerifierReward(uint256 epoch) external;
    function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount);
    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256);
    function verifierEpochBudget(uint256 epoch) external view returns (uint256);
    function verifierEpochTotalCreditUsdMicros(uint256 epoch) external view returns (uint256);
    function epochRemainderSettled(uint256 epoch) external view returns (bool);
}
