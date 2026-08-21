// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract MockWashTradingStatusRegistry is IAntseedWashTradingStatus {
    mapping(address seller => bool flagged) private sellerFlags;
    bool public revertReads;

    function setWashTradingFlag(address seller, bool flagged) external {
        sellerFlags[seller] = flagged;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function isSellerWashTradingFlagged(address seller) external view returns (bool) {
        if (revertReads) revert("wash-trading registry unavailable");
        return sellerFlags[seller];
    }
}

contract AntseedWashTradingRewardPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);
    uint256 internal constant LOCKED = 100 ether;

    MockWashTradingStatusRegistry internal registry;
    AntseedWashTradingRewardPolicy internal policy;

    function setUp() public {
        registry = new MockWashTradingStatusRegistry();
        policy = new AntseedWashTradingRewardPolicy(address(registry));
    }

    function test_unflaggedSellerCanUseBothRewardRoutes() public view {
        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), LOCKED);
    }

    function test_flaggedSellerIsBlockedOnBothRewardRoutes() public {
        registry.setWashTradingFlag(SELLER, true);

        assertFalse(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), 0);
    }

    function test_dependencyFailureFailsClosed() public {
        registry.setRevertReads(true);

        vm.expectRevert("wash-trading registry unavailable");
        policy.canClaimSellerUnlocked(SELLER);
        vm.expectRevert("wash-trading registry unavailable");
        policy.claimableSellerRewards(SELLER, LOCKED);
    }

    function test_constructorRejectsZeroRegistry() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(0));
    }

    function test_constructorRejectsCodeLessRegistry() public {
        vm.expectRevert(AntseedWashTradingRewardPolicy.InvalidAddress.selector);
        new AntseedWashTradingRewardPolicy(address(1));
    }
}
