// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedDeposits.sol";
import "../AntseedRegistry.sol";
import "../MockUSDC.sol";

contract AntseedDepositsTest is Test {
    AntseedDeposits public deposits;
    AntseedRegistry public antseedRegistry;
    MockUSDC public usdc;

    address public owner;
    uint256 constant BUYER_PK = 0xA11CE;
    address public buyer = vm.addr(BUYER_PK);
    address public buyer2 = address(0x2);
    address public seller = address(0x3);
    address public seller2 = address(0x4);
    address public sessions = address(0x5);
    address public protocolReserve = address(0x6);
    address public thirdParty = address(0x7);
    address public randomCaller = address(0x8);
    address public operator = address(0xAA);

    uint256 constant MIN_DEPOSIT = 1_000_000; // 1 USDC
    uint256 constant BASE_CREDIT = 10_000_000; // 10 USDC

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        antseedRegistry = new AntseedRegistry();
        antseedRegistry.setChannels(sessions);
        antseedRegistry.setProtocolReserve(protocolReserve);
        deposits = new AntseedDeposits(address(usdc));
        deposits.setRegistry(address(antseedRegistry));

        // Fund test addresses
        usdc.mint(buyer, 1_000_000_000);   // 1000 USDC
        usdc.mint(buyer2, 1_000_000_000);
        usdc.mint(thirdParty, 1_000_000_000);
        usdc.mint(operator, 1_000_000_000);

        // Approve deposits contract
        vm.prank(buyer);
        usdc.approve(address(deposits), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(deposits), type(uint256).max);
        vm.prank(thirdParty);
        usdc.approve(address(deposits), type(uint256).max);
        vm.prank(operator);
        usdc.approve(address(deposits), type(uint256).max);

        // Set operator for buyer
        _setOperator(buyer, operator);

        // Raise credit limit for test flexibility (credit limit tests clear this)
        deposits.setCreditLimitOverride(buyer, type(uint256).max);
    }

    function _setOperator(address _buyer, address _operator) internal {
        uint256 nonce = deposits.getOperatorNonce(_buyer);
        bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), _operator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(_buyer, _operator, nonce, abi.encodePacked(r, s, v));
    }

    function _deposit(address _buyer, uint256 amount) internal {
        vm.prank(operator);
        deposits.deposit(_buyer, amount);
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

    // NOTE: setUp already deposited MIN_DEPOSIT to set the operator.
    // Buyer starts with MIN_DEPOSIT balance.

    function test_deposit_success() public {
        (uint256 before,,) = deposits.getBuyerBalance(buyer);
        _deposit(buyer, MIN_DEPOSIT);

        (uint256 available, uint256 reserved, uint256 lastActivity) =
            deposits.getBuyerBalance(buyer);
        assertEq(available, before + MIN_DEPOSIT);
        assertEq(reserved, 0);
        assertGt(lastActivity, 0);
    }

    function test_deposit_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit AntseedDeposits.Deposited(buyer, MIN_DEPOSIT);

        _deposit(buyer, MIN_DEPOSIT);
    }

    function test_deposit_revert_zeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.deposit(buyer, 0);
    }

    function test_deposit_anyoneCanDeposit() public {
        // Third party can deposit for buyer
        vm.prank(thirdParty);
        deposits.deposit(buyer, MIN_DEPOSIT);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertGt(available, 0);
    }

    function test_deposit_secondBelowMinSucceeds() public {
        _deposit(buyer, MIN_DEPOSIT); // first deposit meets minimum
        (uint256 before,,) = deposits.getBuyerBalance(buyer);
        _deposit(buyer, 1);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, before + 1);
    }

    function test_deposit_revert_exceedsCreditLimit() public {
        deposits.setCreditLimitOverride(buyer, 0); // use formula-based limit
        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.CreditLimitExceeded.selector);
        deposits.deposit(buyer, BASE_CREDIT + 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    deposit() — operator pulls USDC
    // ═══════════════════════════════════════════════════════════════════

    function test_deposit_operatorPullsUsdc() public {
        uint256 balBefore = usdc.balanceOf(operator);
        _deposit(buyer, MIN_DEPOSIT);

        // USDC came from operator (msg.sender)
        assertEq(usdc.balanceOf(operator), balBefore - MIN_DEPOSIT);
    }

    function test_deposit_doesNotSetFirstChannelAt() public {
        // firstChannelAt should remain 0 — only lockForChannel sets it
        (,,, uint256 firstChannelAt,,) = deposits.buyers(buyer);
        assertEq(firstChannelAt, 0);
    }

    function test_deposit_thirdPartyCanFund() public {
        vm.prank(thirdParty);
        deposits.deposit(buyer, MIN_DEPOSIT);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertGt(available, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                         withdraw()
    // ═══════════════════════════════════════════════════════════════════

    function test_withdraw_success() public {
        _deposit(buyer, MIN_DEPOSIT);
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);
        uint256 balBefore = usdc.balanceOf(operator);

        vm.prank(operator);
        deposits.withdraw(buyer, totalAvailable);

        assertEq(usdc.balanceOf(operator), balBefore + totalAvailable);
        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
        assertEq(reserved, 0);
    }

    function test_withdraw_revert_notOperator() public {
        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.withdraw(buyer, MIN_DEPOSIT);
    }

    function test_withdraw_revert_insufficientBalance() public {
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.withdraw(buyer, totalAvailable + 1);
    }

    function test_withdraw_revert_zeroAmount() public {
        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.withdraw(buyer, 0);
    }

    function test_withdraw_revert_insufficientDueToReserved() public {
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);

        // Lock entire balance
        vm.prank(sessions);
        deposits.lockForChannel(buyer, totalAvailable);

        vm.prank(operator);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.withdraw(buyer, 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     getBuyerBalance()
    // ═══════════════════════════════════════════════════════════════════

    function test_getBuyerBalance_correct() public {
        (uint256 before,,) = deposits.getBuyerBalance(buyer);

        vm.prank(sessions);
        uint256 lockAmount = before / 2;
        deposits.lockForChannel(buyer, lockAmount);

        (uint256 available, uint256 reserved, uint256 lastActivity) =
            deposits.getBuyerBalance(buyer);

        assertEq(available, before - lockAmount);
        assertEq(reserved, lockAmount);
        assertGt(lastActivity, 0);
    }

    function test_getBuyerBalance_zeroForUnknown() public view {
        (uint256 available, uint256 reserved, uint256 lastActivity) =
            deposits.getBuyerBalance(address(0x99));
        assertEq(available, 0);
        assertEq(reserved, 0);
        assertEq(lastActivity, 0);
    }

    function test_getBuyerBalance_availableFloorsAtZero() public {
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);

        // Lock entire balance
        vm.prank(sessions);
        deposits.lockForChannel(buyer, totalAvailable);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    getBuyerCreditLimit()
    // ═══════════════════════════════════════════════════════════════════

    function test_creditLimit_baseForNewBuyer() public {
        deposits.setCreditLimitOverride(buyer, 0);
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, BASE_CREDIT);
    }

    function test_creditLimit_withUniqueSellersBonus() public {
        _deposit(buyer, MIN_DEPOSIT);
        deposits.setCreditLimitOverride(buyer, 0);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, MIN_DEPOSIT);
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, MIN_DEPOSIT / 2, 0);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, BASE_CREDIT + 5_000_000); // PEER_INTERACTION_BONUS = 5 USDC
    }

    function test_creditLimit_withTimeBonus() public {
        _deposit(buyer, MIN_DEPOSIT);
        deposits.setCreditLimitOverride(buyer, 0);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, MIN_DEPOSIT);
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, MIN_DEPOSIT / 2, 0);

        // Warp forward 30 days
        vm.warp(block.timestamp + 30 days);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        // BASE + PEER_INTERACTION_BONUS * 1 + TIME_BONUS * 30
        uint256 expected = BASE_CREDIT + 5_000_000 + 500_000 * 30;
        assertEq(limit, expected);
    }


    function test_creditLimit_cappedAtMax() public {
        deposits.setCreditLimitOverride(buyer, 0);
        // Set BASE_CREDIT_LIMIT higher than MAX to trigger the cap
        deposits.setBaseCreditLimit(600_000_000);

        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, deposits.MAX_CREDIT_LIMIT());
    }

    function test_creditLimit_override() public {
        deposits.setCreditLimitOverride(buyer, 200_000_000);
        uint256 limit = deposits.getBuyerCreditLimit(buyer);
        assertEq(limit, 200_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    Direct seller payment
    // ═══════════════════════════════════════════════════════════════════

    function test_chargeAndCreditPayouts_transfersDirectlyToSeller() public {
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 1_000_000);

        // Seller receives 10 - 1 = 9 USDC directly
        assertEq(usdc.balanceOf(seller), sellerBefore + 9_000_000);
        // Protocol reserve receives 1 USDC
        assertEq(usdc.balanceOf(protocolReserve), 1_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  PRIVILEGED — CHANNELS ONLY
    // ═══════════════════════════════════════════════════════════════════

    function test_lockForChannel_success() public {
        _deposit(buyer, 30_000_000);

        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        (, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 20_000_000);
    }

    function test_lockForChannel_setsFirstChannelAt() public {
        _deposit(buyer, 30_000_000);

        (,,, uint256 firstBefore,,) = deposits.buyers(buyer);
        assertEq(firstBefore, 0);

        vm.prank(sessions);
        deposits.lockForChannel(buyer, 10_000_000);

        (,,, uint256 firstAfter,,) = deposits.buyers(buyer);
        assertEq(firstAfter, block.timestamp);
    }

    function test_lockForChannel_doesNotOverwriteFirstChannelAt() public {
        vm.warp(1000); // Set a known starting timestamp

        _deposit(buyer, 30_000_000);

        vm.prank(sessions);
        deposits.lockForChannel(buyer, 10_000_000);

        (,,, uint256 firstChannelAt,,) = deposits.buyers(buyer);
        assertEq(firstChannelAt, 1000);

        vm.warp(2000);

        // Release lock, then lock again
        vm.prank(sessions);
        deposits.releaseLock(buyer, 10_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 5_000_000);

        (,,, uint256 firstChannelAt2,,) = deposits.buyers(buyer);
        assertEq(firstChannelAt2, 1000); // Not overwritten
    }

    function test_lockForChannel_revert_insufficientBalance() public {
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);

        vm.prank(sessions);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        deposits.lockForChannel(buyer, totalAvailable + 1);
    }

    function test_lockForChannel_revert_notChannels() public {
        _deposit(buyer, MIN_DEPOSIT);

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.lockForChannel(buyer, MIN_DEPOSIT);
    }

    function test_chargeAndCreditPayouts_success() public {
        (uint256 before,,) = deposits.getBuyerBalance(buyer);
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 15_000_000, 2_000_000);

        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 5_000_000); // 20M locked - 15M charged
        assertEq(available, before + 30_000_000 - 15_000_000 - reserved); // balance minus remaining reserved

        // Seller payouts: 15 - 2 = 13
        assertEq(usdc.balanceOf(seller), 13_000_000);

        // Platform fee sent to protocolReserve
        assertEq(usdc.balanceOf(protocolReserve), 2_000_000);

        // Diversity tracked
        assertEq(deposits.uniqueSellersCharged(buyer), 1);
    }

    function test_chargeAndCreditPayouts_diversityOnlyCountedOnce() public {
        deposits.setCreditLimitOverride(buyer, 200_000_000);
        _deposit(buyer, 100_000_000);

        // Two channels with same seller
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 0);

        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 0);

        assertEq(deposits.uniqueSellersCharged(buyer), 1); // Still 1

        // New seller
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller2, 10_000_000, 0);

        assertEq(deposits.uniqueSellersCharged(buyer), 2);
    }

    function test_chargeAndCreditPayouts_zeroPlatformFee() public {
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        uint256 reserveBefore = usdc.balanceOf(protocolReserve);

        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 0);

        // No transfer to protocolReserve
        assertEq(usdc.balanceOf(protocolReserve), reserveBefore);
        // Seller gets full amount
        assertEq(usdc.balanceOf(seller), 10_000_000);
    }

    function test_chargeAndCreditPayouts_zeroProtocolReserveAddress() public {
        // Override registry to have no protocolReserve
        AntseedRegistry noReserveRegistry = new AntseedRegistry();
        noReserveRegistry.setChannels(sessions);
        deposits.setRegistry(address(noReserveRegistry));

        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        // Platform fee > 0 but protocolReserve is zero address — fee is zeroed, seller gets full amount
        vm.prank(sessions);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 1_000_000);

        assertEq(usdc.balanceOf(seller), 10_000_000);

        // Restore original registry
        deposits.setRegistry(address(antseedRegistry));
    }

    function test_chargeAndCreditPayouts_revert_amountExceedsReserved() public {
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 10_000_000);

        vm.prank(sessions);
        vm.expectRevert(); // arithmetic underflow on ba.reserved
        deposits.chargeAndCreditPayouts(buyer, seller, 11_000_000, 0);
    }

    function test_chargeAndCreditPayouts_revert_platformFeeExceedsAmount() public {
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        vm.prank(sessions);
        vm.expectRevert(AntseedDeposits.InvalidAmount.selector);
        deposits.chargeAndCreditPayouts(buyer, seller, 10_000_000, 11_000_000);
    }

    function test_chargeAndCreditPayouts_revert_notChannels() public {
        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.chargeAndCreditPayouts(buyer, seller, 1, 0);
    }

    function test_releaseLock_success() public {
        _deposit(buyer, 30_000_000);
        vm.prank(sessions);
        deposits.lockForChannel(buyer, 20_000_000);

        vm.prank(sessions);
        deposits.releaseLock(buyer, 15_000_000);

        (, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 5_000_000);
    }

    function test_releaseLock_revert_notChannels() public {
        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.releaseLock(buyer, 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                       ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function test_setRegistry_success() public {
        AntseedRegistry newRegistry = new AntseedRegistry();
        newRegistry.setChannels(address(0xAA));
        deposits.setRegistry(address(newRegistry));
        assertEq(address(deposits.registry()), address(newRegistry));
    }

    function test_setRegistry_revert_zeroAddress() public {
        vm.expectRevert(AntseedDeposits.InvalidAddress.selector);
        deposits.setRegistry(address(0));
    }

    function test_setRegistry_revert_notOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", randomCaller));
        deposits.setRegistry(address(0xAA));
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

    function test_withdraw_operatorCanCall() public {
        _deposit(buyer, MIN_DEPOSIT);
        (uint256 totalAvailable,,) = deposits.getBuyerBalance(buyer);
        uint256 balBefore = usdc.balanceOf(operator);

        vm.prank(operator);
        deposits.withdraw(buyer, totalAvailable);

        assertEq(usdc.balanceOf(operator), balBefore + totalAvailable);
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    function test_withdraw_operatorRevoked_revert() public {
        _deposit(buyer, MIN_DEPOSIT);

        // Revoke operator via transferOperator
        vm.prank(operator);
        deposits.transferOperator(buyer, address(0));

        vm.prank(randomCaller);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.withdraw(buyer, MIN_DEPOSIT);
    }
}
