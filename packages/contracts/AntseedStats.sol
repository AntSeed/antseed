// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";

/**
 * @title AntseedStats
 * @notice Factual per-agent channel metrics, keyed by ERC-8004 agentId.
 *         Only the Channels contract can write; anyone can read.
 */
contract AntseedStats is IAntseedStats, Ownable {
    IAntseedRegistry public registry;

    mapping(uint256 => AgentStats) private _stats;

    error NotAuthorized();
    error InvalidAddress();

    event ChannelsContractSet(address indexed channelsContract);

    modifier onlyChannels() {
        if (msg.sender != registry.channels()) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

    function updateStats(uint256 agentId, StatsUpdate calldata update) external onlyChannels {
        AgentStats storage s = _stats[agentId];
        if (update.updateType == 0) {
            // Channel complete (close) — increment channelCount
            s.channelCount++;
            s.totalVolumeUsdc += update.volumeUsdc;
            s.totalInputTokens += update.inputTokens;
            s.totalOutputTokens += update.outputTokens;
            s.totalLatencyMs += update.latencyMs;
            s.totalRequestCount += update.requestCount;
            s.lastSettledAt = uint64(block.timestamp);
        } else if (update.updateType == 1) {
            // Ghost (seller disappeared)
            s.ghostCount++;
        } else if (update.updateType == 2) {
            // Partial settlement — accumulate volume/tokens but NOT channelCount
            s.totalVolumeUsdc += update.volumeUsdc;
            s.totalInputTokens += update.inputTokens;
            s.totalOutputTokens += update.outputTokens;
            s.totalLatencyMs += update.latencyMs;
            s.totalRequestCount += update.requestCount;
            s.lastSettledAt = uint64(block.timestamp);
        }
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
