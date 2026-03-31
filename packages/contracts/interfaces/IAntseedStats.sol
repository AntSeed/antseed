// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedStats {
    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint64 totalRequestCount;
        uint64 lastSettledAt;
    }

    function recordClose(
        bytes32 channelId,
        uint256 agentId,
        address buyer,
        uint256 cumulativeUsdc,
        bytes calldata metadata
    ) external;

    function recordGhost(uint256 agentId) external;

    /// @notice Record a timed-out channel that had partial settlements.
    ///         Captures the verified volume without unverifiable metadata.
    function recordTimeout(uint256 agentId, uint256 settledUsdc) external;

    function getStats(uint256 agentId) external view returns (AgentStats memory);
}
