// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedPointsPolicy {
    function points(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints);
}
