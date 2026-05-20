// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedUsageVerification {
    struct UsageClaim {
        uint256 version;
        bytes32 channelId;
        address buyer;
        address seller;
        uint256 sellerAgentId;
        bytes32 serviceKey;
        string providerName;
        string serviceName;
        uint256 cumulativeInputTokens;
        uint256 cumulativeCachedInputTokens;
        uint256 cumulativeFreshInputTokens;
        uint256 cumulativeOutputTokens;
        uint256 cumulativeRequestCount;
        uint256 cumulativeCostUsdc;
        uint256 paymentCumulativeAmount;
    }

    struct UsageStats {
        uint256 inputTokens;
        uint256 cachedInputTokens;
        uint256 freshInputTokens;
        uint256 outputTokens;
        uint256 requestCount;
        uint256 costUsdc;
        uint256 attestationCount;
        uint256 partialRevealCount;
        uint64 lastUpdatedAt;
    }

    function currentEpoch() external view returns (uint256);
    function hashUsageClaim(UsageClaim calldata claim) external pure returns (bytes32);
    function getSellerServiceStats(uint256 sellerAgentId, bytes32 serviceKey, uint256 epoch) external view returns (UsageStats memory);
    function getBuyerServiceStats(address buyer, bytes32 serviceKey, uint256 epoch) external view returns (UsageStats memory);
}
