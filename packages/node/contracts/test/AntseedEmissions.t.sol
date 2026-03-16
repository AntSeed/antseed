// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ANTSToken.sol";
import "../AntseedEmissions.sol";

contract AntseedEmissionsTest is Test {
    ANTSToken public token;
    AntseedEmissions public emissions;

    address public seller1 = address(0x10);
    address public seller2 = address(0x20);
    address public buyer1 = address(0x30);
    address public buyer2 = address(0x40);
    address public reserveDest = address(0x50);

    uint256 constant INITIAL_EMISSION = 1000 ether; // 1000 ANTS per epoch
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        token = new ANTSToken();
        emissions = new AntseedEmissions(address(token), INITIAL_EMISSION, EPOCH_DURATION);
        token.setEmissionsContract(address(emissions));
        // Allow test contract to call accrue functions
        emissions.setEscrowContract(address(this));
        emissions.setReserveDestination(reserveDest);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_initialState() public view {
        assertEq(emissions.currentEpoch(), 0);
        assertEq(emissions.INITIAL_EMISSION(), INITIAL_EMISSION);
        assertEq(emissions.EPOCH_DURATION(), EPOCH_DURATION);
        assertEq(emissions.SELLER_SHARE_PCT(), 65);
        assertEq(emissions.BUYER_SHARE_PCT(), 25);
        assertEq(emissions.RESERVE_SHARE_PCT(), 10);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 15);
        assertEq(emissions.HALVING_INTERVAL(), 26);
        // Emission rate = INITIAL_EMISSION / EPOCH_DURATION
        assertEq(emissions.currentEmissionRate(), INITIAL_EMISSION / EPOCH_DURATION);
    }

    function test_advanceEpoch() public {
        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();
        assertEq(emissions.currentEpoch(), 1);
    }

    function test_advanceEpoch_revert_tooEarly() public {
        vm.warp(block.timestamp + EPOCH_DURATION - 1);
        vm.expectRevert(AntseedEmissions.EpochNotEnded.selector);
        emissions.advanceEpoch();
    }

    function test_halvingSchedule() public {
        uint256 halvingInterval = emissions.HALVING_INTERVAL();
        uint256 t = block.timestamp;
        // Advance through one full halving interval
        for (uint256 i = 0; i < halvingInterval; i++) {
            t += EPOCH_DURATION;
            vm.warp(t);
            emissions.advanceEpoch();
        }
        // After 26 epochs, emission should be halved
        assertEq(emissions.currentEpoch(), halvingInterval);
        // Rate should be half of initial
        uint256 expectedRate = (INITIAL_EMISSION / 2) / EPOCH_DURATION;
        assertEq(emissions.currentEmissionRate(), expectedRate);
    }

    function test_multipleHalvings() public {
        uint256 halvingInterval = emissions.HALVING_INTERVAL();
        uint256 t = block.timestamp;
        // 4 halvings = 104 epochs
        for (uint256 i = 0; i < halvingInterval * 4; i++) {
            t += EPOCH_DURATION;
            vm.warp(t);
            emissions.advanceEpoch();
        }
        // Emission should be INITIAL / 16
        uint256 expectedRate = (INITIAL_EMISSION / 16) / EPOCH_DURATION;
        assertEq(emissions.currentEmissionRate(), expectedRate);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  REWARD ACCUMULATION TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_accrueSellerPoints() public {
        emissions.accrueSellerPoints(seller1, 100);
        assertEq(emissions.totalSellerPoints(), 100);

        // Wait half the epoch
        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        // Check pending rewards
        (uint256 sellerPending,) = emissions.pendingEmissions(seller1);
        // Expected: (emissionRate * SELLER_SHARE_PCT/100 * elapsed) for the sole seller
        uint256 elapsed = EPOCH_DURATION / 2;
        uint256 sellerEmRate = (emissions.currentEmissionRate() * 65) / 100;
        uint256 expected = sellerEmRate * elapsed;
        assertApproxEqAbs(sellerPending, expected, 1e6); // small rounding tolerance
    }

    function test_accrueSellerPoints_revert_notEscrow() public {
        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.NotAuthorized.selector);
        emissions.accrueSellerPoints(seller1, 100);
    }

    function test_accrueBuyerPoints() public {
        emissions.accrueBuyerPoints(buyer1, 200);
        assertEq(emissions.totalBuyerPoints(), 200);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        (, uint256 buyerPending) = emissions.pendingEmissions(buyer1);
        uint256 elapsed = EPOCH_DURATION / 2;
        uint256 buyerEmRate = (emissions.currentEmissionRate() * 25) / 100;
        uint256 expected = buyerEmRate * elapsed;
        assertApproxEqAbs(buyerPending, expected, 1e6);
    }

    function test_accrueBuyerPoints_revert_notEscrow() public {
        vm.prank(buyer1);
        vm.expectRevert(AntseedEmissions.NotAuthorized.selector);
        emissions.accrueBuyerPoints(buyer1, 100);
    }

    function test_multipleParticipants() public {
        // Seller1 gets 300 points, seller2 gets 100 points
        emissions.accrueSellerPoints(seller1, 300);
        emissions.accrueSellerPoints(seller2, 100);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        (uint256 s1Pending,) = emissions.pendingEmissions(seller1);
        (uint256 s2Pending,) = emissions.pendingEmissions(seller2);

        // seller1 should get 3x what seller2 gets (75% vs 25%)
        assertApproxEqRel(s1Pending, s2Pending * 3, 1e15); // 0.1% tolerance
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_claimEmissions_seller() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        (uint256 rawSeller,) = emissions.pendingEmissions(seller1);
        assertTrue(rawSeller > 0);

        // Account for per-seller cap
        uint256 maxSellerReward = (INITIAL_EMISSION * 65 * 15) / 10000;
        uint256 expectedSeller = rawSeller > maxSellerReward ? maxSellerReward : rawSeller;

        vm.prank(seller1);
        emissions.claimEmissions();

        assertApproxEqAbs(token.balanceOf(seller1), expectedSeller, 1e6);
    }

    function test_claimEmissions_buyer() public {
        emissions.accrueBuyerPoints(buyer1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        (, uint256 expectedBuyer) = emissions.pendingEmissions(buyer1);
        assertTrue(expectedBuyer > 0);

        vm.prank(buyer1);
        emissions.claimEmissions();

        assertEq(token.balanceOf(buyer1), expectedBuyer);
    }

    function test_claimEmissions_both() public {
        // Same address is both seller and buyer
        emissions.accrueSellerPoints(seller1, 100);
        emissions.accrueBuyerPoints(seller1, 200);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);

        (uint256 sellerPending, uint256 buyerPending) = emissions.pendingEmissions(seller1);
        uint256 expectedTotal = sellerPending + buyerPending;
        assertTrue(expectedTotal > 0);

        vm.prank(seller1);
        emissions.claimEmissions();

        // May be capped, so balance <= expectedTotal
        assertTrue(token.balanceOf(seller1) > 0);
    }

    function test_sellerCap() public {
        // Give seller1 a massive amount of points so they exceed the 15% cap
        emissions.accrueSellerPoints(seller1, 1_000_000);

        // Wait full epoch
        vm.warp(block.timestamp + EPOCH_DURATION);

        // Get pending before claim
        (uint256 rawSellerPending,) = emissions.pendingEmissions(seller1);

        // The cap: INITIAL_EMISSION * SELLER_SHARE_PCT * MAX_SELLER_SHARE_PCT / 10000
        uint256 maxSellerReward = (INITIAL_EMISSION * 65 * 15) / 10000;

        // If raw pending exceeds cap, claim should be capped
        if (rawSellerPending > maxSellerReward) {
            uint256 reserveBefore = emissions.reserveAccumulated();

            vm.prank(seller1);
            emissions.claimEmissions();

            // Excess should go to reserve
            uint256 reserveAfter = emissions.reserveAccumulated();
            assertTrue(reserveAfter > reserveBefore);
        }
    }

    function test_pendingEmissions_matchesClaim() public {
        emissions.accrueSellerPoints(seller1, 500);
        emissions.accrueBuyerPoints(seller1, 300);

        vm.warp(block.timestamp + EPOCH_DURATION / 4);

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(seller1);
        uint256 expectedTotal = pendSeller + pendBuyer;

        // Cap the seller portion the same way claimEmissions does
        uint256 maxSellerReward = (INITIAL_EMISSION * 65 * 15) / 10000;
        if (pendSeller > maxSellerReward) {
            expectedTotal = maxSellerReward + pendBuyer;
        }

        vm.prank(seller1);
        emissions.claimEmissions();

        assertApproxEqAbs(token.balanceOf(seller1), expectedTotal, 1e6);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        RESERVE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_reserveFlush() public {
        // Advance an epoch to accumulate reserve
        emissions.accrueSellerPoints(seller1, 100);
        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 reserveAmount = emissions.reserveAccumulated();
        assertTrue(reserveAmount > 0);

        // Expected reserve: INITIAL_EMISSION * RESERVE_SHARE_PCT / 100
        uint256 expectedReserve = (INITIAL_EMISSION * 10) / 100;
        assertEq(reserveAmount, expectedReserve);

        emissions.flushReserve();
        assertEq(token.balanceOf(reserveDest), expectedReserve);
        assertEq(emissions.reserveAccumulated(), 0);
    }

    function test_reserveFlush_revert_noDestination() public {
        // Deploy new emissions without setting reserve destination
        AntseedEmissions em2 = new AntseedEmissions(address(token), INITIAL_EMISSION, EPOCH_DURATION);
        // Note: can't actually mint since token's emissions contract is already set
        // But we can still test the revert
        vm.expectRevert(AntseedEmissions.NoReserveDestination.selector);
        em2.flushReserve();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CONFIG TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_sharePercentages() public {
        emissions.setSharePercentages(70, 20, 10);
        assertEq(emissions.SELLER_SHARE_PCT(), 70);
        assertEq(emissions.BUYER_SHARE_PCT(), 20);
        assertEq(emissions.RESERVE_SHARE_PCT(), 10);
    }

    function test_sharePercentages_revert_invalidSum() public {
        vm.expectRevert(AntseedEmissions.InvalidShareSum.selector);
        emissions.setSharePercentages(60, 20, 10);
    }

    function test_setEscrowContract_onlyOwner() public {
        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.NotOwner.selector);
        emissions.setEscrowContract(address(0x99));
    }

    function test_setConstant() public {
        emissions.setConstant(keccak256("MAX_SELLER_SHARE_PCT"), 20);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 20);
    }

    function test_transferOwnership() public {
        emissions.transferOwnership(seller1);
        assertEq(emissions.owner(), seller1);

        vm.prank(seller1);
        emissions.setEscrowContract(address(0x99));
        assertEq(emissions.escrowContract(), address(0x99));
    }
}
