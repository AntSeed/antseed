// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { IAntseedP0Registry } from "../interfaces/IAntseedP0Registry.sol";
import { AntseedWashTradingRewardPolicy } from "../policies/AntseedWashTradingRewardPolicy.sol";

contract MockWashTradingStatusRegistry is IAntseedP0Registry {
    mapping(address seller => bool p0) private sellerP0;
    bool public revertReads;

    function setP0(address seller, bool p0) external {
        sellerP0[seller] = p0;
    }

    function setRevertReads(bool value) external {
        revertReads = value;
    }

    function isSellerP0(address seller) external view returns (bool) {
        if (revertReads) revert("wash-trading registry unavailable");
        return sellerP0[seller];
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

    function test_nonP0SellerCanUseBothRewardRoutes() public view {
        assertTrue(policy.canClaimSellerUnlocked(SELLER));
        assertEq(policy.claimableSellerRewards(SELLER, LOCKED), LOCKED);
    }

    function test_p0SellerIsBlockedOnBothRewardRoutes() public {
        registry.setP0(SELLER, true);

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
