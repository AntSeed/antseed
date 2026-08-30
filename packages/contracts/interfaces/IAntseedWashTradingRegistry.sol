// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    struct PeriodSummary {
        uint128 totalVolume;
        uint128 maxProvenWashVolume;
        uint32 findingCount;
        uint64 firstAcceptedAt;
    }

    function latestOffenseEpoch(uint256 agentId) external view returns (uint64);
    function latestOffenseAcceptedEpoch(uint256 agentId) external view returns (uint64);
    function hasOffense(uint256 agentId) external view returns (bool);

    function periodSummary(uint256 agentId, bytes32 sourceId, uint64 periodStartBlock, uint64 periodEndBlock)
        external
        view
        returns (PeriodSummary memory);
}
