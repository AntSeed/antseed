// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedChannels {
    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint64 lastSettledAt;
    }

    function getAgentStats(uint256 agentId) external view returns (AgentStats memory);
    function activeChannelCount(address seller) external view returns (uint256);
    function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32);

    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function topUp(
        bytes32 channelId,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external;

    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external;

    function abandon(bytes32 channelId) external;

    function requestClose(bytes32 channelId) external;

    function withdraw(bytes32 channelId) external;
}
