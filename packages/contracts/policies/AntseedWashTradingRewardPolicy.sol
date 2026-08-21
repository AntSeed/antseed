// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract AntseedWashTradingRewardPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy {
    IAntseedWashTradingStatus public immutable washTradingStatus;

    error InvalidAddress();

    constructor(address washTradingStatus_) {
        if (washTradingStatus_ == address(0) || washTradingStatus_.code.length == 0) revert InvalidAddress();
        washTradingStatus = IAntseedWashTradingStatus(washTradingStatus_);
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        return washTradingStatus.isSellerWashTradingFlagged(seller) ? 0 : lockedAmount;
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        return !washTradingStatus.isSellerWashTradingFlagged(seller);
    }
}
