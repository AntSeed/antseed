// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

/**
 * @title AntseedWashTradingSellerClaimPolicy
 * @notice Claim policy for AntseedSellerRewardsPool: a seller with a proven
 *         wash-trading loop in the registry can never release locked ANTS —
 *         `claimableSellerRewards` returns 0, so `claim()` reverts
 *         NothingToClaim. Unflagged sellers pass through to `inner` (e.g. a
 *         vesting policy), or may claim their full locked balance when no
 *         inner policy is configured.
 *
 * @dev    Stateless and immutable; wired via
 *         AntseedSellerRewardsPool.setSellerClaimPolicy. Stacking order is
 *         wash-check first so a flag always wins regardless of inner logic.
 */
contract AntseedWashTradingSellerClaimPolicy is IAntseedSellerClaimPolicy {
    IAntseedWashTradingRegistry public immutable registry;
    IAntseedSellerClaimPolicy public immutable inner;

    error ZeroAddress();

    constructor(address registry_, address inner_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IAntseedWashTradingRegistry(registry_);
        inner = IAntseedSellerClaimPolicy(inner_); // address(0) = full release
    }

    /// @inheritdoc IAntseedSellerClaimPolicy
    function claimableSellerRewards(address seller, uint256 lockedAmount)
        external
        view
        returns (uint256)
    {
        if (registry.isSellerFlagged(seller)) return 0;
        if (address(inner) == address(0)) return lockedAmount;
        return inner.claimableSellerRewards(seller, lockedAmount);
    }
}
