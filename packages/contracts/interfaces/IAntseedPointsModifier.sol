// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One independent buyer/seller points modifier evaluated by
///         AntseedPointsPolicyRegistry. A multiplier of 10_000 preserves raw
///         points, lower values reduce them, higher values boost them, and zero
///         is a hard veto. Modifiers in the same category overlap, so the
///         registry applies only the strongest modifier from that category.
interface IAntseedPointsModifier {
    function modifierCategory() external view returns (bytes32);

    function pointsMultiplierBps(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint16 sellerMultiplierBps, uint16 buyerMultiplierBps);
}
