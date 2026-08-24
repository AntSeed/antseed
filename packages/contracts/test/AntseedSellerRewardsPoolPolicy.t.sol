// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

contract RetainedBpsPolicyMock is IAntseedSellerClaimPolicy {
    mapping(address seller => uint16 retainedBps) public retained;

    function setRetainedBps(address seller, uint16 retainedBps) external {
        retained[seller] = retainedBps;
    }

    function retainedSellerRewardsBps(address seller) external view returns (uint16) {
        return retained[seller];
    }
}

contract AntseedSellerRewardsPoolPolicyTest is Test {
    address internal constant SELLER = address(0xA11CE);

    ANTSToken internal token;
    AntseedRegistry internal registry;
    AntseedSellerRewardsPool internal pool;
    RetainedBpsPolicyMock internal policy;

    function setUp() public {
        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        token.setRegistry(address(registry));
        pool = new AntseedSellerRewardsPool(address(registry));
        policy = new RetainedBpsPolicyMock();
        pool.setSellerClaimPolicy(address(policy));
        token.setTransferWhitelist(address(pool), true);
    }

    function test_cumulativeEntitlementPreventsRepeatedClaimLeakage() public {
        _record(100 ether);
        policy.setRetainedBps(SELLER, 5_000);

        vm.prank(SELLER);
        pool.claim(SELLER);
        assertEq(token.balanceOf(SELLER), 50 ether);
        assertEq(pool.cumulativePaidRewards(SELLER), 50 ether);

        vm.prank(SELLER);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(SELLER);

        _record(100 ether);
        vm.prank(SELLER);
        pool.claim(SELLER);
        assertEq(token.balanceOf(SELLER), 100 ether);
        assertEq(pool.cumulativeRecordedRewards(SELLER), 200 ether);
        assertEq(pool.cumulativePaidRewards(SELLER), 100 ether);
        assertEq(pool.lockedRewards(SELLER), 100 ether);
    }

    function test_laterHigherPenaltyStopsPayoutWithoutClawback() public {
        _record(200 ether);
        policy.setRetainedBps(SELLER, 5_000);
        vm.prank(SELLER);
        pool.claim(SELLER);
        assertEq(token.balanceOf(SELLER), 100 ether);

        policy.setRetainedBps(SELLER, 2_500);
        vm.prank(SELLER);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(SELLER);
        assertEq(token.balanceOf(SELLER), 100 ether);
        assertEq(pool.lockedRewards(SELLER), 100 ether);
    }

    function _record(uint256 amount) internal {
        token.mint(address(pool), amount);
        pool.recordLockedReward(SELLER, amount);
    }
}
