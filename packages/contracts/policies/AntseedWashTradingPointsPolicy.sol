// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";
import { WashPenaltyMath } from "./WashPenaltyMath.sol";

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
        if (!washTradingStatus.backfillComplete()) return (0, 0);
        uint16 retained = WashPenaltyMath.retainedBps(washTradingStatus.washRatioBps(seller));
        return (uint16(10_000 - retained), 0);
    }

    function configurationFinalized() external pure returns (bool) {
        return WashPenaltyMath.configurationFinalized();
    }

    function penaltyThetaBps() external pure returns (uint16) {
        return WashPenaltyMath.thetaBps();
    }
}
