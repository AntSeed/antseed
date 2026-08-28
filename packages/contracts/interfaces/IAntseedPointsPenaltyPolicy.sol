// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedPointsPenaltyPolicy {
    function penaltyCategory() external view returns (bytes32);

    function penaltyBps(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps);
}
