// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedSessions.sol";
import "../AntseedDeposits.sol";
import "../AntseedStaking.sol";
import "../AntseedStats.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";

contract AntseedSessionsTest is Test {
    MockUSDC public usdc;
    MockERC8004Registry public registry;
    AntseedStats public stats;
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

    // USDC amounts (6 decimals)
    uint128 constant USDC_100 = 100_000_000;
    uint128 constant USDC_50 = 50_000_000;
    uint128 constant USDC_30 = 30_000_000;
    uint128 constant USDC_60 = 60_000_000;
    uint128 constant USDC_10 = 10_000_000;
    uint128 constant USDC_150 = 150_000_000;

    uint256 constant STAKE_AMOUNT = 10_000_000; // MIN_SELLER_STAKE

    // AntSeed EIP-712 typehashes (must match contract)
    bytes32 constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );
    bytes32 constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        randomUser = vm.addr(RANDOM_PK);

        // Deploy contracts
        usdc = new MockUSDC();
        registry = new MockERC8004Registry();
        stats = new AntseedStats();
        staking = new AntseedStaking(address(usdc), address(registry), address(stats));
        deposits = new AntseedDeposits(address(usdc));
        sessions = new AntseedSessions(
            address(deposits),
            address(stats),
            address(staking)
        );

        // Wire contracts together
        deposits.setSessionsContract(address(sessions));
        stats.setSessionsContract(address(sessions));
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

        // Register on MockERC8004Registry
        vm.prank(addr);
        registry.register();

        deposits.setCreditLimitOverride(addr, type(uint256).max);

        usdc.mint(addr, depositAmount);
        vm.startPrank(addr);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(depositAmount);
        vm.stopPrank();
    }

    function createSeller(uint256 pk) internal {
        address addr = vm.addr(pk);

        // Register on MockERC8004Registry and stake with agentId
        vm.prank(addr);
        uint256 agentId = registry.register();

        usdc.mint(addr, STAKE_AMOUNT);
        vm.startPrank(addr);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(agentId, STAKE_AMOUNT);
        vm.stopPrank();
    }

    /**
     * @dev Sign an AntSeed SpendingAuth (our EIP-712 domain, version "7")
     */
    function signSpendingAuth(
        uint256 pk,
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal view returns (bytes memory) {
        bytes32 metadataHash = keccak256(abi.encode(cumulativeInputTokens, cumulativeOutputTokens, uint256(0), uint256(0)));
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                channelId,
                cumulativeAmount,
                metadataHash
            )
        );
        bytes32 digest = _hashTypedDataSessions(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Sign an AntSeed ReserveAuth (our EIP-712 domain, version "7")
     */
    function signReserveAuth(
        uint256 pk,
        bytes32 channelId,
        uint128 maxAmount,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RESERVE_AUTH_TYPEHASH,
                channelId,
                maxAmount,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataSessions(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function encodeMetadata(
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(cumulativeInputTokens, cumulativeOutputTokens, uint256(0), uint256(0));
    }

    function _hashTypedDataSessions(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", sessions.domainSeparator(), structHash));
    }

    /**
     * @dev Compute the channelId: keccak256(abi.encode(buyer, seller, salt))
     */
    function computeChannelId(bytes32 salt) internal view returns (bytes32) {
        return sessions.computeChannelId(buyer, seller, salt);
    }

    /**
     * @dev Full reserve helper: creates buyer+seller, computes channelId, signs, reserves.
     */
    function doReserve(
        bytes32 salt,
        uint128 maxAmount,
        uint256 buyerDeposit
    ) internal returns (bytes32 channelId) {
        createBuyer(BUYER_PK, buyerDeposit);
        createSeller(SELLER_PK);

        channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, maxAmount, deadline);

        vm.prank(seller);
        sessions.reserve(buyer, salt, maxAmount, deadline, reserveSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   RESERVE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_newSession() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Assert session state
        (
            address sBuyer,
            address sSeller,
            uint128 sDeposit,
            uint128 sSettled,
            ,
            uint256 sDeadline,
            uint256 sSettledAt,
            ,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(channelId);

        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, 0);
        assertGt(sDeadline, 0);
        assertEq(sSettledAt, 0);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);

        // USDC stays in Deposits (locked via reserved)
        assertEq(usdc.balanceOf(address(sessions)), 0);
        assertEq(usdc.balanceOf(address(deposits)), USDC_100);

        // Assert buyer's Deposits: reserved = maxAmount, available = 0
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, USDC_100);
        assertEq(available, 0); // all 100 USDC went to Sessions
    }

    function test_reserve_revert_sellerNotStaked() public {
        createBuyer(BUYER_PK, USDC_100);
        // Register seller but don't stake
        vm.prank(seller);
        registry.register();

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SellerNotStaked.selector);
        sessions.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_reserve_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 pastDeadline = block.timestamp - 1;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExpired.selector);
        sessions.reserve(buyer, salt, USDC_50, pastDeadline, reserveSig);
    }

    function test_reserve_revert_invalidSignature() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with wrong key
        bytes memory badSig = signReserveAuth(RANDOM_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidSignature.selector);
        sessions.reserve(buyer, salt, USDC_50, deadline, badSig);
    }

    function test_reserve_revert_firstSignCapExceeded() public {
        sessions.setConstant(keccak256("FIRST_SIGN_CAP"), 1_000_000);

        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint128 overCap = 1_000_001;
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, overCap, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.FirstSignCapExceeded.selector);
        sessions.reserve(buyer, salt, overCap, deadline, reserveSig);
    }

    function test_reserve_revert_sessionExists() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        // Try to reserve again with same salt (same channelId)
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_30, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExists.selector);
        sessions.reserve(buyer, salt, USDC_30, deadline, reserveSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   CLOSE TESTS (final settle)
    // ═══════════════════════════════════════════════════════════════════

    function test_close_partialAmount() public {
        bytes32 salt = keccak256("session-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 finalAmount = USDC_60;
        uint256 inputTokens = 5000;
        uint256 outputTokens = 2000;

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, inputTokens, outputTokens);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(inputTokens, outputTokens), metaSig);

        // Assert session state
        (
            ,
            ,
            ,
            uint128 sSettled,
            ,
            ,
            uint256 sSettledAt,
            ,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(channelId);

        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
        assertEq(sSettled, USDC_60);
        assertGt(sSettledAt, 0);

        // Platform fee = 60 * 500 / 10000 = 3 USDC
        uint256 platformFee = (uint256(USDC_60) * 500) / 10000;
        uint256 sellerPayout = uint256(USDC_60) - platformFee;
        assertEq(deposits.sellerEarnings(seller), sellerPayout);

        // Protocol reserve got the fee
        assertEq(usdc.balanceOf(protocolReserve), platformFee);

        // Buyer: refund of 40 USDC credited back
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, USDC_100 - USDC_100 + (USDC_100 - USDC_60)); // 0 + 40 = 40

        // Stats updated
        uint256 sellerAgentId = staking.getAgentId(seller);
        IAntseedStats.AgentStats memory s = stats.getStats(sellerAgentId);
        assertEq(s.sessionCount, 1);
        assertEq(s.totalVolumeUsdc, USDC_60);
        assertEq(s.totalInputTokens, 5000);
        assertEq(s.totalOutputTokens, 2000);
    }

    function test_close_fullDeposit() public {
        bytes32 salt = keccak256("session-close-full");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 finalAmount = USDC_100;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 10000, 5000);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(10000, 5000), metaSig);

        (,,,uint128 sSettled,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertEq(sSettled, USDC_100);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);

        // Buyer should have 0 available (no refund)
        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    function test_close_zeroAmount() public {
        bytes32 salt = keccak256("session-close-zero");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Close with 0 — full refund to buyer
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, 0, encodeMetadata(0, 0), metaSig);

        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);

        assertEq(deposits.sellerEarnings(seller), 0);
    }

    function test_close_revert_notSeller() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(randomUser);
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);
    }

    function test_close_revert_invalidMetadataSignature() public {
        bytes32 salt = keccak256("session-close-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Sign metadata with wrong key
        bytes memory badMetaSig = signSpendingAuth(RANDOM_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidSignature.selector);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), badMetaSig);
    }

    function test_close_revert_doubleClose() public {
        bytes32 salt = keccak256("session-double-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);

        // Try again — session already Settled
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, USDC_30, 0, 0);
        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionNotActive.selector);
        sessions.close(channelId, USDC_30, encodeMetadata(0, 0), metaSig2);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   SETTLE TESTS (mid-session)
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_midSession() public {
        bytes32 salt = keccak256("session-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 amount1 = USDC_30;
        bytes memory metaSig1 = signSpendingAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        sessions.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Session still active
        (,, uint128 sDeposit, uint128 sSettled,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, USDC_30);

        // Seller earnings credited for first settle
        uint256 fee1 = (uint256(USDC_30) * 500) / 10000;
        uint256 payout1 = uint256(USDC_30) - fee1;
        assertEq(deposits.sellerEarnings(seller), payout1);
    }

    function test_settle_thenClose() public {
        bytes32 salt = keccak256("session-settle-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // First settle: 30 USDC
        uint128 amount1 = USDC_30;
        bytes memory metaSig1 = signSpendingAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        sessions.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Then close: final cumulative = 60 USDC
        uint128 finalAmount = USDC_60;
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, finalAmount, 3000, 1500);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(3000, 1500), metaSig2);

        // Session settled
        (,,,uint128 sSettled,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
        assertEq(sSettled, USDC_60);

        // Total seller earnings = payout from 30 (settle) + payout from delta 30 (close)
        // Each delta of 30 has its own fee: 30 * 500/10000 = 1.5 USDC per delta
        uint256 fee30 = (uint256(USDC_30) * 500) / 10000;
        uint256 expectedEarnings = (uint256(USDC_30) - fee30) * 2; // two deltas of 30
        assertEq(deposits.sellerEarnings(seller), expectedEarnings);

        // Buyer refund = 100 - 60 = 40
        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100 - USDC_60);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TIMEOUT TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_requestTimeout_and_withdraw() public {
        bytes32 salt = keccak256("session-timeout");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        (, , , , , uint256 deadline, , ,) = sessions.sessions(channelId);

        // requestTimeout reverts before deadline
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.requestTimeout(channelId);

        // Warp past deadline
        vm.warp(deadline + 1);

        // Anyone can request timeout
        vm.prank(randomUser);
        sessions.requestTimeout(channelId);

        // Can't withdraw yet — need to wait for grace period (15 min)
        vm.expectRevert(AntseedSessions.TimeoutNotReady.selector);
        sessions.withdraw(channelId);

        // Warp past grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Now withdraw
        vm.prank(randomUser);
        sessions.withdraw(channelId);

        // Session timed out
        (,,,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.TimedOut);

        // Full deposit returned to buyer
        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_requestTimeout_revert_beforeDeadline() public {
        bytes32 salt = keccak256("session-timeout-early");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.requestTimeout(channelId);
    }

    function test_withdraw_revert_withoutRequestTimeout() public {
        bytes32 salt = keccak256("session-timeout-no-request");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        (, , , , , uint256 deadline, , ,) = sessions.sessions(channelId);
        vm.warp(deadline + 16 minutes);

        // withdraw without calling requestTimeout first
        vm.expectRevert(AntseedSessions.TimeoutNotReady.selector);
        sessions.withdraw(channelId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PLATFORM FEE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_close_platformFeeCalculation() public {
        bytes32 salt = keccak256("session-fee");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 chargeAmount = USDC_60;
        uint256 expectedPlatformFee = (uint256(chargeAmount) * 500) / 10000; // 3 USDC
        uint256 expectedSellerPayout = uint256(chargeAmount) - expectedPlatformFee; // 57 USDC

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, chargeAmount, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, chargeAmount, encodeMetadata(0, 0), metaSig);

        assertEq(deposits.sellerEarnings(seller), expectedSellerPayout);
        assertEq(usdc.balanceOf(protocolReserve), expectedPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   STATS TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_close_statsUpdate() public {
        bytes32 salt = keccak256("session-rep");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint256 inputToks = 7500;
        uint256 outputToks = 3200;

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_50, inputToks, outputToks);

        vm.prank(seller);
        sessions.close(channelId, USDC_50, encodeMetadata(inputToks, outputToks), metaSig);

        uint256 sellerAgentId = staking.getAgentId(seller);
        IAntseedStats.AgentStats memory s = stats.getStats(sellerAgentId);
        assertEq(s.sessionCount, 1);
        assertEq(s.totalVolumeUsdc, USDC_50);
        assertEq(s.totalInputTokens, inputToks);
        assertEq(s.totalOutputTokens, outputToks);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_setConstant_firstSignCap() public {
        sessions.setConstant(keccak256("FIRST_SIGN_CAP"), 2_000_000);
        assertEq(sessions.FIRST_SIGN_CAP(), 2_000_000);
    }

    function test_setConstant_platformFeeBps() public {
        sessions.setConstant(keccak256("PLATFORM_FEE_BPS"), 300);
        assertEq(sessions.PLATFORM_FEE_BPS(), 300);
    }

    function test_setConstant_revert_unknownKey() public {
        vm.expectRevert(AntseedSessions.InvalidAmount.selector);
        sessions.setConstant(keccak256("UNKNOWN_KEY"), 100);
    }

    function test_setConstant_revert_platformFeeBpsAboveMax() public {
        vm.expectRevert(AntseedSessions.InvalidFee.selector);
        sessions.setConstant(keccak256("PLATFORM_FEE_BPS"), 1001);
    }

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

    function test_setStatsContract() public {
        address newStats = address(0x5678);
        sessions.setStatsContract(newStats);
        assertEq(address(sessions.statsContract()), newStats);
    }

    function test_setStatsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setStatsContract(address(0));
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
    //                   PAUSE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        sessions.pause();

        bytes32 salt = keccak256("session-paused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert();
        sessions.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_unpause_allowsReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        sessions.pause();
        sessions.unpause();

        bytes32 salt = keccak256("session-unpaused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        sessions.reserve(buyer, salt, USDC_50, deadline, reserveSig);

        (,,,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.pause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TOP UP TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_topUp_afterSettling85Percent() public {
        bytes32 salt = keccak256("session-topup");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 85% of the deposit (85 USDC out of 100)
        uint128 settleAmount = 85_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);

        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        // Top up: increase reserve from 100 to 150 USDC
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        sessions.topUp(channelId, newMax, newDeadline, topUpSig);

        // Verify session state updated
        (,, uint128 sDeposit, uint128 sSettled,,uint256 sDeadline,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
        assertEq(sDeposit, USDC_150);
        assertEq(sSettled, settleAmount);
        assertEq(sDeadline, newDeadline);

        // Additional 50 USDC locked in Deposits
        (, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        // reserved = 100 (initial) - 85 (settled via chargeAndCreditEarnings releases reserved)
        // + 50 (topUp) ... but settle only charges, doesn't release reservation proportionally
        // Actually: settle charges delta=85 from reserved. reserved was 100, after settle reserved=100-85=15
        // No wait — chargeAndCreditEarnings gets reservedAmount=delta for settle, so reserved goes 100-85=15
        // Then topUp locks additional 50, so reserved = 15 + 50 = 65
        assertEq(reserved, 65_000_000);
    }

    function test_topUp_revert_thresholdNotMet() public {
        bytes32 salt = keccak256("session-topup-fail");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Only settle 50% (50 USDC out of 100) — below 85% threshold
        uint128 settleAmount = USDC_50;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 3000, 1000);

        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(3000, 1000), settleSig);

        // Try top up — should revert
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.TopUpThresholdNotMet.selector);
        sessions.topUp(channelId, newMax, newDeadline, topUpSig);
    }

    function test_topUp_revert_newAmountNotHigher() public {
        bytes32 salt = keccak256("session-topup-low");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        // Try topUp with same amount — should revert
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, USDC_100, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.TopUpAmountTooLow.selector);
        sessions.topUp(channelId, USDC_100, newDeadline, topUpSig);
    }

    function test_topUp_revert_notSeller() public {
        bytes32 salt = keccak256("session-topup-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(randomUser);
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.topUp(channelId, newMax, newDeadline, topUpSig);
    }

    function test_topUp_revert_expiredDeadline() public {
        bytes32 salt = keccak256("session-topup-expired");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 pastDeadline = block.timestamp - 1;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExpired.selector);
        sessions.topUp(channelId, newMax, pastDeadline, topUpSig);
    }

    function test_topUp_revert_invalidSignature() public {
        bytes32 salt = keccak256("session-topup-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        // Sign with wrong key
        bytes memory badSig = signReserveAuth(RANDOM_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidSignature.selector);
        sessions.topUp(channelId, newMax, newDeadline, badSig);
    }

    function test_topUp_settleAfterTopUp() public {
        bytes32 salt = keccak256("session-topup-then-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90 USDC
        uint128 settleAmount1 = 90_000_000;
        bytes memory settleSig1 = signSpendingAuth(BUYER_PK, channelId, settleAmount1, 5000, 2000);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount1, encodeMetadata(5000, 2000), settleSig1);

        // Top up to 150 USDC
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);
        vm.prank(seller);
        sessions.topUp(channelId, newMax, newDeadline, topUpSig);

        // Continue settling up to the new ceiling (120 cumulative)
        uint128 settleAmount2 = 120_000_000;
        bytes memory settleSig2 = signSpendingAuth(BUYER_PK, channelId, settleAmount2, 8000, 3500);
        vm.prank(seller);
        sessions.settle(channelId, settleAmount2, encodeMetadata(8000, 3500), settleSig2);

        (,, uint128 sDeposit, uint128 sSettled,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
        assertEq(sDeposit, USDC_150);
        assertEq(sSettled, 120_000_000);

        // Close at 130 cumulative
        uint128 finalAmount = 130_000_000;
        bytes memory closeSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 10000, 4000);
        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(10000, 4000), closeSig);

        (,,, uint128 sSettledFinal,,,,, AntseedSessions.SessionStatus sStatusFinal) = sessions.sessions(channelId);
        assertTrue(sStatusFinal == AntseedSessions.SessionStatus.Settled);
        assertEq(sSettledFinal, 130_000_000);

        // Buyer refund = 150 - 130 = 20 USDC
        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 20_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   DOMAIN SEPARATOR TEST
    // ═══════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        bytes32 ds = sessions.domainSeparator();
        assertTrue(ds != bytes32(0));
    }
}
