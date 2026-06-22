// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedFreeUsage {
    enum ChannelStatus {
        None,
        Active,
        Closed
    }

    struct AgentStats {
        uint64 channelCount;
        uint64 lastSettledAt;
    }

    function activeChannelCount(address seller) external view returns (uint256);
    function channels(bytes32 channelId) external view returns (
        address buyer,
        address seller,
        uint256 latestSequence,
        bytes32 metadataHash,
        uint256 deadline,
        uint256 updatedAt,
        uint256 closedAt,
        ChannelStatus status
    );
    function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32);
    function getAgentStats(uint256 agentId) external view returns (AgentStats memory);

    function open(address buyer, bytes32 salt, uint256 deadline, bytes calldata buyerSig) external;

    function record(
        bytes32 channelId,
        uint256 sequence,
        bytes calldata metadata,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function close(
        bytes32 channelId,
        uint256 sequence,
        bytes calldata metadata,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;
}
