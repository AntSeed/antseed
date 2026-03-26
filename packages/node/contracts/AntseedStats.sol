// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedStats} from "./interfaces/IAntseedStats.sol";

/**
 * @title AntseedStats
 * @notice Factual per-agent session metrics, keyed by ERC-8004 agentId.
 *         Only the Sessions contract can write; anyone can read.
 */
contract AntseedStats is IAntseedStats, Ownable {
    address public sessionsContract;

    mapping(uint256 => AgentStats) private _stats;

    error NotAuthorized();
    error InvalidAddress();

    event SessionsContractSet(address indexed sessionsContract);

    modifier onlySessions() {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

    function updateStats(uint256 agentId, StatsUpdate calldata update) external onlySessions {
        AgentStats storage s = _stats[agentId];
        if (update.updateType == 0) {
            // Settlement
            s.sessionCount++;
            s.totalVolumeUsdc += update.volumeUsdc;
            s.totalInputTokens += update.inputTokens;
            s.totalOutputTokens += update.outputTokens;
            s.totalLatencyMs += update.latencyMs;
            s.totalRequestCount += update.requestCount;
            s.lastSettledAt = uint64(block.timestamp);
        } else if (update.updateType == 1) {
            // Ghost (seller disappeared)
            s.ghostCount++;
        }
    }

    function getStats(uint256 agentId) external view returns (AgentStats memory) {
        return _stats[agentId];
    }

    // ─── Admin ────────────────────────────────────────────────────────────

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
        emit SessionsContractSet(_sessions);
    }
}
