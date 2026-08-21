// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

contract WashTradingStatusMock {
    mapping(address seller => bool flagged) public isSellerWashTradingFlagged;

    function setFlagged(address seller, bool flagged) external {
        isSellerWashTradingFlagged[seller] = flagged;
    }
}

contract WashTradingPointsPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);

    WashTradingStatusMock internal status;
    AntseedWashTradingPointsPolicy internal policy;

    function setUp() public {
        status = new WashTradingStatusMock();
        policy = new AntseedWashTradingPointsPolicy(address(status));
    }

    function test_unflaggedSellerHasNoPenalty() public view {
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 0);
        assertEq(buyerPenaltyBps, 0);
    }

    function test_flaggedSellerHardVetoesBothPointSides() public {
        status.setFlagged(SELLER, true);
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 10_000);
        assertEq(buyerPenaltyBps, 10_000);
    }
}
