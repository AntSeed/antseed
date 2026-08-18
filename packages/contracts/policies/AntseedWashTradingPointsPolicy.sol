// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

/**
 * @title AntseedWashTradingPointsPolicy
 * @notice Points-penalty policy: buyer/seller edges with a proven funding loop
 *         receive a 10,000 BPS penalty and accrue zero reward points. Every
 *         other edge receives no wash-trading penalty.
 *
 * @dev    Registered in AntseedPointsPolicyRegistry. The policy is deliberately
 *         a single mapping read with no revert path and no value amplification,
 *         per the stack's never-block-settlement invariant. Stateless: a new
 *         wash-trading registry means deploying a new policy.
 */
contract AntseedWashTradingPointsPolicy is IAntseedPointsPenaltyPolicy {
    bytes32 public constant PENALTY_CATEGORY = keccak256("wash-trading");

    IAntseedWashTradingRegistry public immutable registry;

    error ZeroAddress();

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IAntseedWashTradingRegistry(registry_);
    }

    /// @inheritdoc IAntseedPointsPenaltyPolicy
    /// @dev One proven loop poisons the seller's volume entirely and forever:
    ///      zero points on BOTH sides of every edge, proven or not. Buyers
    ///      routing to a flagged seller earn nothing either — flagged-seller
    ///      volume must not farm rewards through unproven sock-puppet wallets,
    ///      and honest buyers are incentivized to route elsewhere. A proven
    ///      edge always sets the seller flag, so one read decides.
    function penaltyCategory() external pure returns (bytes32) {
        return PENALTY_CATEGORY;
    }

    /// @inheritdoc IAntseedPointsPenaltyPolicy
    function penaltyBps(bytes32, address, address seller, uint256)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
    {
        if (registry.isSellerFlagged(seller)) return (10_000, 10_000);
        return (0, 0);
    }
}
