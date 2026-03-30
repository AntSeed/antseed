// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedDeposits.sol";
import "../MockUSDC.sol";
import {IAntseedChannels} from "../interfaces/IAntseedChannels.sol";

contract AntseedDepositsTest is Test {
    AntseedDeposits public deposits;
    MockUSDC public usdc;

    address public owner;
    address public buyer = address(0x1);
    address public buyer2 = address(0x2);
    address public seller = address(0x3);
    address public seller2 = address(0x4);
    address public sessions = address(0x5);
    address public protocolReserve = address(0x6);
    address public thirdParty = address(0x7);
    address public randomCaller = address(0x8);

    uint256 constant MIN_DEPOSIT = 10_000_000; // 10 USDC
    uint256 constant BASE_CREDIT = 50_000_000; // 50 USDC

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        deposits = new AntseedDeposits(address(usdc));
        deposits.setChannelsContract(sessions);

        // Fund test addresses
        usdc.mint(buyer, 1_000_000_000);   // 1000 USDC
        usdc.mint(buyer2, 1_000_000_000);
        usdc.mint(thirdParty, 1_000_000_000);

        // Approve deposits contract
        vm.prank(buyer);
        usdc.approve(address(deposits), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(deposits), type(uint256).max);
        vm.prank(thirdParty);
        usdc.approve(address(deposits), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                         CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    function test_constructor_revert_zeroAddress() public {
        vm.expectRevert(AntseedDeposits.InvalidAddress.selector);
        new AntseedDeposits(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                         deposit()
    // ═══════════════════════════════════════════════════════════════════

    function test_deposit_success() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        (uint256 available, uint256 reserved, uint256 pending, uint256 lastActivity) =
            deposits.getBuyerBalance(buyer);
        assertEq(available, MIN_DEPOSIT);
        assertEq(reserved, 0);
        assertEq(pending, 0);
        assertGt(lastActivity, 0);
        assertEq(usdc.balanceOf(address(deposits)), MIN_DEPOSIT);
    }

    function test_deposit_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.Deposited(buyer, MIN_DEPOSIT);

        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);
    }

    function test_deposit_revert_zeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.deposit(0);
    }

    function test_deposit_revert_belowMinFirstDeposit() public {
        vm.prank(buyer);
        vm.expectRevert(AntseedDeposits.BelowMinDeposit.selector);
        deposits.deposit(MIN_DEPOSIT - 1);
    }

    function test_deposit_secondBelowMinSucceeds() public {
        // First deposit meets minimum
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        // Second deposit below minimum succeeds because buyer already has balance
        vm.prank(buyer);
        deposits.deposit(1);

        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, MIN_DEPOSIT + 1);
    }

    function test_deposit_revert_exceedsCreditLimit() public {
        // Default credit limit is 50 USDC. Try to deposit 51 USDC.
        vm.prank(buyer);
        vm.expectRevert(AntseedDeposits.CreditLimitExceeded.selector);
        deposits.deposit(BASE_CREDIT + 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                         depositFor()
    // ═══════════════════════════════════════════════════════════════════

    function test_depositFor_success() public {
        vm.prank(thirdParty);
        deposits.depositFor(buyer, MIN_DEPOSIT);

        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, MIN_DEPOSIT);
        // USDC came from thirdParty
        assertEq(usdc.balanceOf(thirdParty), 1_000_000_000 - MIN_DEPOSIT);
    }

    function test_depositFor_emitsEventForBuyer() public {
        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.Deposited(buyer, MIN_DEPOSIT);

        vm.prank(thirdParty);
        deposits.depositFor(buyer, MIN_DEPOSIT);
    }

    function test_depositFor_doesNotSetFirstSessionAt() public {
        vm.prank(thirdParty);
        deposits.depositFor(buyer, MIN_DEPOSIT);

        // firstSessionAt should remain 0 — only lockForSession sets it
        (,,,,, uint256 firstSessionAt) = deposits.buyers(buyer);
        assertEq(firstSessionAt, 0);
    }

    function test_depositFor_revert_zeroAmount() public {
        vm.prank(thirdParty);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.depositFor(buyer, 0);
    }

    function test_depositFor_revert_belowMin() public {
        vm.prank(thirdParty);
        vm.expectRevert(AntseedDeposits.BelowMinDeposit.selector);
        deposits.depositFor(buyer, MIN_DEPOSIT - 1);
    }

    function test_depositFor_revert_exceedsCreditLimit() public {
        vm.prank(thirdParty);
        vm.expectRevert(AntseedDeposits.CreditLimitExceeded.selector);
        deposits.depositFor(buyer, BASE_CREDIT + 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     requestWithdrawal()
    // ═══════════════════════════════════════════════════════════════════

    function _mockOperator(address _buyer, address _operator) internal {
        vm.mockCall(
            sessions,
            abi.encodeWithSelector(IAntseedChannels.operators.selector, _buyer),
            abi.encode(_operator)
        );
    }

    function test_requestWithdrawal_success() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.WithdrawalRequested(buyer, MIN_DEPOSIT);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        (uint256 available,, uint256 pending,) = deposits.getBuyerBalance(buyer);
        assertEq(pending, MIN_DEPOSIT);
        assertEq(available, 0);
    }

    function test_requestWithdrawal_revert_zeroAmount() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.requestWithdrawal(buyer, 0);
    }

    function test_requestWithdrawal_revert_alreadyPending() public {
        vm.prank(buyer);
        deposits.deposit(20_000_000);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        // Second request while one is pending
        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);
    }

    function test_requestWithdrawal_revert_insufficientAvailable() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT + 1);
    }

    function test_requestWithdrawal_revert_insufficientDueToReserved() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        // Lock some for session
        vm.prank(sessions);
        deposits.lockForSession(buyer, MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.requestWithdrawal(buyer, 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     executeWithdrawal()
    // ═══════════════════════════════════════════════════════════════════

    function test_executeWithdrawal_success() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        // Warp past withdrawal delay (48 hours)
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 balBefore = usdc.balanceOf(buyer);

        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.WithdrawalExecuted(buyer, MIN_DEPOSIT);

        vm.prank(operator);
        deposits.executeWithdrawal(buyer);

        assertEq(usdc.balanceOf(buyer), balBefore + MIN_DEPOSIT);
        (uint256 available,, uint256 pending,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
        assertEq(pending, 0);
    }

    function test_executeWithdrawal_revert_beforeDelay() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        // Warp to just before the delay
        vm.warp(block.timestamp + 48 hours - 1);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.TimeoutNotReached.selector);
        deposits.executeWithdrawal(buyer);
    }

    function test_executeWithdrawal_revert_noPending() public {
        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.executeWithdrawal(buyer);
    }

    function test_executeWithdrawal_capsAtAvailable() public {
        // The cap in executeWithdrawal (min(withdrawalAmount, balance - reserved)) is a safety net.
        // Under normal settlement flows, (balance - reserved) never decreases.
        // We use vm.store to simulate the edge condition where balance drops below withdrawalAmount.
        deposits.setCreditLimitOverride(buyer, 200_000_000);
        vm.prank(buyer);
        deposits.deposit(50_000_000);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, 30_000_000);

        // Directly reduce balance via vm.store to simulate an edge case
        // buyers mapping at slot 8 (forge inspect storage-layout), balance is field 0
        bytes32 buyerBaseSlot = keccak256(abi.encode(buyer, uint256(8)));
        vm.store(address(deposits), buyerBaseSlot, bytes32(uint256(20_000_000)));

        vm.warp(block.timestamp + 48 hours + 1);

        uint256 balBefore = usdc.balanceOf(buyer);
        vm.prank(operator);
        deposits.executeWithdrawal(buyer);

        // Capped at available = balance(20) - reserved(0) = 20, not the requested 30
        assertEq(usdc.balanceOf(buyer), balBefore + 20_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     cancelWithdrawal()
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelWithdrawal_success() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        vm.expectEmit(true, false, false, false);
        emit AntseedDeposits.WithdrawalCancelled(buyer);

        vm.prank(operator);
        deposits.cancelWithdrawal(buyer);

        (uint256 available,, uint256 pending,) = deposits.getBuyerBalance(buyer);
        assertEq(available, MIN_DEPOSIT);
        assertEq(pending, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     getBuyerBalance()
    // ═══════════════════════════════════════════════════════════════════

    function test_getBuyerBalance_correct() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);

        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, 5_000_000);

        (uint256 available, uint256 reserved, uint256 pending, uint256 lastActivity) =
            deposits.getBuyerBalance(buyer);

        // available = balance(30) - reserved(10) - withdrawal(5) = 15
        assertEq(available, 15_000_000);
        assertEq(reserved, 10_000_000);
        assertEq(pending, 5_000_000);
        assertGt(lastActivity, 0);
    }

    function test_getBuyerBalance_zeroForUnknown() public view {
        (uint256 available, uint256 reserved, uint256 pending, uint256 lastActivity) =
            deposits.getBuyerBalance(address(0x99));
        assertEq(available, 0);
        assertEq(reserved, 0);
        assertEq(pending, 0);
        assertEq(lastActivity, 0);
    }

    function test_getBuyerBalance_availableFloorsAtZero() public {
        // When locked > balance (shouldn't normally happen, but getBuyerBalance guards it)
        vm.prank(buyer);
        deposits.deposit(30_000_000);

        // Lock entire balance
        vm.prank(sessions);
        deposits.lockForSession(buyer, 30_000_000);

        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    getBuyerCreditLimit()
    // ═══════════════════════════════════════════════════════════════════

    function test_creditLimit_baseForNewBuyer() public view {
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, BASE_CREDIT);
    }

    function test_creditLimit_withUniqueSellersBonus() public {
        // Deposit and have sessions charge with a seller to track diversity
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 5_000_000, 10_000_000, 0, protocolReserve);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        // BASE + 1 * PEER_INTERACTION_BONUS + time bonus (firstSessionAt just set)
        assertEq(limit, BASE_CREDIT + 5_000_000); // PEER_INTERACTION_BONUS = 5 USDC
    }

    function test_creditLimit_withTimeBonus() public {
        // First, create a session so firstSessionAt is set
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 5_000_000, 10_000_000, 0, protocolReserve);

        // Warp forward 30 days
        vm.warp(block.timestamp + 30 days);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        // BASE + PEER_INTERACTION_BONUS * 1 + TIME_BONUS * 30
        uint256 expected = BASE_CREDIT + 5_000_000 + 500_000 * 30;
        assertEq(limit, expected);
    }


    function test_creditLimit_cappedAtMax() public {
        // Set a huge override to verify the cap path — but override bypasses cap.
        // Instead, we need to manipulate values so the computed limit exceeds MAX.
        // Set BASE_CREDIT_LIMIT very high
        deposits.setBaseCreditLimit(600_000_000);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, 500_000_000); // MAX_CREDIT_LIMIT
    }

    function test_creditLimit_override() public {
        deposits.setCreditLimitOverride(buyer, 200_000_000);
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, 200_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                       claimEarnings()
    // ═══════════════════════════════════════════════════════════════════

    function test_claimEarnings_success() public {
        // Setup: deposit, lock, settle to credit seller earnings
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 1_000_000, protocolReserve);

        // Seller earnings = 10 - 1 = 9 USDC
        assertEq(deposits.getSellerEarnings(seller), 9_000_000);

        uint256 balBefore = usdc.balanceOf(seller);

        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.EarningsClaimed(seller, 9_000_000);

        vm.prank(seller);
        deposits.claimEarnings();

        assertEq(usdc.balanceOf(seller), balBefore + 9_000_000);
        assertEq(deposits.getSellerEarnings(seller), 0);
    }

    function test_claimEarnings_revert_zeroEarnings() public {
        vm.prank(seller);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.claimEarnings();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  PRIVILEGED — SESSIONS ONLY
    // ═══════════════════════════════════════════════════════════════════

    function test_lockForSession_success() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);

        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        (, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 20_000_000);
    }

    function test_lockForSession_setsFirstSessionAt() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);

        (,,,,, uint256 firstBefore) = deposits.buyers(buyer);
        assertEq(firstBefore, 0);

        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);

        (,,,,, uint256 firstAfter) = deposits.buyers(buyer);
        assertEq(firstAfter, block.timestamp);
    }

    function test_lockForSession_doesNotOverwriteFirstSessionAt() public {
        vm.warp(1000); // Set a known starting timestamp

        vm.prank(buyer);
        deposits.deposit(30_000_000);

        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);

        (,,,,, uint256 firstSessionAt) = deposits.buyers(buyer);
        assertEq(firstSessionAt, 1000);

        vm.warp(2000);

        // Release lock, then lock again
        vm.prank(sessions);
        deposits.releaseLock(buyer, 10_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 5_000_000);

        (,,,,, uint256 firstSessionAt2) = deposits.buyers(buyer);
        assertEq(firstSessionAt2, 1000); // Not overwritten
    }

    function test_lockForSession_revert_insufficientBalance() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        vm.prank(sessions);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.lockForSession(buyer, MIN_DEPOSIT + 1);
    }

    function test_lockForSession_revert_notSessions() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.lockForSession(buyer, MIN_DEPOSIT);
    }

    function test_chargeAndCreditEarnings_success() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 15_000_000, 20_000_000, 2_000_000, protocolReserve);

        // Buyer balance: 30 - 15 = 15
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 15_000_000);
        assertEq(reserved, 0); // 20 - 20 reserved released

        // Seller earnings: 15 - 2 = 13
        assertEq(deposits.getSellerEarnings(seller), 13_000_000);

        // Platform fee sent to protocolReserve
        assertEq(usdc.balanceOf(protocolReserve), 2_000_000);

        // Diversity tracked
        assertEq(deposits.uniqueSellersCharged(buyer), 1);
    }

    function test_chargeAndCreditEarnings_diversityOnlyCountedOnce() public {
        deposits.setCreditLimitOverride(buyer, 200_000_000);
        vm.prank(buyer);
        deposits.deposit(100_000_000);

        // Two sessions with same seller
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 0, protocolReserve);

        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 0, protocolReserve);

        assertEq(deposits.uniqueSellersCharged(buyer), 1); // Still 1

        // New seller
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller2, 10_000_000, 20_000_000, 0, protocolReserve);

        assertEq(deposits.uniqueSellersCharged(buyer), 2);
    }

    function test_chargeAndCreditEarnings_zeroPlatformFee() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        uint256 reserveBefore = usdc.balanceOf(protocolReserve);

        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 0, protocolReserve);

        // No transfer to protocolReserve
        assertEq(usdc.balanceOf(protocolReserve), reserveBefore);
        // Seller gets full amount
        assertEq(deposits.getSellerEarnings(seller), 10_000_000);
    }

    function test_chargeAndCreditEarnings_zeroProtocolReserveAddress() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        // Platform fee > 0 but protocolReserve is zero address — should not transfer
        vm.prank(sessions);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 1_000_000, address(0));

        // Seller gets chargeAmount - platformFee
        assertEq(deposits.getSellerEarnings(seller), 9_000_000);
    }

    function test_chargeAndCreditEarnings_revert_chargeExceedsReserved() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 10_000_000);

        vm.prank(sessions);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.chargeAndCreditEarnings(buyer, seller, 11_000_000, 10_000_000, 0, protocolReserve);
    }

    function test_chargeAndCreditEarnings_revert_platformFeeExceedsCharge() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        vm.prank(sessions);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.chargeAndCreditEarnings(buyer, seller, 10_000_000, 20_000_000, 11_000_000, protocolReserve);
    }

    function test_chargeAndCreditEarnings_revert_notSessions() public {
        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.chargeAndCreditEarnings(buyer, seller, 1, 1, 0, protocolReserve);
    }

    function test_releaseLock_success() public {
        vm.prank(buyer);
        deposits.deposit(30_000_000);
        vm.prank(sessions);
        deposits.lockForSession(buyer, 20_000_000);

        vm.prank(sessions);
        deposits.releaseLock(buyer, 15_000_000);

        (, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 5_000_000);
    }

    function test_releaseLock_revert_notSessions() public {
        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.releaseLock(buyer, 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                       ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function test_setChannelsContract_success() public {
        address newSessions = address(0xAA);
        deposits.setChannelsContract(newSessions);
        assertEq(deposits.channelsContract(), newSessions);
    }

    function test_setChannelsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedDeposits.InvalidAddress.selector);
        deposits.setChannelsContract(address(0));
    }

    function test_setChannelsContract_revert_notOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", randomCaller));
        deposits.setChannelsContract(address(0xAA));
    }

    function test_setCreditLimitOverride_success() public {
        deposits.setCreditLimitOverride(buyer, 100_000_000);
        assertEq(deposits.creditLimitOverride(buyer), 100_000_000);
    }

    function test_setCreditLimitOverride_revert_notOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", randomCaller));
        deposits.setCreditLimitOverride(buyer, 100_000_000);
    }

    function test_setMinBuyerDeposit() public {
        deposits.setMinBuyerDeposit(5_000_000);
        assertEq(deposits.MIN_BUYER_DEPOSIT(), 5_000_000);
    }

    function test_setWithdrawalDelay() public {
        deposits.setWithdrawalDelay(2 hours);
        assertEq(deposits.WITHDRAWAL_DELAY(), 2 hours);
    }

    function test_setWithdrawalDelay_revert_belowMinimum() public {
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.setWithdrawalDelay(59 minutes);
    }

    function test_setBaseCreditLimit() public {
        deposits.setBaseCreditLimit(100_000_000);
        assertEq(deposits.BASE_CREDIT_LIMIT(), 100_000_000);
    }

    function test_setPeerInteractionBonus() public {
        deposits.setPeerInteractionBonus(10_000_000);
        assertEq(deposits.PEER_INTERACTION_BONUS(), 10_000_000);
    }

    function test_setTimeBonus() public {
        deposits.setTimeBonus(1_000_000);
        assertEq(deposits.TIME_BONUS(), 1_000_000);
    }

    function test_setMaxCreditLimit() public {
        deposits.setMaxCreditLimit(1_000_000_000);
        assertEq(deposits.MAX_CREDIT_LIMIT(), 1_000_000_000);
    }

    function test_setMinBuyerDeposit_revert_notOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", randomCaller));
        deposits.setMinBuyerDeposit(5_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   OPERATOR WITHDRAWAL TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_requestWithdrawal_operatorCanCall() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        (uint256 available,, uint256 pending,) = deposits.getBuyerBalance(buyer);
        assertEq(pending, MIN_DEPOSIT);
        assertEq(available, 0);
    }

    function test_executeWithdrawal_operatorCanCall() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        vm.warp(block.timestamp + 48 hours + 1);

        uint256 balBefore = usdc.balanceOf(buyer);

        vm.prank(operator);
        deposits.executeWithdrawal(buyer);

        // USDC goes to buyer
        assertEq(usdc.balanceOf(buyer), balBefore + MIN_DEPOSIT);
    }

    function test_requestWithdrawal_revert_notOperator() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        // Mock sessions.operators(buyer) to return address(0) — no operator set
        vm.mockCall(sessions, abi.encodeWithSelector(IAntseedChannels.operators.selector, buyer), abi.encode(address(0)));

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);
    }

    function test_executeWithdrawal_revert_notOperator() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        vm.warp(block.timestamp + 48 hours + 1);

        // Mock sessions.operators(buyer) to return address(0) — no operator set
        vm.mockCall(sessions, abi.encodeWithSelector(IAntseedChannels.operators.selector, buyer), abi.encode(address(0)));

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.executeWithdrawal(buyer);
    }

    function test_cancelWithdrawal_revert_notOperator() public {
        vm.prank(buyer);
        deposits.deposit(MIN_DEPOSIT);

        address operator = address(0xAA);
        _mockOperator(buyer, operator);

        vm.prank(operator);
        deposits.requestWithdrawal(buyer, MIN_DEPOSIT);

        // Mock sessions.operators(buyer) to return address(0) — no operator set
        vm.mockCall(sessions, abi.encodeWithSelector(IAntseedChannels.operators.selector, buyer), abi.encode(address(0)));

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.cancelWithdrawal(buyer);
    }
}
