// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract MockWashTradingStatusRegistry is IAntseedWashTradingStatus {
    bool public backfillComplete;
    bool public revertReads;
    mapping(address seller => uint16 ratioBps) private ratios;

    function setBackfillComplete(bool complete) external {
        backfillComplete = complete;
    }

    function setRatio(address seller, uint16 ratioBps) external {
        ratios[seller] = ratioBps;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function isSellerWashTradingFlagged(address seller) external view returns (bool) {
        if (revertReads) revert("wash-trading registry unavailable");
        return ratios[seller] > 0;
    }

    function washRatioBps(address seller) external view returns (uint16) {
        if (revertReads) revert("wash-trading registry unavailable");
        return ratios[seller];
    }
}

contract AntseedWashTradingRewardPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);

    MockWashTradingStatusRegistry internal registry;
    AntseedWashTradingRewardPolicy internal policy;

    function setUp() public {
        registry = new MockWashTradingStatusRegistry();
        policy = new AntseedWashTradingRewardPolicy(address(registry));
    }

    function test_rewardsStayFrozenBeforeBackfillCompletion() public view {
        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.retainedSellerRewardsBps(SELLER), 0);
    }

    function test_unprovenSellerCanUseBothRewardRoutesAfterCompletion() public {
        registry.setBackfillComplete(true);
        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.retainedSellerRewardsBps(SELLER), 10_000);
    }

    function test_provenSellerUsesProportionalLockedRoute() public {
        registry.setBackfillComplete(true);
        registry.setRatio(SELLER, 2_500);
        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.retainedSellerRewardsBps(SELLER), 2_500);
    }

    function test_sellerAtThresholdRemainsFullyFrozen() public {
        registry.setBackfillComplete(true);
        registry.setRatio(SELLER, policy.penaltyThetaBps());
        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.retainedSellerRewardsBps(SELLER), 0);
    }

    function test_dependencyFailureFailsClosedByReverting() public {
        registry.setBackfillComplete(true);
        registry.setRevertReads(true);
        vm.expectRevert("wash-trading registry unavailable");
        policy.canClaimSellerUnlocked(SELLER);
    }

    function test_constructorRejectsInvalidStatus() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(0));
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(1));
    }

    function test_productionConfigurationRemainsDisabled() public view {
        assertFalse(policy.configurationFinalized());
    }
}
