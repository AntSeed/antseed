// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";

/**
 * @title AntseedSellerUnlockPolicy
 * @notice Transparent policy used by AntseedEmissionsV2 to decide whether a
 *         seller's ANTS emissions may be claimed immediately instead of being
 *         routed into the locked seller rewards pool.
 *
 *         Eligibility is explicit per seller/proxy address. Any seller not
 *         explicitly marked eligible by the owner remains locked by default.
 */
contract AntseedSellerUnlockPolicy is IAntseedSellerUnlockPolicy, Ownable {
    mapping(address => bool) public eligibleSeller;

    event SellerEligibilitySet(address indexed seller, bool eligible);

    error InvalidAddress();

    constructor() Ownable(msg.sender) { }

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        return eligibleSeller[seller];
    }

    function setSellerEligibility(address seller, bool eligible) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        eligibleSeller[seller] = eligible;
        emit SellerEligibilitySet(seller, eligible);
    }
}
