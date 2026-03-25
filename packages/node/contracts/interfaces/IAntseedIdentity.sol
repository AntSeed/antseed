// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedIdentity {
    struct Reputation {
        uint64 sessionCount;
        uint64 ghostCount;
        uint256 totalSettledVolume;
        uint128 totalInputTokens;
        uint128 totalOutputTokens;
        uint64 lastSettledAt;
    }

    struct ReputationUpdate {
        uint8 updateType;
        uint256 settledVolume;
        uint128 inputTokens;
        uint128 outputTokens;
    }

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external;
    function getReputation(uint256 tokenId) external view returns (Reputation memory);
    function getTokenId(address addr) external view returns (uint256);
    function isRegistered(address addr) external view returns (bool);
}
