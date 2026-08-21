// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One independent buyer/seller points penalty evaluated by
///         AntseedPointsPolicyRegistry. Policies in the same category overlap:
///         the registry applies only the largest penalty from that category.
interface IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external view returns (bytes32);

    function penaltyBps(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps);
}
