// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";

/**
 * @title AntseedStats
 * @notice Per-agent channel metrics, keyed by ERC-8004 agentId.
 *         Stores verifiable aggregates (volume, channels, ghosts) — updated only on close.
 *         Emits per-channel cumulative metrics as events for off-chain indexing.
 *         Only the Channels contract can write; anyone can read.
 */
contract AntseedStats is IAntseedStats, Ownable {
    IAntseedRegistry public registry;

    mapping(uint256 => AgentStats) private _stats;

    error NotAuthorized();
    error InvalidAddress();

    /// @notice Per-channel cumulative metrics for off-chain indexing.
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

    /// @notice Record channel close. Cumulative values go to storage + event.
    function recordClose(
        bytes32 channelId,
        uint256 agentId,
        address buyer,
        uint256 cumulativeUsdc,
        bytes calldata metadata
    ) external onlyChannels {
        AgentStats storage s = _stats[agentId];
        s.channelCount++;

        (uint256 inputTokens, uint256 outputTokens, uint256 latencyMs, uint256 requestCount) =
            abi.decode(metadata, (uint256, uint256, uint256, uint256));

        s.totalVolumeUsdc += cumulativeUsdc;
        s.totalRequestCount += uint64(requestCount);
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

    /// @notice Record ghost (seller abandoned without settling).
    function recordGhost(uint256 agentId) external onlyChannels {
        _stats[agentId].ghostCount++;
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
