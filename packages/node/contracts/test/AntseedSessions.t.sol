// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedSessions.sol";
import "../AntseedDeposits.sol";
import "../AntseedStaking.sol";
import "../AntseedIdentity.sol";
import "../MockUSDC.sol";

contract AntseedSessionsTest is Test {
    MockUSDC public usdc;
    AntseedIdentity public identity;
    AntseedStaking public staking;
    AntseedDeposits public deposits;
    AntseedSessions public sessions;

    // Deterministic private keys
    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    uint256 constant RANDOM_PK = 0xDEAD;

    address public buyer;
    address public seller;
    address public randomUser;
    address public protocolReserve = address(0xFEE);

    bytes32 constant SESSION_ID = keccak256("session-1");
    bytes32 constant SESSION_ID_2 = keccak256("session-2");

    // USDC amounts (6 decimals)
    uint256 constant USDC_100 = 100_000_000;
    uint256 constant USDC_50 = 50_000_000;
    uint256 constant USDC_30 = 30_000_000;
    uint256 constant USDC_60 = 60_000_000;
    uint256 constant USDC_10 = 10_000_000;
    uint256 constant USDC_150 = 150_000_000;

    uint256 constant STAKE_AMOUNT = 10_000_000; // MIN_SELLER_STAKE

    // EIP-712 typehash (must match contract)
    bytes32 constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeOutputTokens,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        randomUser = vm.addr(RANDOM_PK);

        // Deploy contracts
        usdc = new MockUSDC();
        identity = new AntseedIdentity();
        staking = new AntseedStaking(address(usdc), address(identity));
        deposits = new AntseedDeposits(address(usdc));
        sessions = new AntseedSessions(address(deposits), address(identity), address(staking));

        // Wire contracts together
        deposits.setSessionsContract(address(sessions));
        identity.setSessionsContract(address(sessions));
        identity.setStakingContract(address(staking));
        staking.setSessionsContract(address(sessions));
        sessions.setProtocolReserve(protocolReserve);

        // Raise FIRST_SIGN_CAP for tests that need large reservations
        sessions.setConstant(keccak256("FIRST_SIGN_CAP"), 500_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function createBuyer(uint256 pk, uint256 depositAmount) internal {
        address addr = vm.addr(pk);
        bytes32 peerId = keccak256(abi.encodePacked("buyer-", pk));

        // Register identity
        vm.prank(addr);
        identity.register(peerId, "ipfs://buyer");

        // Raise credit limit so large deposits don't revert
        deposits.setCreditLimitOverride(addr, type(uint256).max);

        // Mint USDC, approve deposits, and deposit
        usdc.mint(addr, depositAmount);
        vm.startPrank(addr);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(depositAmount);
        vm.stopPrank();
    }

    function createSeller(uint256 pk) internal {
        address addr = vm.addr(pk);
        bytes32 peerId = keccak256(abi.encodePacked("seller-", pk));

        // Register identity
        vm.prank(addr);
        identity.register(peerId, "ipfs://seller");

        // Mint USDC, approve staking, and stake
        usdc.mint(addr, STAKE_AMOUNT);
        vm.startPrank(addr);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT);
        vm.stopPrank();
    }

    function signSpendingAuth(
        uint256 pk,
        address _seller,
        bytes32 sessionId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                _seller,
                sessionId,
                cumulativeAmount,
                cumulativeInputTokens,
                cumulativeOutputTokens,
                nonce,
                deadline
            )
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", sessions.domainSeparator(), structHash));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   Task 2: Test reserve() — new session
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_newSession() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Sign initial SpendingAuth with cumulative fields = 0
        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        // Seller calls reserve
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, sig);

        // Assert session state
        (
            address sBuyer,
            address sSeller,
            uint256 sDeposit,
            uint256 sSettled,
            uint128 sInputTokens,
            uint128 sOutputTokens,
            uint256 sNonce,
            uint256 sDeadline,
            uint256 sSettledAt,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(SESSION_ID);

        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, 0);
        assertEq(sInputTokens, 0);
        assertEq(sOutputTokens, 0);
        assertEq(sNonce, nonce);
        assertEq(sDeadline, deadline);
        assertEq(sSettledAt, 0);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);

        // Assert buyer's deposits: reserved increased, available decreased
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, USDC_100);
        assertEq(available, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   Task 3: Test reserve() — top-up
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_topUp() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce1 = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Initial reserve: 50 USDC
        bytes memory sig1 = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce1, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce1, deadline, sig1);

        // Top-up: 30 USDC (new signature with same sessionId)
        uint256 nonce2 = 2;
        bytes memory sig2 = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce2, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_30, nonce2, deadline, sig2);

        // Assert session deposit accumulated
        (,, uint256 sDeposit,,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertEq(sDeposit, USDC_50 + USDC_30); // 80 USDC
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);

        // Assert buyer's deposits: reserved = 80 USDC
        (, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, USDC_50 + USDC_30);
    }

    // ═══════════════════════════════════════════════════════════════════
    //            Task 4: Test settle() with cumulative SpendingAuth
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_cumulativeAuth() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve 100 USDC
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Settle with cumulative: 60 USDC, 5000 input tokens, 2000 output tokens
        uint256 settleNonce = 2;
        uint256 settleDeadline = block.timestamp + 2 hours;
        uint256 cumulativeAmount = USDC_60;
        uint256 inputTokens = 5000;
        uint256 outputTokens = 2000;

        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, cumulativeAmount, inputTokens, outputTokens, settleNonce, settleDeadline
        );

        vm.prank(seller);
        sessions.settle(SESSION_ID, cumulativeAmount, inputTokens, outputTokens, settleNonce, settleDeadline, settleSig);

        // Assert session state
        (
            ,
            ,
            ,
            uint256 sSettled,
            uint128 sInputTokens,
            uint128 sOutputTokens,
            ,
            ,
            uint256 sSettledAt,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(SESSION_ID);

        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
        assertEq(sSettled, USDC_60);
        assertEq(sInputTokens, 5000);
        assertEq(sOutputTokens, 2000);
        assertGt(sSettledAt, 0);
        assertEq(sSettledAt, block.timestamp);

        // Assert financial state: seller earnings credited
        // Platform fee = 60 USDC * 500 / 10000 = 3 USDC
        uint256 platformFee = (USDC_60 * 500) / 10000;
        uint256 sellerPayout = USDC_60 - platformFee;
        assertEq(deposits.sellerEarnings(seller), sellerPayout);

        // Buyer: reserved should be 0 (full deposit released), balance decreased by chargeAmount
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        // available = original balance (100) - charged (60) = 40
        assertEq(available, USDC_100 - USDC_60);

        // Assert reputation: seller sessionCount incremented
        uint256 sellerTokenId = identity.getTokenId(seller);
        AntseedIdentity.Reputation memory rep = identity.getReputation(sellerTokenId);
        assertEq(rep.sessionCount, 1);
        assertEq(rep.totalSettledVolume, USDC_60);
        assertEq(rep.totalInputTokens, 5000);
        assertEq(rep.totalOutputTokens, 2000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   Task 5: Test settleTimeout()
    // ═══════════════════════════════════════════════════════════════════

    function test_settleTimeout() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve 100 USDC
        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, sig);

        // Warp past deadline + CLOSE_GRACE_PERIOD (2 hours)
        vm.warp(deadline + 2 hours + 1);

        // Anyone can call settleTimeout
        vm.prank(randomUser);
        sessions.settleTimeout(SESSION_ID);

        // Assert session state
        (,,, uint256 sSettled,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertTrue(sStatus == AntseedSessions.SessionStatus.TimedOut);
        assertEq(sSettled, 0);

        // Full deposit released to buyer
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, USDC_100);
    }

    // ═══════════════════════════════════════════════════════════════════
    //               Task 6: Test edge cases and reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_revert_cumulativeExceedsDeposit() public {
        createBuyer(BUYER_PK, USDC_150);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve 100 USDC
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Try to settle with 150 USDC (exceeds 100 deposit)
        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_150, 0, 0, settleNonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidAmount.selector);
        sessions.settle(SESSION_ID, USDC_150, 0, 0, settleNonce, deadline, settleSig);
    }

    function test_settle_revert_invalidSignature() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Sign settle with RANDOM key (not the buyer)
        uint256 settleNonce = 2;
        bytes memory badSig = signSpendingAuth(
            RANDOM_PK, seller, SESSION_ID, USDC_60, 0, 0, settleNonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidSignature.selector);
        sessions.settle(SESSION_ID, USDC_60, 0, 0, settleNonce, deadline, badSig);
    }

    function test_settle_revert_nonActiveSession() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve and settle
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_60, 0, 0, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, USDC_60, 0, 0, settleNonce, deadline, settleSig);

        // Try to settle again — session is already Settled
        uint256 settleNonce2 = 3;
        bytes memory settleSig2 = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_30, 0, 0, settleNonce2, deadline
        );
        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionNotReserved.selector);
        sessions.settle(SESSION_ID, USDC_30, 0, 0, settleNonce2, deadline, settleSig2);
    }

    function test_reserve_revert_firstSignCapExceeded() public {
        // Lower FIRST_SIGN_CAP to 1 USDC for this test
        sessions.setConstant(keccak256("FIRST_SIGN_CAP"), 1_000_000);

        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 overCap = 1_000_001; // just above the cap
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.FirstSignCapExceeded.selector);
        sessions.reserve(buyer, SESSION_ID, overCap, nonce, deadline, sig);
    }

    function test_reserve_revert_insufficientBuyerBalance() public {
        // Buyer deposits 10 USDC (minimum)
        createBuyer(BUYER_PK, USDC_10);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Try to reserve 50 USDC but buyer only has 10 USDC available
        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedDeposits.InsufficientBalance.selector);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, sig);
    }

    function test_settle_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve with valid deadline
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Sign settle with a past deadline
        uint256 pastDeadline = block.timestamp - 1;
        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_60, 0, 0, settleNonce, pastDeadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExpired.selector);
        sessions.settle(SESSION_ID, USDC_60, 0, 0, settleNonce, pastDeadline, settleSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //         Test reserve() revert on Settled session (SessionExists)
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_revert_onSettledSession() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Reserve
        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, reserveSig);

        // Settle the session
        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_30, 1000, 500, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, USDC_30, 1000, 500, settleNonce, deadline, settleSig);

        // Try to reserve again on the now-Settled session
        uint256 nonce3 = 3;
        bytes memory sig3 = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce3, deadline
        );
        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExists.selector);
        sessions.reserve(buyer, SESSION_ID, USDC_10, nonce3, deadline, sig3);
    }

    function test_reserve_revert_onTimedOutSession() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, sig);

        // Warp past timeout
        vm.warp(deadline + 2 hours + 1);
        sessions.settleTimeout(SESSION_ID);

        // Try to reserve on timed-out session
        uint256 nonce2 = 2;
        uint256 deadline2 = block.timestamp + 1 hours;
        bytes memory sig2 = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce2, deadline2
        );
        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExists.selector);
        sessions.reserve(buyer, SESSION_ID, USDC_10, nonce2, deadline2, sig2);
    }

    // ═══════════════════════════════════════════════════════════════════
    //         Test reserve() revert — seller not staked
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_revert_sellerNotStaked() public {
        createBuyer(BUYER_PK, USDC_100);
        // Do NOT create/stake seller — just register identity
        vm.prank(seller);
        identity.register(keccak256("seller-unstaked"), "ipfs://seller");

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SellerNotStaked.selector);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, sig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //         Test reserve() revert — expired deadline
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 pastDeadline = block.timestamp - 1;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, pastDeadline
        );

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExpired.selector);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, pastDeadline, sig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test settle() cumulative equals deposit exactly (zero remaining)
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_fullDeposit() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Settle for full amount
        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_100, 10000, 5000, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, USDC_100, 10000, 5000, settleNonce, deadline, settleSig);

        // Buyer should have 0 available (full deposit charged), 0 reserved
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, 0);

        // Verify settled amount
        (,,, uint256 sSettled,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertEq(sSettled, USDC_100);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test settle() zero cumulative amount (releases full deposit)
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_zeroCumulativeAmount() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        // Settle with cumulativeAmount = 0
        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, 0, 0, 0, settleNonce, deadline, settleSig);

        // Full deposit should be released back to buyer
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, USDC_100);

        // Seller earnings should be 0
        assertEq(deposits.sellerEarnings(seller), 0);

        // Session settled
        (,,, uint256 sSettled,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertEq(sSettled, 0);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test settle() platform fee calculation
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_platformFeeCalculation() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        uint256 chargeAmount = USDC_60;
        uint256 expectedPlatformFee = (chargeAmount * 500) / 10000; // 3 USDC
        uint256 expectedSellerPayout = chargeAmount - expectedPlatformFee; // 57 USDC

        uint256 settleNonce = 2;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, chargeAmount, 0, 0, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, chargeAmount, 0, 0, settleNonce, deadline, settleSig);

        // Verify seller earnings = charge - platformFee
        assertEq(deposits.sellerEarnings(seller), expectedSellerPayout);

        // Verify protocol reserve got the fee
        assertEq(usdc.balanceOf(protocolReserve), expectedPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test settle() reputation update
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_reputationUpdate() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, reserveSig);

        uint256 settleNonce = 2;
        uint256 inputToks = 7500;
        uint256 outputToks = 3200;
        bytes memory settleSig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, USDC_50, inputToks, outputToks, settleNonce, deadline
        );
        vm.prank(seller);
        sessions.settle(SESSION_ID, USDC_50, inputToks, outputToks, settleNonce, deadline, settleSig);

        uint256 sellerTokenId = identity.getTokenId(seller);
        AntseedIdentity.Reputation memory rep = identity.getReputation(sellerTokenId);
        assertEq(rep.sessionCount, 1);
        assertEq(rep.totalSettledVolume, USDC_50);
        assertEq(rep.totalInputTokens, inputToks);
        assertEq(rep.totalOutputTokens, outputToks);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test settleTimeout() by third party (permissionless)
    // ═══════════════════════════════════════════════════════════════════

    function test_settleTimeout_byThirdParty() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, sig);

        // Warp past deadline + grace period
        vm.warp(deadline + 2 hours + 1);

        // Random user (not buyer, not seller) calls settleTimeout — should succeed
        vm.prank(randomUser);
        sessions.settleTimeout(SESSION_ID);

        (,,,,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertTrue(sStatus == AntseedSessions.SessionStatus.TimedOut);

        // Full deposit released to buyer
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, USDC_100);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test setConstant() for each key
    // ═══════════════════════════════════════════════════════════════════

    function test_setConstant_firstSignCap() public {
        sessions.setConstant(keccak256("FIRST_SIGN_CAP"), 2_000_000);
        assertEq(sessions.FIRST_SIGN_CAP(), 2_000_000);
    }

    function test_setConstant_closeGracePeriod() public {
        sessions.setConstant(keccak256("CLOSE_GRACE_PERIOD"), 1 hours);
        assertEq(sessions.CLOSE_GRACE_PERIOD(), 1 hours);
    }

    function test_setConstant_platformFeeBps() public {
        sessions.setConstant(keccak256("PLATFORM_FEE_BPS"), 300);
        assertEq(sessions.PLATFORM_FEE_BPS(), 300);
    }

    function test_setConstant_revert_unknownKey() public {
        vm.expectRevert(AntseedSessions.InvalidAmount.selector);
        sessions.setConstant(keccak256("UNKNOWN_KEY"), 100);
    }

    function test_setConstant_revert_closeGracePeriodBelowMinimum() public {
        vm.expectRevert(AntseedSessions.InvalidAmount.selector);
        sessions.setConstant(keccak256("CLOSE_GRACE_PERIOD"), 29 minutes);
    }

    function test_setConstant_revert_platformFeeBpsAboveMax() public {
        vm.expectRevert(AntseedSessions.InvalidFee.selector);
        sessions.setConstant(keccak256("PLATFORM_FEE_BPS"), 1001);
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test admin setters (owner-only)
    // ═══════════════════════════════════════════════════════════════════

    function test_setDepositsContract() public {
        address newDeposits = address(0x1234);
        sessions.setDepositsContract(newDeposits);
        assertEq(address(sessions.depositsContract()), newDeposits);
    }

    function test_setDepositsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setDepositsContract(address(0));
    }

    function test_setDepositsContract_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.setDepositsContract(address(0x1234));
    }

    function test_setIdentityContract() public {
        address newIdentity = address(0x5678);
        sessions.setIdentityContract(newIdentity);
        assertEq(address(sessions.identityContract()), newIdentity);
    }

    function test_setIdentityContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setIdentityContract(address(0));
    }

    function test_setIdentityContract_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.setIdentityContract(address(0x5678));
    }

    function test_setStakingContract() public {
        address newStaking = address(0x9ABC);
        sessions.setStakingContract(newStaking);
        assertEq(address(sessions.stakingContract()), newStaking);
    }

    function test_setStakingContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setStakingContract(address(0));
    }

    function test_setStakingContract_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.setStakingContract(address(0x9ABC));
    }

    function test_setProtocolReserve() public {
        address newReserve = address(0xDEF0);
        sessions.setProtocolReserve(newReserve);
        assertEq(sessions.protocolReserve(), newReserve);
    }

    function test_setProtocolReserve_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setProtocolReserve(address(0));
    }

    function test_setProtocolReserve_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.setProtocolReserve(address(0xDEF0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test pause() and unpause()
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        sessions.pause();

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        vm.prank(seller);
        vm.expectRevert();
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, sig);
    }

    function test_unpause_allowsReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        sessions.pause();
        sessions.unpause();

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );

        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_50, nonce, deadline, sig);

        (,,,,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(SESSION_ID);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.pause();
    }

    function test_unpause_revert_notOwner() public {
        sessions.pause();
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //      Test domainSeparator()
    // ═══════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        bytes32 ds = sessions.domainSeparator();
        assertTrue(ds != bytes32(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //               Existing edge case tests below
    // ═══════════════════════════════════════════════════════════════════

    function test_settleTimeout_revert_beforeGracePeriod() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = signSpendingAuth(
            BUYER_PK, seller, SESSION_ID, 0, 0, 0, nonce, deadline
        );
        vm.prank(seller);
        sessions.reserve(buyer, SESSION_ID, USDC_100, nonce, deadline, sig);

        // Try to timeout immediately — should revert
        vm.expectRevert(AntseedSessions.TimeoutNotReached.selector);
        sessions.settleTimeout(SESSION_ID);
    }
}
