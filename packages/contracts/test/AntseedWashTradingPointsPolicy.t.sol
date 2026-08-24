// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

contract WashTradingStatusMock {
    bool public backfillComplete;
    mapping(address seller => uint16 ratioBps) public washRatioBps;

    function setBackfillComplete(bool complete) external {
        backfillComplete = complete;
    }

    function setRatio(address seller, uint16 ratioBps) external {
        washRatioBps[seller] = ratioBps;
    }

    function isSellerWashTradingFlagged(address seller) external view returns (bool) {
        return washRatioBps[seller] > 0;
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

    function test_pointsPassThroughAndBuyerIsNeverPenalizedBeforeCompletion() public view {
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 0);
        assertEq(buyerPenaltyBps, 0);
    }

    function test_unprovenSellerHasNoPenaltyAfterCompletion() public {
        status.setBackfillComplete(true);
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 0);
        assertEq(buyerPenaltyBps, 0);
    }

    function test_provenSellerGetsProportionalPenaltyButBuyerGetsNone() public {
        status.setBackfillComplete(true);
        status.setRatio(SELLER, 2_500);
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 7_500);
        assertEq(buyerPenaltyBps, 0);
    }

    function test_sellerAtThresholdGetsFullPenalty() public {
        status.setBackfillComplete(true);
        status.setRatio(SELLER, policy.penaltyThetaBps());
        (uint16 sellerPenaltyBps, uint16 buyerPenaltyBps) = policy.penaltyBps(bytes32(0), address(0), SELLER, 1_000);
        assertEq(sellerPenaltyBps, 10_000);
        assertEq(buyerPenaltyBps, 0);
    }

    function test_productionConfigurationRemainsDisabled() public view {
        assertFalse(policy.configurationFinalized());
    }
}
