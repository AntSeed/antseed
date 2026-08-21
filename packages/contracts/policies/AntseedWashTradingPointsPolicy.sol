// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract AntseedWashTradingPointsPolicy is IAntseedPointsPenaltyPolicy {
    bytes32 public constant PENALTY_CATEGORY = keccak256("wash-trading");

    IAntseedWashTradingStatus public immutable washTradingStatus;

    error InvalidAddress();

    constructor(address washTradingStatus_) {
        if (washTradingStatus_ == address(0) || washTradingStatus_.code.length == 0) revert InvalidAddress();
        washTradingStatus = IAntseedWashTradingStatus(washTradingStatus_);
    }

    function penaltyCategory() external pure returns (bytes32) {
        return PENALTY_CATEGORY;
    }

    function penaltyBps(bytes32, address, address seller, uint256)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
    {
        if (washTradingStatus.isSellerWashTradingFlagged(seller)) return (10_000, 10_000);
        return (0, 0);
    }
}
