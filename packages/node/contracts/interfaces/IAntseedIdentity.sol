// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedIdentity {
    struct ProvenReputation {
        uint64 firstSignCount;
        uint64 qualifiedProvenSignCount;
        uint64 unqualifiedProvenSignCount;
        uint64 ghostCount;
        uint256 totalQualifiedTokenVolume;
        uint64 lastProvenAt;
    }

    struct ReputationUpdate {
        uint8 updateType;
        uint256 tokenVolume;
    }

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external;
    function getReputation(uint256 tokenId) external view returns (ProvenReputation memory);
    function getTokenId(address addr) external view returns (uint256);
    function isRegistered(address addr) external view returns (bool);
}
