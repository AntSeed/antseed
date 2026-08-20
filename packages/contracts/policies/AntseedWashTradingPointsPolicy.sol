// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedPointsPenaltyPolicy } from "../interfaces/IAntseedPointsPenaltyPolicy.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";

/**
 * @title AntseedWashTradingPointsPolicy
 * @notice Applies proven seller and captive-buyer penalties to future points.
 *
 * @dev    Registered in AntseedPointsPolicyRegistry. The policy is deliberately
 *         two bounded mapping reads with no value amplification,
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
    function penaltyCategory() external pure returns (bytes32) {
        return PENALTY_CATEGORY;
    }

    /// @inheritdoc IAntseedPointsPenaltyPolicy
    function penaltyBps(bytes32, address buyer, address seller, uint256)
        external
        view
        returns (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps)
    {
        sellerPenaltyBps = registry.sellerPenaltyBps(seller);
        buyerPenaltyBps = registry.buyerPenaltyBps(buyer);
    }
}
