// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedP0Registry } from "../interfaces/IAntseedP0Registry.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";

contract AntseedWashTradingRewardPolicy is IAntseedSellerClaimPolicy, IAntseedSellerUnlockPolicy {
    IAntseedP0Registry public immutable washTradingRegistry;

    error InvalidAddress();

    constructor(address washTradingRegistry_) {
        if (washTradingRegistry_ == address(0) || washTradingRegistry_.code.length == 0) revert InvalidAddress();
        washTradingRegistry = IAntseedP0Registry(washTradingRegistry_);
    }

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        return washTradingRegistry.isSellerP0(seller) ? 0 : lockedAmount;
    }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        return !washTradingRegistry.isSellerP0(seller);
    }
}
