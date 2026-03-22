// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedSubPool.sol";
import "../AntseedIdentity.sol";
import "../MockUSDC.sol";

// ═══════════════════════════════════════════════════════════════════
//                       SHARED BASE SETUP
// ═══════════════════════════════════════════════════════════════════

abstract contract AntseedSubPoolTestBase is Test {
    AntseedSubPool public pool;
    AntseedIdentity public identity;
    MockUSDC public usdc;
    address public fakeEscrow;

    address public owner;
    address public buyer;
    address public buyer2;
    address public seller1;
    address public seller2;
    address public seller3;

    bytes32 public seller1PeerId = keccak256("seller1");
    bytes32 public seller2PeerId = keccak256("seller2");
    bytes32 public seller3PeerId = keccak256("seller3");

    uint256 public constant MONTHLY_FEE = 30_000_000; // 30 USDC
    uint256 public constant DAILY_BUDGET = 100_000; // 100k tokens/day

    function setUp() public virtual {
        owner = address(this);
        buyer = address(0xB0B);
        buyer2 = address(0xB0B2);
        seller1 = address(0x100);
        seller2 = address(0x200);
        seller3 = address(0x300);

        // Deploy
        usdc = new MockUSDC();
        identity = new AntseedIdentity();
        pool = new AntseedSubPool(address(usdc), address(identity));

        // Use a fake escrow address so we can prank updateReputation calls
        fakeEscrow = address(0xE5C);
        identity.setEscrowContract(fakeEscrow);

        // Register sellers in identity
        vm.prank(seller1);
        identity.register(seller1PeerId, "");
        vm.prank(seller2);
        identity.register(seller2PeerId, "");
        vm.prank(seller3);
        identity.register(seller3PeerId, "");

        // Fund buyers
        usdc.mint(buyer, 1000_000_000); // 1000 USDC
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);

        usdc.mint(buyer2, 1000_000_000);
        vm.prank(buyer2);
        usdc.approve(address(pool), type(uint256).max);

        // Create default tier
        pool.setTier(0, MONTHLY_FEE, DAILY_BUDGET);
    }

    function _setReputation(address seller, uint64 qualifiedCount) internal {
        uint256 tokenId = identity.getTokenId(seller);
        for (uint64 i = 0; i < qualifiedCount; i++) {
            vm.prank(fakeEscrow);
            identity.updateReputation(
                tokenId,
                AntseedIdentity.ReputationUpdate({ updateType: 1, tokenVolume: 1000 })
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//                       TIER TESTS
// ═══════════════════════════════════════════════════════════════════

contract AntseedSubPoolTierTest is AntseedSubPoolTestBase {
    function test_setTier() public {
        pool.setTier(1, 50_000_000, 200_000);
        (uint256 fee, uint256 budget, bool active) = pool.getTier(1);
        assertEq(fee, 50_000_000);
        assertEq(budget, 200_000);
        assertTrue(active);
    }

    function test_setTier_updateExisting() public {
        pool.setTier(0, 60_000_000, 150_000);
        (uint256 fee, uint256 budget, bool active) = pool.getTier(0);
        assertEq(fee, 60_000_000);
        assertEq(budget, 150_000);
        assertTrue(active);
    }

    function test_setTier_revert_notOwner() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.NotOwner.selector);
        pool.setTier(1, 10_000_000, 50_000);
    }

    function test_setTier_revert_zeroFee() public {
        vm.expectRevert(AntseedSubPool.InvalidAmount.selector);
        pool.setTier(1, 0, 50_000);
    }

    function test_setTier_revert_zeroBudget() public {
        vm.expectRevert(AntseedSubPool.InvalidAmount.selector);
        pool.setTier(1, 10_000_000, 0);
    }

    function test_deactivateTier() public {
        pool.deactivateTier(0);
        (, , bool active) = pool.getTier(0);
        assertFalse(active);
    }

    function test_tierCount_increments() public {
        assertEq(pool.tierCount(), 1); // tier 0 from setUp
        pool.setTier(3, 10_000_000, 50_000);
        assertEq(pool.tierCount(), 4); // tierCount = max tierId + 1
    }
}

// ═══════════════════════════════════════════════════════════════════
//                       SUBSCRIPTION TESTS
// ═══════════════════════════════════════════════════════════════════

contract AntseedSubPoolSubscriptionTest is AntseedSubPoolTestBase {
    function test_subscribe() public {
        vm.prank(buyer);
        pool.subscribe(0);

        assertTrue(pool.isSubscriptionActive(buyer));

        uint256 balAfter = usdc.balanceOf(buyer);
        assertEq(balAfter, 1000_000_000 - MONTHLY_FEE);
    }

    function test_subscribe_revert_inactiveTier() public {
        pool.deactivateTier(0);
        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.TierNotActive.selector);
        pool.subscribe(0);
    }

    function test_subscribe_revert_alreadySubscribed() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.AlreadySubscribed.selector);
        pool.subscribe(0);
    }

    function test_subscribe_revert_insufficientBalance() public {
        address broke = address(0xDEAD);
        vm.prank(broke);
        vm.expectRevert(AntseedSubPool.TransferFailed.selector);
        pool.subscribe(0);
    }

    function test_isSubscriptionActive_afterExpiry() public {
        vm.prank(buyer);
        pool.subscribe(0);

        assertTrue(pool.isSubscriptionActive(buyer));

        // Warp past 30 days
        vm.warp(block.timestamp + 31 days);
        assertFalse(pool.isSubscriptionActive(buyer));
    }

    function test_renewSubscription() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.prank(buyer);
        pool.renewSubscription();

        // Should be active for ~60 days from start
        vm.warp(block.timestamp + 55 days);
        assertTrue(pool.isSubscriptionActive(buyer));

        vm.warp(block.timestamp + 10 days); // total ~65 days
        assertFalse(pool.isSubscriptionActive(buyer));
    }

    function test_renewSubscription_revert_notSubscribed() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.NotSubscribed.selector);
        pool.renewSubscription();
    }

    function test_renewSubscription_revert_expired() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.warp(block.timestamp + 31 days);

        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.SubscriptionExpired.selector);
        pool.renewSubscription();
    }

    function test_cancelSubscription() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.prank(buyer);
        pool.cancelSubscription();

        // Still active until expiry
        assertTrue(pool.isSubscriptionActive(buyer));
    }

    function test_cancelSubscription_revert_notSubscribed() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.NotSubscribed.selector);
        pool.cancelSubscription();
    }
}

// ═══════════════════════════════════════════════════════════════════
//                       DAILY BUDGET TESTS
// ═══════════════════════════════════════════════════════════════════

contract AntseedSubPoolBudgetTest is AntseedSubPoolTestBase {
    function test_dailyBudget_initial() public {
        vm.prank(buyer);
        pool.subscribe(0);

        uint256 remaining = pool.getRemainingDailyBudget(buyer);
        assertEq(remaining, DAILY_BUDGET);
    }

    function test_recordTokenUsage() public {
        vm.prank(buyer);
        pool.subscribe(0);

        pool.recordTokenUsage(buyer, 50_000);

        uint256 remaining = pool.getRemainingDailyBudget(buyer);
        assertEq(remaining, DAILY_BUDGET - 50_000);
    }

    function test_recordTokenUsage_revert_overBudget() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.expectRevert(AntseedSubPool.DailyBudgetExceeded.selector);
        pool.recordTokenUsage(buyer, DAILY_BUDGET + 1);
    }

    function test_dailyBudget_resets() public {
        vm.prank(buyer);
        pool.subscribe(0);

        pool.recordTokenUsage(buyer, DAILY_BUDGET);
        assertEq(pool.getRemainingDailyBudget(buyer), 0);

        // Advance 1 day
        vm.warp(block.timestamp + 1 days);
        assertEq(pool.getRemainingDailyBudget(buyer), DAILY_BUDGET);

        // Can use again after reset
        pool.recordTokenUsage(buyer, 10_000);
        assertEq(pool.getRemainingDailyBudget(buyer), DAILY_BUDGET - 10_000);
    }

    function test_dailyBudget_zeroWhenExpired() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.warp(block.timestamp + 31 days);
        assertEq(pool.getRemainingDailyBudget(buyer), 0);
    }

    function test_recordTokenUsage_revert_expired() public {
        vm.prank(buyer);
        pool.subscribe(0);

        vm.warp(block.timestamp + 31 days);

        vm.expectRevert(AntseedSubPool.SubscriptionExpired.selector);
        pool.recordTokenUsage(buyer, 1);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                       PEER OPT-IN / REVENUE TESTS
// ═══════════════════════════════════════════════════════════════════

contract AntseedSubPoolRevenueTest is AntseedSubPoolTestBase {
    function test_optIn() public {
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        assertEq(pool.getOptedInPeerCount(), 1);
    }

    function test_optIn_revert_notRegistered() public {
        address unregistered = address(0x999);
        vm.prank(unregistered);
        vm.expectRevert(AntseedSubPool.NotRegistered.selector);
        pool.optIn(1);
    }

    function test_optIn_revert_alreadyOptedIn() public {
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        vm.prank(seller1);
        vm.expectRevert(AntseedSubPool.AlreadyOptedIn.selector);
        pool.optIn(tokenId);
    }

    function test_optOut() public {
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);
        assertEq(pool.getOptedInPeerCount(), 1);

        vm.prank(seller1);
        pool.optOut(tokenId);
        assertEq(pool.getOptedInPeerCount(), 0);
    }

    function test_optOut_revert_notOptedIn() public {
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        vm.expectRevert(AntseedSubPool.NotOptedIn.selector);
        pool.optOut(tokenId);
    }

    function test_distributeRevenue_singlePeer() public {
        // Set reputation for seller1
        _setReputation(seller1, 10);

        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        // Buyer subscribes
        vm.prank(buyer);
        pool.subscribe(0);

        // Warp past epoch
        vm.warp(block.timestamp + 7 days + 1);
        pool.distributeRevenue();

        // Seller1 should get all revenue (verify via claim)
        uint256 balBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        pool.claimRevenue();
        assertEq(usdc.balanceOf(seller1) - balBefore, MONTHLY_FEE);
    }

    function test_distributeRevenue_proportionalToReputation() public {
        // seller1 gets 10 qualified signs, seller2 gets 30
        _setReputation(seller1, 10);
        _setReputation(seller2, 30);

        uint256 tokenId1 = identity.getTokenId(seller1);
        uint256 tokenId2 = identity.getTokenId(seller2);

        vm.prank(seller1);
        pool.optIn(tokenId1);
        vm.prank(seller2);
        pool.optIn(tokenId2);

        // Buyer subscribes
        vm.prank(buyer);
        pool.subscribe(0);

        // Warp past epoch
        vm.warp(block.timestamp + 7 days + 1);
        pool.distributeRevenue();

        // Verify distribution via claims (pull-based accumulator)
        uint256 bal1Before = usdc.balanceOf(seller1);
        vm.prank(seller1);
        pool.claimRevenue();
        uint256 claimed1 = usdc.balanceOf(seller1) - bal1Before;

        uint256 bal2Before = usdc.balanceOf(seller2);
        vm.prank(seller2);
        pool.claimRevenue();
        uint256 claimed2 = usdc.balanceOf(seller2) - bal2Before;

        // seller1 should get 10/40 = 25%, seller2 should get 30/40 = 75%
        assertEq(claimed1, MONTHLY_FEE * 10 / 40);
        assertEq(claimed2, MONTHLY_FEE * 30 / 40);
    }

    function test_distributeRevenue_zeroReputation() public {
        // seller1 has reputation, seller2 has none
        _setReputation(seller1, 10);
        // seller2 has 0 qualified signs (no _setReputation call)

        uint256 tokenId1 = identity.getTokenId(seller1);
        uint256 tokenId2 = identity.getTokenId(seller2);

        vm.prank(seller1);
        pool.optIn(tokenId1);
        vm.prank(seller2);
        pool.optIn(tokenId2);

        vm.prank(buyer);
        pool.subscribe(0);

        vm.warp(block.timestamp + 7 days + 1);
        pool.distributeRevenue();

        // Verify via claims: seller1 gets all, seller2 gets nothing
        uint256 bal1Before = usdc.balanceOf(seller1);
        vm.prank(seller1);
        pool.claimRevenue();
        assertEq(usdc.balanceOf(seller1) - bal1Before, MONTHLY_FEE);

        vm.prank(seller2);
        vm.expectRevert(AntseedSubPool.NothingToClaim.selector);
        pool.claimRevenue();
    }

    function test_distributeRevenue_revert_epochNotEnded() public {
        vm.expectRevert(AntseedSubPool.EpochNotEnded.selector);
        pool.distributeRevenue();
    }

    function test_distributeRevenue_noRevenue() public {
        // No subscriptions, just advance epoch
        vm.warp(block.timestamp + 7 days + 1);
        pool.distributeRevenue(); // Should not revert, just advances epoch

        assertEq(pool.currentEpoch(), 2);
    }

    function test_claimRevenue() public {
        _setReputation(seller1, 10);
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        vm.prank(buyer);
        pool.subscribe(0);

        vm.warp(block.timestamp + 7 days + 1);
        pool.distributeRevenue();

        uint256 balBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        pool.claimRevenue();
        uint256 balAfter = usdc.balanceOf(seller1);

        assertEq(balAfter - balBefore, MONTHLY_FEE);

        // Pending should be zeroed
        (,,, uint256 pending,) = pool.peerOpts(seller1);
        assertEq(pending, 0);
    }

    function test_claimRevenue_revert_nothingToClaim() public {
        _setReputation(seller1, 10);
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        vm.prank(seller1);
        vm.expectRevert(AntseedSubPool.NothingToClaim.selector);
        pool.claimRevenue();
    }

    function test_multiEpochDistribution() public {
        _setReputation(seller1, 10);
        uint256 tokenId = identity.getTokenId(seller1);
        vm.prank(seller1);
        pool.optIn(tokenId);

        // Epoch 1: buyer subscribes
        vm.prank(buyer);
        pool.subscribe(0);

        uint256 t1 = block.timestamp + 7 days + 1;
        vm.warp(t1);
        pool.distributeRevenue();

        // Epoch 2: buyer2 subscribes
        vm.prank(buyer2);
        pool.subscribe(0);

        uint256 t2 = t1 + 7 days + 1;
        vm.warp(t2);
        pool.distributeRevenue();

        // Seller should have accumulated revenue from both epochs (verify via claim)
        uint256 balBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        pool.claimRevenue();
        assertEq(usdc.balanceOf(seller1) - balBefore, MONTHLY_FEE * 2);
    }

    function test_getProjectedRevenue() public {
        _setReputation(seller1, 10);
        _setReputation(seller2, 10);

        uint256 tokenId1 = identity.getTokenId(seller1);
        uint256 tokenId2 = identity.getTokenId(seller2);

        vm.prank(seller1);
        pool.optIn(tokenId1);
        vm.prank(seller2);
        pool.optIn(tokenId2);

        vm.prank(buyer);
        pool.subscribe(0);

        // 50/50 split
        uint256 projected = pool.getProjectedRevenue(seller1);
        assertEq(projected, MONTHLY_FEE / 2);
    }

    function test_getProjectedRevenue_notOptedIn() public {
        uint256 projected = pool.getProjectedRevenue(seller1);
        assertEq(projected, 0);
    }
}

// ═══════════════════════════════════════════════════════════════════
//                       ADMIN TESTS
// ═══════════════════════════════════════════════════════════════════

contract AntseedSubPoolAdminTest is AntseedSubPoolTestBase {
    function test_setEpochDuration() public {
        pool.setEpochDuration(14 days);
        assertEq(pool.epochDuration(), 14 days);
    }

    function test_setEpochDuration_revert_notOwner() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedSubPool.NotOwner.selector);
        pool.setEpochDuration(14 days);
    }

    function test_transferOwnership() public {
        pool.transferOwnership(buyer);
        // Old owner can no longer call onlyOwner
        vm.expectRevert(AntseedSubPool.NotOwner.selector);
        pool.setEpochDuration(14 days);
    }
}
