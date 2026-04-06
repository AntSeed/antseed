// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ANTSToken.sol";
import "../AntseedEmissions.sol";
import "../AntseedRegistry.sol";

/// @dev Minimal mock Deposits that only supports getOperator for emission tests.
contract MockDepositsForEmissions {
    mapping(address => address) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}

contract AntseedEmissionsTest is Test {
    ANTSToken public token;
    AntseedEmissions public emissions;
    AntseedRegistry public antseedRegistry;
    MockDepositsForEmissions public mockDeposits;

    address public seller1 = address(0x10);
    address public seller2 = address(0x20);
    address public buyer1 = address(0x30);
    address public buyer2 = address(0x40);
    address public reserveDest = address(0x50);
    address public operator1 = address(0x60);
    address public operator2 = address(0x70);

    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        token = new ANTSToken();
        antseedRegistry = new AntseedRegistry();
        mockDeposits = new MockDepositsForEmissions();
        antseedRegistry.setChannels(address(this));
        antseedRegistry.setDeposits(address(mockDeposits));
        antseedRegistry.setAntsToken(address(token));

        emissions = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

        antseedRegistry.setEmissions(address(emissions));
        antseedRegistry.setProtocolReserve(reserveDest);
        token.setRegistry(address(antseedRegistry));

        // Set operators for buyers
        mockDeposits.setOperator(buyer1, operator1);
        mockDeposits.setOperator(buyer2, operator2);
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
        assertEq(emissions.SELLER_SHARE_PCT(), 50);
        assertEq(emissions.BUYER_SHARE_PCT(), 20);
        assertEq(emissions.RESERVE_SHARE_PCT(), 15);
        assertEq(emissions.TEAM_SHARE_PCT(), 15);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 49);
        assertEq(emissions.HALVING_INTERVAL(), 104);
        assertEq(emissions.currentEmissionRate(), INITIAL_EMISSION / EPOCH_DURATION);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH DERIVATION
    // ═══════════════════════════════════════════════════════════════════

    function test_currentEpoch_derivedFromTimestamp() public {
        assertEq(emissions.currentEpoch(), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(emissions.currentEpoch(), 1);

        vm.warp(block.timestamp + EPOCH_DURATION * 9);
        assertEq(emissions.currentEpoch(), 10);
    }

    function test_halvingSchedule() public view {
        assertEq(emissions.getEpochEmission(0), INITIAL_EMISSION);
        assertEq(emissions.getEpochEmission(103), INITIAL_EMISSION); // last epoch before halving
        assertEq(emissions.getEpochEmission(104), INITIAL_EMISSION / 2);
        assertEq(emissions.getEpochEmission(208), INITIAL_EMISSION / 4);
        assertEq(emissions.getEpochEmission(416), INITIAL_EMISSION / 16);
    }

    function test_currentEmissionRate_afterHalving() public {
        vm.warp(block.timestamp + EPOCH_DURATION * 104);
        uint256 expectedRate = (INITIAL_EMISSION / 2) / EPOCH_DURATION;
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

    function test_accruePoints_goesToCorrectEpoch() public {
        emissions.accrueSellerPoints(seller1, 50);
        assertEq(emissions.userSellerPoints(seller1, 0), 50);

        vm.warp(block.timestamp + EPOCH_DURATION);
        emissions.accrueSellerPoints(seller1, 75);
        assertEq(emissions.userSellerPoints(seller1, 1), 75);
        // Epoch 0 unchanged
        assertEq(emissions.userSellerPoints(seller1, 0), 50);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function test_claimSeller_singleEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxPerSeller = (sellerBudget * 49) / 100;
        uint256 expected = sellerBudget > maxPerSeller ? maxPerSeller : sellerBudget;

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), expected);
    }

    function test_claimBuyer_singleEpoch() public {
        emissions.accrueBuyerPoints(buyer1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 expectedBuyerBudget = (INITIAL_EMISSION * 20) / 100;

        // Operator claims on behalf of buyer — tokens go to operator
        vm.prank(operator1);
        emissions.claimBuyerEmissions(buyer1, _epochList(0));

        assertEq(token.balanceOf(operator1), expectedBuyerBudget);
        assertEq(token.balanceOf(buyer1), 0);
    }

    function test_claimBoth_singleEpoch() public {
        // seller1 is both seller and buyer — set an operator for seller1 as buyer
        mockDeposits.setOperator(seller1, operator1);
        emissions.accrueSellerPoints(seller1, 100);
        emissions.accrueBuyerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        // Seller claims seller rewards directly
        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));
        assertTrue(token.balanceOf(seller1) > 0);

        // Operator claims buyer rewards — goes to operator, not seller1
        vm.prank(operator1);
        emissions.claimBuyerEmissions(seller1, _epochList(0));
        assertTrue(token.balanceOf(operator1) > 0);
    }

    function test_claim_revert_currentEpoch() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.EpochNotFinalized.selector);
        emissions.claimSellerEmissions(_epochList(0));
    }

    function test_claim_revert_futureEpoch() public {
        vm.prank(seller1);
        vm.expectRevert(AntseedEmissions.EpochNotFinalized.selector);
        emissions.claimSellerEmissions(_epochList(5));
    }

    function test_claim_duplicateEpochIsIdempotent() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        // First claim
        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));
        uint256 balanceAfterFirst = token.balanceOf(seller1);

        // Second claim of same epoch — should be a no-op (continue), not revert
        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));
        assertEq(token.balanceOf(seller1), balanceAfterFirst);
    }

    function test_claim_skipsZeroActivityEpochs() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION * 3);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochRange(0, 3));

        assertTrue(emissions.sellerEpochClaimed(seller1, 0));
        assertFalse(emissions.sellerEpochClaimed(seller1, 1));
        assertFalse(emissions.sellerEpochClaimed(seller1, 2));
    }

    function test_claim_emptyEpochArray() public {
        uint256[] memory empty = new uint256[](0);
        vm.prank(seller1);
        emissions.claimSellerEmissions(empty);
        assertEq(token.balanceOf(seller1), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               PROPORTIONAL DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════

    function test_proportionalSellers() public {
        emissions.accrueSellerPoints(seller1, 300);
        emissions.accrueSellerPoints(seller2, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxPerSeller = (sellerBudget * 49) / 100;

        uint256 raw1 = (300 * sellerBudget) / 400;
        uint256 raw2 = (100 * sellerBudget) / 400;

        uint256 expected1 = raw1 > maxPerSeller ? maxPerSeller : raw1;
        uint256 expected2 = raw2 > maxPerSeller ? maxPerSeller : raw2;

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));
        vm.prank(seller2);
        emissions.claimSellerEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), expected1);
        assertEq(token.balanceOf(seller2), expected2);
    }

    function test_proportionalBuyers() public {
        emissions.accrueBuyerPoints(buyer1, 600);
        emissions.accrueBuyerPoints(buyer2, 400);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 buyerBudget = (INITIAL_EMISSION * 20) / 100;

        vm.prank(operator1);
        emissions.claimBuyerEmissions(buyer1, _epochList(0));
        vm.prank(operator2);
        emissions.claimBuyerEmissions(buyer2, _epochList(0));

        // Tokens go to operators, not buyers
        assertEq(token.balanceOf(operator1), (600 * buyerBudget) / 1000);
        assertEq(token.balanceOf(operator2), (400 * buyerBudget) / 1000);
        assertEq(token.balanceOf(buyer1), 0);
        assertEq(token.balanceOf(buyer2), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               POINTS EXPIRE — NO CARRY-OVER
    // ═══════════════════════════════════════════════════════════════════

    function test_pointsDontCarryOver() public {
        uint256 t = block.timestamp;
        emissions.accrueSellerPoints(seller1, 100);

        t += EPOCH_DURATION;
        vm.warp(t);
        emissions.accrueSellerPoints(seller2, 100);

        t += EPOCH_DURATION;
        vm.warp(t);

        // seller1 has 0 points in epoch 1
        assertEq(emissions.userSellerPoints(seller1, 1), 0);

        // seller2 gets full epoch 1 seller budget (capped)
        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxPerSeller = (sellerBudget * 49) / 100;
        uint256 expected = sellerBudget > maxPerSeller ? maxPerSeller : sellerBudget;

        vm.prank(seller2);
        emissions.claimSellerEmissions(_epochList(1));

        assertEq(token.balanceOf(seller2), expected);
    }

    function test_inactiveSellerEarnsNothing() public {
        emissions.accrueSellerPoints(seller1, 1000);

        vm.warp(block.timestamp + EPOCH_DURATION * 3);

        assertEq(emissions.userSellerPoints(seller1, 1), 0);
        assertEq(emissions.userSellerPoints(seller1, 2), 0);

        (uint256 pendSeller,) = emissions.pendingEmissions(seller1, _epochList(1));
        assertEq(pendSeller, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               CROSS-EPOCH CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function test_claimMultipleEpochs() public {
        uint256 t = block.timestamp;
        emissions.accrueSellerPoints(seller1, 100);

        t += EPOCH_DURATION;
        vm.warp(t);
        emissions.accrueSellerPoints(seller1, 200);

        t += EPOCH_DURATION;
        vm.warp(t);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochRange(0, 2));

        assertTrue(token.balanceOf(seller1) > 0);
        assertTrue(emissions.sellerEpochClaimed(seller1, 0));
        assertTrue(emissions.sellerEpochClaimed(seller1, 1));
    }

    function test_claimAfterLongAbsence() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION * 52);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        assertTrue(token.balanceOf(seller1) > 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               SELLER CAP
    // ═══════════════════════════════════════════════════════════════════

    function test_sellerCap() public {
        emissions.accrueSellerPoints(seller1, 1_000_000);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 maxPerSeller = (sellerBudget * 49) / 100;

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        assertEq(token.balanceOf(seller1), maxPerSeller);
    }

    function test_sellerCap_excessGoesToReserve() public {
        emissions.accrueSellerPoints(seller1, 1_000_000);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 reserveBefore = emissions.reserveAccumulated();

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        assertTrue(emissions.reserveAccumulated() > reserveBefore);
    }

    function test_sellerCap_notTriggeredWithManySellers() public {
        for (uint256 i = 1; i <= 10; i++) {
            emissions.accrueSellerPoints(address(uint160(i)), 100);
        }

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 sellerBudget = (INITIAL_EMISSION * 50) / 100;
        uint256 expectedEach = sellerBudget / 10;

        vm.prank(address(uint160(1)));
        emissions.claimSellerEmissions(_epochList(0));

        assertEq(token.balanceOf(address(uint160(1))), expectedEach);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function test_reserveAccumulates_onClaim() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        assertEq(emissions.reserveAccumulated(), 0);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        // Reserve should have 10% of epoch emission
        uint256 expectedReserve = (INITIAL_EMISSION * 15) / 100;
        // Plus any seller cap excess
        uint256 reserveAmount = emissions.reserveAccumulated();
        assertTrue(reserveAmount >= expectedReserve);
    }

    function test_reserveAccumulates_onlyOncePerEpoch() public {
        // Use 10 sellers so each gets 10% (below 15% cap = no excess)
        for (uint256 i = 1; i <= 10; i++) {
            emissions.accrueSellerPoints(address(uint160(i)), 100);
        }

        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.prank(address(uint160(1)));
        emissions.claimSellerEmissions(_epochList(0));
        uint256 reserveAfterFirst = emissions.reserveAccumulated();

        vm.prank(address(uint160(2)));
        emissions.claimSellerEmissions(_epochList(0));
        uint256 reserveAfterSecond = emissions.reserveAccumulated();

        // Reserve share (10%) added on first claim only
        uint256 baseReserve = (INITIAL_EMISSION * 15) / 100;
        assertEq(reserveAfterFirst, baseReserve);
        // Second claim adds no additional reserve (no cap excess with 10% each)
        assertEq(reserveAfterSecond, baseReserve);
    }

    function test_reserveFlush() public {
        emissions.accrueSellerPoints(seller1, 100);
        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        uint256 reserveAmount = emissions.reserveAccumulated();
        assertTrue(reserveAmount > 0);

        emissions.flushReserve();
        assertEq(token.balanceOf(reserveDest), reserveAmount);
        assertEq(emissions.reserveAccumulated(), 0);
    }

    function test_reserveFlush_revert_zeroBalance() public {
        vm.expectRevert(AntseedEmissions.NoReserve.selector);
        emissions.flushReserve();
    }

    function test_reserveFlush_revert_noProtocolReserve() public {
        AntseedRegistry reg2 = new AntseedRegistry();
        reg2.setChannels(address(this));
        reg2.setAntsToken(address(token));
        AntseedEmissions em2 = new AntseedEmissions(address(reg2), INITIAL_EMISSION, EPOCH_DURATION);

        vm.expectRevert(AntseedEmissions.NoProtocolReserve.selector);
        em2.flushReserve();
    }

    // ═══════════════════════════════════════════════════════════════════
    //               PENDING EMISSIONS VIEW
    // ═══════════════════════════════════════════════════════════════════

    function test_pendingEmissions_matchesClaim() public {
        emissions.accrueSellerPoints(seller1, 500);
        emissions.accrueBuyerPoints(seller1, 300);

        vm.warp(block.timestamp + EPOCH_DURATION);

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(seller1, _epochList(0));
        assertTrue(pendSeller > 0);
        assertTrue(pendBuyer > 0);

        // Seller claims seller rewards directly
        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));
        assertEq(token.balanceOf(seller1), pendSeller);

        // Operator claims buyer rewards for seller1
        mockDeposits.setOperator(seller1, operator1);
        vm.prank(operator1);
        emissions.claimBuyerEmissions(seller1, _epochList(0));
        assertEq(token.balanceOf(operator1), pendBuyer);
    }

    function test_pendingEmissions_zeroAfterClaim() public {
        emissions.accrueSellerPoints(seller1, 100);

        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.prank(seller1);
        emissions.claimSellerEmissions(_epochList(0));

        (uint256 pendSeller,) = emissions.pendingEmissions(seller1, _epochList(0));
        assertEq(pendSeller, 0);
    }

    function test_pendingEmissions_currentEpochReturnsZero() public {
        emissions.accrueSellerPoints(seller1, 100);

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(seller1, _epochList(0));
        assertEq(pendSeller, 0);
        assertEq(pendBuyer, 0);
    }

    function test_pendingEmissions_buyerOnlyEpoch() public {
        emissions.accrueBuyerPoints(buyer1, 500);

        vm.warp(block.timestamp + EPOCH_DURATION);

        (uint256 pendSeller, uint256 pendBuyer) = emissions.pendingEmissions(buyer1, _epochList(0));
        assertEq(pendSeller, 0);
        assertTrue(pendBuyer > 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               CONFIG
    // ═══════════════════════════════════════════════════════════════════

    function test_sharePercentages() public {
        emissions.setSharePercentages(60, 20, 10, 10);
        assertEq(emissions.SELLER_SHARE_PCT(), 60);
        assertEq(emissions.BUYER_SHARE_PCT(), 20);
        assertEq(emissions.RESERVE_SHARE_PCT(), 10);
        assertEq(emissions.TEAM_SHARE_PCT(), 10);
    }

    function test_sharePercentages_revert_invalidSum() public {
        vm.expectRevert(AntseedEmissions.InvalidShareSum.selector);
        emissions.setSharePercentages(60, 20, 10, 5);
    }

    function test_setRegistry_onlyOwner() public {
        vm.prank(seller1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller1));
        emissions.setRegistry(address(0x99));
    }

    function test_setRegistry() public {
        AntseedRegistry newReg = new AntseedRegistry();
        newReg.setChannels(address(this));
        newReg.setAntsToken(address(token));
        emissions.setRegistry(address(newReg));
        assertEq(address(emissions.registry()), address(newReg));
    }

    function test_setRegistry_revert_zeroAddress() public {
        vm.expectRevert(AntseedEmissions.InvalidAddress.selector);
        emissions.setRegistry(address(0));
    }

    function test_setMaxSellerSharePct() public {
        emissions.setMaxSellerSharePct(20);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 20);
    }

    function test_setMaxSellerSharePct_allowsZero() public {
        emissions.setMaxSellerSharePct(0);
        assertEq(emissions.MAX_SELLER_SHARE_PCT(), 0);
    }

    function test_setMaxSellerSharePct_revert_over100() public {
        vm.expectRevert(AntseedEmissions.InvalidValue.selector);
        emissions.setMaxSellerSharePct(101);
    }

    function test_constructor_revert_zeroRegistry() public {
        vm.expectRevert(AntseedEmissions.InvalidAddress.selector);
        new AntseedEmissions(address(0), INITIAL_EMISSION, EPOCH_DURATION);
    }

    function test_constructor_revert_zeroEmission() public {
        vm.expectRevert(AntseedEmissions.InvalidValue.selector);
        new AntseedEmissions(address(antseedRegistry), 0, EPOCH_DURATION);
    }

    function test_constructor_revert_zeroDuration() public {
        vm.expectRevert(AntseedEmissions.InvalidValue.selector);
        new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, 0);
    }

    function test_pause_blocksAccrual() public {
        emissions.pause();

        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        emissions.accrueSellerPoints(seller1, 100);

        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        emissions.accrueBuyerPoints(buyer1, 100);
    }

    function test_pause_blocksClaim() public {
        emissions.accrueSellerPoints(seller1, 100);
        vm.warp(block.timestamp + EPOCH_DURATION);

        emissions.pause();

        vm.prank(seller1);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        emissions.claimSellerEmissions(_epochList(0));
    }

    function test_unpause_restoresFunction() public {
        emissions.pause();
        emissions.unpause();

        emissions.accrueSellerPoints(seller1, 100);
        assertEq(emissions.userSellerPoints(seller1, 0), 100);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(seller1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller1));
        emissions.pause();
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
