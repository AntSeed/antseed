// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedStats {
    struct BuyerMetadataStats {
        uint256 totalInputTokens;
        uint256 totalOutputTokens;
        uint256 totalRequestCount;
        uint64 lastUpdatedAt;
    }

    function getBuyerMetadataStats(uint256 agentId, address buyer) external view returns (BuyerMetadataStats memory);
    function recordMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        bytes calldata metadata
    ) external;
}
