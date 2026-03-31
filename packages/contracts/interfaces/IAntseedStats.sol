// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedStats {
    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint128 totalInputTokens;
        uint128 totalOutputTokens;
        uint64 totalLatencyMs;
        uint64 totalRequestCount;
        uint64 lastSettledAt;
    }

    struct StatsUpdate {
        uint8 updateType;     // 0 = settlement, 1 = ghost
        uint256 volumeUsdc;
        uint128 inputTokens;
        uint128 outputTokens;
        uint64 latencyMs;
        uint64 requestCount;
    }

    function updateStats(uint256 agentId, StatsUpdate calldata update) external;
    function getStats(uint256 agentId) external view returns (AgentStats memory);
}
