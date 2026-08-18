// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Top-level points hook consumed by usage accounting and legacy
///         emissions contracts. New usage deployments install
///         AntseedPointsPolicyRegistry here and register penalty policies
///         in that contract.
interface IAntseedPointsPolicy {
    function points(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints);
}
