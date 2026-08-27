// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedVerificationStatus {
    /// @notice Number of distinct verifiers with at least one active DIFF verdict for the agent.
    function activeAgentDiffVerifierCount(uint256 agentId) external view returns (uint256);

    /// @notice Number of distinct verifiers with an active DIFF verdict for one service.
    function activeServiceDiffVerifierCount(uint256 agentId, bytes32 serviceHash) external view returns (uint256);

    /// @notice Latest verdict encoded with the IAntseedVerification.Verdict enum values.
    function latestVerifierVerdict(uint256 agentId, bytes32 serviceHash, address verifier)
        external
        view
        returns (uint8);
}
