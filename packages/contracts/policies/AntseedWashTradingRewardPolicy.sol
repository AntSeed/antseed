// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";
import { WashPenaltyMath } from "./WashPenaltyMath.sol";

contract AntseedWashTradingRewardPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy {
    IAntseedWashTradingStatus public immutable washTradingStatus;

    error InvalidAddress();

    constructor(address washTradingStatus_) {
        if (washTradingStatus_ == address(0) || washTradingStatus_.code.length == 0) revert InvalidAddress();
        washTradingStatus = IAntseedWashTradingStatus(washTradingStatus_);
    }

    function retainedSellerRewardsBps(address seller) external view returns (uint16 retainedBps) {
        if (!washTradingStatus.backfillComplete()) return 0;
        return WashPenaltyMath.retainedBps(washTradingStatus.washRatioBps(seller));
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        return washTradingStatus.backfillComplete() && washTradingStatus.washRatioBps(seller) == 0;
    }

    function configurationFinalized() external pure returns (bool) {
        return WashPenaltyMath.configurationFinalized();
    }

    function penaltyThetaBps() external pure returns (uint16) {
        return WashPenaltyMath.thetaBps();
    }
}
