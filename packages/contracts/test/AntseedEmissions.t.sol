// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ANTSToken.sol";
import "../AntseedEmissions.sol";
import "../AntseedRegistry.sol";

contract AntseedEmissionsTest is Test {
    ANTSToken public token;
    AntseedEmissions public emissions;
    AntseedRegistry public antseedRegistry;

    address public seller1 = address(0x10);
    address public seller2 = address(0x20);
    address public buyer1 = address(0x30);
    address public buyer2 = address(0x40);
    address public reserveDest = address(0x50);

    uint256 constant INITIAL_EMISSION = 1000 ether; // 1000 ANTS per epoch
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        token = new ANTSToken();
        antseedRegistry = new AntseedRegistry();
        antseedRegistry.setChannels(address(this));
        antseedRegistry.setAntsToken(address(token));

        emissions = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

        antseedRegistry.setEmissions(address(emissions));
        token.setRegistry(address(antseedRegistry));

        emissions.setReserveDestination(reserveDest);
    }

    // ── Helpers ──

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;
        return epochs;
    }

    function _epochRange(uint256 from, uint256 to) internal pure returns (uint256[] memory) {
        uint256[] memory epochs = new uint256[](to - from);
        for (uint256 i = 0; i < epochs.length; i++) {
            epochs[i] = from + i;
        }
        return epochs;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INITIAL STATE
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
        assertEq(emissions.currentEmissionRate(), INITIAL_EMISSION / EPOCH_DURATION);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH TESTS
    // ═══════════════════════════════════════════════════════════════════

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

    function test_advanceMultipleEpochs() public {
        vm.warp(block.timestamp + EPOCH_DURATION * 3);
        emissions.advanceEpoch();
        assertEq(emissions.currentEpoch(), 3);
        assertTrue(emissions.epochFinalized(0));
        assertTrue(emissions.epochFinalized(1));
        assertTrue(emissions.epochFinalized(2));
    }

    function test_halvingSchedule() public {
        uint256 halvingInterval = emissions.HALVING_INTERVAL();
        vm.warp(block.timestamp + EPOCH_DURATION * halvingInterval);
        emissions.advanceEpoch();

        assertEq(emissions.currentEpoch(), halvingInterval);
        uint256 expectedRate = (INITIAL_EMISSION / 2) / EPOCH_DURATION;
        assertEq(emissions.currentEmissionRate(), expectedRate);
    }

    function test_multipleHalvings() public {
        uint256 halvingInterval = emissions.HALVING_INTERVAL();
        // Advance 4 halving intervals (104 epochs) — but max 52 per call
        vm.warp(block.timestamp + EPOCH_DURATION * halvingInterval * 2 + 1);
        emissions.advanceEpoch(); // epochs 0-51
        vm.warp(block.timestamp + EPOCH_DURATION * halvingInterval * 2 + 1);
        emissions.advanceEpoch(); // epochs 52-103

        assertEq(emissions.currentEpoch(), halvingInterval * 4);
        uint256 expectedRate = (INITIAL_EMISSION / 16) / EPOCH_DURATION;
        assertEq(emissions.currentEmissionRate(), expectedRate);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINT ACCRUAL
    // ═══════════════════════════════════════════════════════════════════

    function test_accrueSellerPoints() public {
        emissions.accrueSellerPoints(seller1, 100);

        assertEq(emissions.epochTotalSellerPoints(0), 100);
        assertEq(emissions.userSellerPoints(seller1, 0), 100);
    }

    function test_accrueSellerPoints_revert_notChannels() public {
        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.NotAuthorized.selector);
        emissions.accrueSellerPoints(seller1, 100);
    }

    function test_accrueBuyerPoints() public {
        emissions.accrueBuyerPoints(buyer1, 200);

        assertEq(emissions.epochTotalBuyerPoints(0), 200);
        assertEq(emissions.userBuyerPoints(buyer1, 0), 200);
    }

    function test_accrueBuyerPoints_revert_notChannels() public {
        vm.prank(buyer1);
        vm.expectRevert(AntseedEmissions.NotAuthorized.selector);
        emissions.accrueBuyerPoints(buyer1, 100);
    }

    function test_accruePoints_advancesEpochLazily() public {
        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.accrueSellerPoints(seller1, 50);

        assertEq(emissions.currentEpoch(), 1);
        assertTrue(emissions.epochFinalized(0));
        assertEq(emissions.userSellerPoints(seller1, 1), 50);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function test_claimSeller_singleEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);

        // Advance past epoch 0
        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 expectedSellerBudget = (INITIAL_EMISSION * 65) / 100;

        // Sole seller gets full budget (capped at MAX_SELLER_SHARE_PCT)
        uint256 maxPerSeller = (expectedSellerBudget * 15) / 100;
        uint256 expected = expectedSellerBudget > maxPerSeller ? maxPerSeller : expectedSellerBudget;

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), expected);
    }

    function test_claimBuyer_singleEpoch() public {
        emissions.accrueBuyerPoints(buyer1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 expectedBuyerBudget = (INITIAL_EMISSION * 25) / 100;

        vm.prank(buyer1);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(buyer1), expectedBuyerBudget);
    }

    function test_claimBoth_singleEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);
        emissions.accrueBuyerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        assertTrue(token.balanceOf(seller1) > 0);
    }

    function test_claim_revert_currentEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.EpochIsCurrentOrFuture.selector);
        emissions.claimEmissions(_epochList(0));
    }

    function test_claim_revert_doubleClaim() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.EpochAlreadyClaimed.selector);
        emissions.claimEmissions(_epochList(0));
    }

    function test_claim_revert_futureEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        // Epoch 1 is current (not yet ended) — cannot claim
        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.EpochIsCurrentOrFuture.selector);
        emissions.claimEmissions(_epochList(1));
    }

    // ═══════════════════════════════════════════════════════════════════
    //               PROPORTIONAL DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════

    function test_proportionalSellers() public {
        // seller1: 300 points, seller2: 100 points → 75%/25% split
        emissions.accrueSellerPoints(seller1, 300);
        emissions.accrueSellerPoints(seller2, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 sellerBudget = (INITIAL_EMISSION * 65) / 100;
        uint256 maxPerSeller = (sellerBudget * 15) / 100;

        uint256 raw1 = (300 * sellerBudget) / 400; // 75%
        uint256 raw2 = (100 * sellerBudget) / 400; // 25%

        uint256 expected1 = raw1 > maxPerSeller ? maxPerSeller : raw1;
        uint256 expected2 = raw2 > maxPerSeller ? maxPerSeller : raw2;

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));
        vm.prank(seller2);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), expected1);
        assertEq(token.balanceOf(seller2), expected2);
    }

    function test_proportionalBuyers() public {
        emissions.accrueBuyerPoints(buyer1, 600);
        emissions.accrueBuyerPoints(buyer2, 400);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 buyerBudget = (INITIAL_EMISSION * 25) / 100;

        vm.prank(buyer1);
        emissions.claimEmissions(_epochList(0));
        vm.prank(buyer2);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(buyer1), (600 * buyerBudget) / 1000);
        assertEq(token.balanceOf(buyer2), (400 * buyerBudget) / 1000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               POINTS EXPIRE — NO CARRY-OVER
    // ═══════════════════════════════════════════════════════════════════

    function test_pointsDontCarryOver() public {
        uint256 t = block.timestamp;
        // Seller works in epoch 0
        emissions.accrueSellerPoints(seller1, 100);

        // Advance to epoch 1 — seller1 does nothing
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.advanceEpoch();

        // Seller2 works in epoch 1
        emissions.accrueSellerPoints(seller2, 100);

        // Advance to epoch 2
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.advanceEpoch();

        // seller1 has 0 points in epoch 1
        assertEq(emissions.userSellerPoints(seller1, 1), 0);

        // seller2 gets full epoch 1 budget (seller1 earns nothing from epoch 1)
        uint256 sellerBudget1 = emissions.epochSellerBudget(1);
        uint256 maxPerSeller = (sellerBudget1 * 15) / 100;
        uint256 expected2 = sellerBudget1 > maxPerSeller ? maxPerSeller : sellerBudget1;

        vm.prank(seller2);
        emissions.claimEmissions(_epochList(1));

        assertEq(token.balanceOf(seller2), expected2);
    }

    function test_inactiveSellerEarnsNothing() public {
        // Seller1 works in epoch 0 only
        emissions.accrueSellerPoints(seller1, 1000);

        // Advance 3 epochs without seller1 working
        vm.warp(block.timestamp + EPOCH_DURATION * 3);
        emissions.advanceEpoch();

        // seller1 has no points in epochs 1 and 2
        assertEq(emissions.userSellerPoints(seller1, 1), 0);
        assertEq(emissions.userSellerPoints(seller1, 2), 0);

        // Trying to claim epoch 1 gives nothing
        (uint256 pendSeller,) = emissions.pendingEmissions(seller1, _epochList(1));
        assertEq(pendSeller, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               CROSS-EPOCH CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function test_claimMultipleEpochs() public {
        uint256 t = block.timestamp;
        // Work in epoch 0
        emissions.accrueSellerPoints(seller1, 100);

        // Advance to epoch 1, work again
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.accrueSellerPoints(seller1, 200);

        // Advance to epoch 2
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.advanceEpoch();

        // Claim both epochs at once
        vm.prank(seller1);
        emissions.claimEmissions(_epochRange(0, 2));

        assertTrue(token.balanceOf(seller1) > 0);
        assertTrue(emissions.userEpochClaimed(seller1, 0));
        assertTrue(emissions.userEpochClaimed(seller1, 1));
    }

    function test_claimAfterLongAbsence() public {
        // Work in epoch 0
        emissions.accrueSellerPoints(seller1, 100);

        // Advance 10 epochs
        vm.warp(block.timestamp + EPOCH_DURATION * 10);
        emissions.advanceEpoch();

        // Can still claim epoch 0
        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        assertTrue(token.balanceOf(seller1) > 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               EMPTY EPOCH ROLLOVER
    // ═══════════════════════════════════════════════════════════════════

    function test_emptyEpochRollsForward() public {
        uint256 t = block.timestamp;
        // Epoch 0: nobody works
        // Epoch 1: seller1 works
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.accrueSellerPoints(seller1, 100);

        // Advance to epoch 2
        t += EPOCH_DURATION + 1;
        vm.warp(t);
        emissions.advanceEpoch();

        // Epoch 1 should have epoch 0's seller budget + epoch 1's own
        uint256 epoch0Emission = INITIAL_EMISSION; // epoch 0
        uint256 epoch1Emission = INITIAL_EMISSION; // same halving period
        uint256 expectedBudget =
            (epoch0Emission * 65) / 100 + (epoch1Emission * 65) / 100;

        assertEq(emissions.epochSellerBudget(1), expectedBudget);
    }

    function test_multipleEmptyEpochsRollover() public {
        // Epochs 0, 1, 2 empty. Epoch 3: seller works.
        vm.warp(block.timestamp + EPOCH_DURATION * 3);
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        // Epoch 3 should have 4 epochs worth of seller budget (0+1+2+3)
        uint256 expectedBudget = (INITIAL_EMISSION * 65 * 4) / 100;
        assertEq(emissions.epochSellerBudget(3), expectedBudget);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               SELLER CAP
    // ═══════════════════════════════════════════════════════════════════

    function test_sellerCap() public {
        // One seller with all points — should be capped at 15%
        emissions.accrueSellerPoints(seller1, 1_000_000);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 sellerBudget = (INITIAL_EMISSION * 65) / 100;
        uint256 maxPerSeller = (sellerBudget * 15) / 100;

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), maxPerSeller);
    }

    function test_sellerCap_excessGoesToReserve() public {
        emissions.accrueSellerPoints(seller1, 1_000_000);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 reserveBefore = emissions.reserveAccumulated();

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        uint256 reserveAfter = emissions.reserveAccumulated();
        assertTrue(reserveAfter > reserveBefore);
    }

    function test_sellerCap_notTriggeredWithManySellers() public {
        // 10 sellers with equal points — each gets 10%, below 15% cap
        for (uint256 i = 1; i <= 10; i++) {
            emissions.accrueSellerPoints(address(uint160(i)), 100);
        }

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 sellerBudget = (INITIAL_EMISSION * 65) / 100;
        uint256 expectedEach = sellerBudget / 10;

        vm.prank(address(uint160(1)));
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(address(uint160(1))), expectedEach);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function test_reserveAccumulates() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 expectedReserve = (INITIAL_EMISSION * 10) / 100;
        assertEq(emissions.reserveAccumulated(), expectedReserve);
    }

    function test_reserveFlush() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        uint256 reserveAmount = emissions.reserveAccumulated();
        assertTrue(reserveAmount > 0);

        emissions.flushReserve();
        assertEq(token.balanceOf(reserveDest), reserveAmount);
        assertEq(emissions.reserveAccumulated(), 0);
    }

    function test_reserveFlush_revert_noDestination() public {
        AntseedRegistry reg2 = new AntseedRegistry();
        reg2.setChannels(address(this));
        reg2.setAntsToken(address(token));
        AntseedEmissions em2 = new AntseedEmissions(address(reg2), INITIAL_EMISSION, EPOCH_DURATION);

        vm.expectRevert(AntseedEmissions.NoReserveDestination.selector);
        em2.flushReserve();
    }

    // ═══════════════════════════════════════════════════════════════════
    //               PENDING EMISSIONS VIEW
    // ═══════════════════════════════════════════════════════════════════

    function test_pendingEmissions_matchesClaim() public {
        emissions.accrueSellerPoints(seller1, 500);
        emissions.accrueBuyerPoints(seller1, 300);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(seller1, _epochList(0));
        uint256 expectedTotal = pendSeller + pendBuyer;
        assertTrue(expectedTotal > 0);

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), expectedTotal);
    }

    function test_pendingEmissions_zeroAfterClaim() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.advanceEpoch();

        vm.prank(seller1);
        emissions.claimEmissions(_epochList(0));

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(seller1, _epochList(0));
        assertEq(pendSeller, 0);
        assertEq(pendBuyer, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               CONFIG
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

    function test_setRegistry_onlyOwner() public {
        vm.prank(seller1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller1));
        emissions.setRegistry(address(0x99));
    }

    function test_setMaxSellerSharePct() public {
        emissions.setMaxSellerSharePct(20);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 20);
    }

    function test_transferOwnership() public {
        emissions.transferOwnership(seller1);
        assertEq(emissions.owner(), seller1);

        AntseedRegistry newRegistry = new AntseedRegistry();
        newRegistry.setChannels(address(0x99));
        newRegistry.setAntsToken(address(token));

        vm.prank(seller1);
        emissions.setRegistry(address(newRegistry));
        assertEq(address(emissions.registry()), address(newRegistry));
    }
}
