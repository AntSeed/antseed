// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";
import { IAntseedPointsPolicy } from "./IAntseedPointsPolicy.sol";
import { IAntseedRegistry } from "./IAntseedRegistry.sol";

interface IAntseedVerification is IAntseedPointsPolicy {
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
    function maxCreditsPerVerifierPerEpoch() external view returns (uint32);

    function setVerifier(address verifier, bool approved) external;
    function setMaxCreditsPerVerifierPerEpoch(uint32 maximum) external;

    function submitVerificationBundle(
        bytes32 bundleId,
        uint256 expectedEpoch,
        uint64 totalAuditCostUsdMicros,
        bytes32 evidenceHash,
        uint32 requestedCredits,
        VerificationResult[] calldata results
    ) external;

    function isBundleSubmitted(bytes32 bundleId) external view returns (bool);

    function epochCredits(uint256 epoch, address verifier) external view returns (uint256);
    function epochTotalCredits(uint256 epoch) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16);

    function claimVerifierReward(uint256 epoch) external;
    function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount);
    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256);
    function verifierEpochBudget(uint256 epoch) external view returns (uint256);
    function verifierEpochTotalCredits(uint256 epoch) external view returns (uint256);
    function epochRemainderSettled(uint256 epoch) external view returns (bool);
}
