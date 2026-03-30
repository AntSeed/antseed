// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";

/**
 * @title AntseedStats
 * @notice Per-agent channel metrics, keyed by ERC-8004 agentId.
 *         Stores verifiable aggregates (volume, channels, ghosts).
 *         Emits per-channel metrics (tokens, latency) as events for off-chain indexing.
 *         Only the Channels contract can write; anyone can read.
 */
contract AntseedStats is IAntseedStats, Ownable {
    IAntseedRegistry public registry;

    mapping(uint256 => AgentStats) private _stats;
    /// @dev Track last cumulative requestCount per channel to compute deltas
    mapping(bytes32 => uint64) private _channelRequestCount;

    error NotAuthorized();
    error InvalidAddress();

    event ChannelsContractSet(address indexed channelsContract);

    /// @notice Per-session cumulative metrics for off-chain indexing.
    ///         All values are cumulative for the channel — indexers take the latest
    ///         event per channelId. Tokens and latency are buyer-reported (unverifiable).
    event ChannelMetrics(
        bytes32 indexed channelId,
        uint256 indexed agentId,
        address indexed buyer,
        uint256 cumulativeUsdc,
        uint128 cumulativeInputTokens,
        uint128 cumulativeOutputTokens,
        uint64 cumulativeLatencyMs,
        uint64 cumulativeRequestCount
    );

    modifier onlyChannels() {
        if (msg.sender != registry.channels()) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

    function updateStats(
        bytes32 channelId,
        uint256 agentId,
        address buyer,
        uint8 updateType,
        uint256 deltaUsdc,
        uint256 cumulativeUsdc,
        bytes calldata metadata
    ) external onlyChannels {
        AgentStats storage s = _stats[agentId];

        if (updateType == 0) {
            // Channel complete (close)
            s.channelCount++;
        } else if (updateType == 1) {
            // Ghost (seller disappeared)
            s.ghostCount++;
            return;
        }
        // updateType 0 (close) and 2 (partial settlement) accumulate metrics

        (uint256 inputTokens, uint256 outputTokens, uint256 latencyMs, uint256 requestCount) =
            abi.decode(metadata, (uint256, uint256, uint256, uint256));

        uint64 cumulativeReqCount = uint64(requestCount);
        uint64 prevReqCount = _channelRequestCount[channelId];
        _channelRequestCount[channelId] = cumulativeReqCount;

        s.totalVolumeUsdc += deltaUsdc;
        s.totalRequestCount += cumulativeReqCount - prevReqCount;
        s.lastSettledAt = uint64(block.timestamp);

        emit ChannelMetrics(
            channelId,
            agentId,
            buyer,
            cumulativeUsdc,
            uint128(inputTokens),
            uint128(outputTokens),
            uint64(latencyMs),
            uint64(requestCount)
        );
    }

    function getStats(uint256 agentId) external view returns (AgentStats memory) {
        return _stats[agentId];
    }

    // ─── Admin ────────────────────────────────────────────────────────────

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }
}
