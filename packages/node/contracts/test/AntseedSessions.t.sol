// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedSessions.sol";
import "../AntseedDeposits.sol";
import "../AntseedStaking.sol";
import "../AntseedIdentity.sol";
import "../MockUSDC.sol";
import "../vendor/TempoStreamChannel.sol";
import "../vendor/ITempoStreamChannel.sol";

contract AntseedSessionsTest is Test {
    MockUSDC public usdc;
    AntseedIdentity public identity;
    AntseedStaking public staking;
    AntseedDeposits public deposits;
    TempoStreamChannel public tempo;
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

    // AntSeed MetadataAuth EIP-712 typehash (must match contract)
    bytes32 constant METADATA_AUTH_TYPEHASH = keccak256(
        "MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    // Tempo Voucher EIP-712 typehash
    bytes32 constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(bytes32 channelId,uint128 cumulativeAmount)"
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
        tempo = new TempoStreamChannel();
        sessions = new AntseedSessions(
            address(tempo),
            address(deposits),
            address(identity),
            address(staking),
            address(usdc)
        );

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

        vm.prank(addr);
        identity.register(peerId, "ipfs://buyer");

        deposits.setCreditLimitOverride(addr, type(uint256).max);

        usdc.mint(addr, depositAmount);
        vm.startPrank(addr);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(depositAmount);
        vm.stopPrank();
    }

    function createSeller(uint256 pk) internal {
        address addr = vm.addr(pk);
        bytes32 peerId = keccak256(abi.encodePacked("seller-", pk));

        vm.prank(addr);
        identity.register(peerId, "ipfs://seller");

        usdc.mint(addr, STAKE_AMOUNT);
        vm.startPrank(addr);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT);
        vm.stopPrank();
    }

    /**
     * @dev Sign an AntSeed MetadataAuth (our EIP-712 domain)
     */
    function signMetadataAuth(
        uint256 pk,
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal view returns (bytes memory) {
        bytes32 metadataHash = keccak256(abi.encode(cumulativeInputTokens, cumulativeOutputTokens, uint256(0), uint256(0)));
        bytes32 structHash = keccak256(
            abi.encode(
                METADATA_AUTH_TYPEHASH,
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
     * @dev Sign a Tempo Voucher (Tempo's EIP-712 domain)
     */
    function signTempoVoucher(
        uint256 pk,
        bytes32 channelId,
        uint128 cumulativeAmount
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount)
        );
        bytes32 digest = _hashTypedDataTempo(structHash);
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

    function _hashTypedDataTempo(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", tempo.domainSeparator(), structHash));
    }

    /**
     * @dev Compute the channelId that Tempo will produce for a reserve call.
     *      payer = sessions contract, payee = sessions contract, authorizedSigner = buyer
     */
    function computeChannelId(bytes32 salt) internal view returns (bytes32) {
        return tempo.computeChannelId(
            address(sessions),
            address(sessions),
            address(usdc),
            salt,
            buyer
        );
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

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        sessions.reserve(buyer, salt, maxAmount, deadline, metaSig);
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
            uint128 sInputTokens,
            uint128 sOutputTokens,
            ,
            uint256 sDeadline,
            uint256 sSettledAt,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(channelId);

        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, 0);
        assertEq(sInputTokens, 0);
        assertEq(sOutputTokens, 0);
        assertGt(sDeadline, 0);
        assertEq(sSettledAt, 0);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);

        // Assert Tempo channel exists
        ITempoStreamChannel.Channel memory ch = tempo.getChannel(channelId);
        assertEq(ch.payer, address(sessions));
        assertEq(ch.payee, address(sessions));
        assertEq(ch.token, address(usdc));
        assertEq(ch.authorizedSigner, buyer);
        assertEq(ch.deposit, USDC_100);
        assertEq(ch.settled, 0);
        assertFalse(ch.finalized);

        // Assert buyer's Deposits: balance reduced, reserved released (both happen in transferToSessions)
        (uint256 available, uint256 reserved,,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);  // transferToSessions clears reserved
        assertEq(available, 0); // all 100 USDC went to Tempo
    }

    function test_reserve_revert_sellerNotStaked() public {
        createBuyer(BUYER_PK, USDC_100);
        // Register seller but don't stake
        vm.prank(seller);
        identity.register(keccak256("seller-unstaked"), "ipfs://seller");

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SellerNotStaked.selector);
        sessions.reserve(buyer, salt, USDC_50, deadline, metaSig);
    }

    function test_reserve_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 pastDeadline = block.timestamp - 1;

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExpired.selector);
        sessions.reserve(buyer, salt, USDC_50, pastDeadline, metaSig);
    }

    function test_reserve_revert_invalidSignature() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with wrong key
        bytes memory badSig = signMetadataAuth(RANDOM_PK, channelId, 0, 0, 0);

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

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.FirstSignCapExceeded.selector);
        sessions.reserve(buyer, salt, overCap, deadline, metaSig);
    }

    function test_reserve_revert_sessionExists() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        // Try to reserve again with same salt (same channelId)
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionExists.selector);
        sessions.reserve(buyer, salt, USDC_30, deadline, metaSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TOP-UP TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_topUp() public {
        bytes32 salt = keccak256("session-topup");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        // Top up with 30 more USDC
        vm.prank(seller);
        sessions.topUp(channelId, USDC_30);

        // Session deposit should be 80
        (,, uint128 sDeposit,,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertEq(sDeposit, USDC_50 + USDC_30);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);

        // Tempo channel deposit should match
        ITempoStreamChannel.Channel memory ch = tempo.getChannel(channelId);
        assertEq(ch.deposit, USDC_50 + USDC_30);
    }

    function test_topUp_revert_notSeller() public {
        bytes32 salt = keccak256("session-topup-auth");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        vm.prank(randomUser);
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.topUp(channelId, USDC_30);
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

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, finalAmount);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, finalAmount, inputTokens, outputTokens);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(inputTokens, outputTokens), voucherSig, metaSig);

        // Assert session state
        (
            ,
            ,
            ,
            uint128 sSettled,
            uint128 sInputTokens,
            uint128 sOutputTokens,
            ,
            ,
            uint256 sSettledAt,
            AntseedSessions.SessionStatus sStatus
        ) = sessions.sessions(channelId);

        assertTrue(sStatus == AntseedSessions.SessionStatus.Settled);
        assertEq(sSettled, USDC_60);
        assertEq(sInputTokens, 5000);
        assertEq(sOutputTokens, 2000);
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

        // Tempo channel should be finalized
        ITempoStreamChannel.Channel memory ch = tempo.getChannel(channelId);
        assertTrue(ch.finalized);

        // Reputation updated
        uint256 sellerTokenId = identity.getTokenId(seller);
        AntseedIdentity.Reputation memory rep = identity.getReputation(sellerTokenId);
        assertEq(rep.sessionCount, 1);
        assertEq(rep.totalSettledVolume, USDC_60);
        assertEq(rep.totalInputTokens, 5000);
        assertEq(rep.totalOutputTokens, 2000);
    }

    function test_close_fullDeposit() public {
        bytes32 salt = keccak256("session-close-full");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 finalAmount = USDC_100;
        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, finalAmount);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, finalAmount, 10000, 5000);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(10000, 5000), voucherSig, metaSig);

        (,,,uint128 sSettled,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
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
        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, 0);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, 0, encodeMetadata(0, 0), voucherSig, metaSig);

        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);

        assertEq(deposits.sellerEarnings(seller), 0);
    }

    function test_close_revert_notSeller() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, USDC_60);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(randomUser);
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), voucherSig, metaSig);
    }

    function test_close_revert_invalidMetadataSignature() public {
        bytes32 salt = keccak256("session-close-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, USDC_60);
        // Sign metadata with wrong key
        bytes memory badMetaSig = signMetadataAuth(RANDOM_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedSessions.InvalidSignature.selector);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), voucherSig, badMetaSig);
    }

    function test_close_revert_doubleClose() public {
        bytes32 salt = keccak256("session-double-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, USDC_60);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, USDC_60, encodeMetadata(0, 0), voucherSig, metaSig);

        // Try again — session already Settled
        vm.prank(seller);
        vm.expectRevert(AntseedSessions.SessionNotActive.selector);
        sessions.close(channelId, USDC_30, encodeMetadata(0, 0), voucherSig, metaSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   SETTLE TESTS (mid-session)
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_midSession() public {
        bytes32 salt = keccak256("session-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 amount1 = USDC_30;
        bytes memory voucherSig1 = signTempoVoucher(BUYER_PK, channelId, amount1);
        bytes memory metaSig1 = signMetadataAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        sessions.settle(channelId, amount1, encodeMetadata(1000, 500), voucherSig1, metaSig1);

        // Session still active
        (,, uint128 sDeposit, uint128 sSettled,,,,,, AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, USDC_30);

        // Tempo channel still open
        ITempoStreamChannel.Channel memory ch = tempo.getChannel(channelId);
        assertFalse(ch.finalized);
        assertEq(ch.settled, USDC_30);

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
        bytes memory voucherSig1 = signTempoVoucher(BUYER_PK, channelId, amount1);
        bytes memory metaSig1 = signMetadataAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        sessions.settle(channelId, amount1, encodeMetadata(1000, 500), voucherSig1, metaSig1);

        // Then close: final cumulative = 60 USDC
        uint128 finalAmount = USDC_60;
        bytes memory voucherSig2 = signTempoVoucher(BUYER_PK, channelId, finalAmount);
        bytes memory metaSig2 = signMetadataAuth(BUYER_PK, channelId, finalAmount, 3000, 1500);

        vm.prank(seller);
        sessions.close(channelId, finalAmount, encodeMetadata(3000, 1500), voucherSig2, metaSig2);

        // Session settled
        (,,,uint128 sSettled,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
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

    function test_requestClose_and_withdraw() public {
        bytes32 salt = keccak256("session-timeout");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        (, , , , , , , uint256 deadline, ,) = sessions.sessions(channelId);

        // requestClose reverts before deadline
        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.requestClose(channelId);

        // Warp past deadline
        vm.warp(deadline + 1);

        // Anyone can request close
        vm.prank(randomUser);
        sessions.requestClose(channelId);

        // Can't withdraw yet — need to wait for Tempo's grace period (15 min)
        vm.expectRevert(); // CloseNotReady from Tempo
        sessions.withdraw(channelId);

        // Warp past Tempo's grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Now withdraw
        vm.prank(randomUser);
        sessions.withdraw(channelId);

        // Session timed out
        (,,,,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.TimedOut);

        // Full deposit returned to buyer
        (uint256 available,,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_requestClose_revert_beforeDeadline() public {
        bytes32 salt = keccak256("session-timeout-early");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        vm.expectRevert(AntseedSessions.NotAuthorized.selector);
        sessions.requestClose(channelId);
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

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, chargeAmount);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, chargeAmount, 0, 0);

        vm.prank(seller);
        sessions.close(channelId, chargeAmount, encodeMetadata(0, 0), voucherSig, metaSig);

        assertEq(deposits.sellerEarnings(seller), expectedSellerPayout);
        assertEq(usdc.balanceOf(protocolReserve), expectedPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   REPUTATION TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_close_reputationUpdate() public {
        bytes32 salt = keccak256("session-rep");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint256 inputToks = 7500;
        uint256 outputToks = 3200;

        bytes memory voucherSig = signTempoVoucher(BUYER_PK, channelId, USDC_50);
        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, USDC_50, inputToks, outputToks);

        vm.prank(seller);
        sessions.close(channelId, USDC_50, encodeMetadata(inputToks, outputToks), voucherSig, metaSig);

        uint256 sellerTokenId = identity.getTokenId(seller);
        AntseedIdentity.Reputation memory rep = identity.getReputation(sellerTokenId);
        assertEq(rep.sessionCount, 1);
        assertEq(rep.totalSettledVolume, USDC_50);
        assertEq(rep.totalInputTokens, inputToks);
        assertEq(rep.totalOutputTokens, outputToks);
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

    function test_setStreamChannel() public {
        address newChannel = address(0x1111);
        sessions.setStreamChannel(newChannel);
        assertEq(address(sessions.streamChannel()), newChannel);
    }

    function test_setStreamChannel_revert_zeroAddress() public {
        vm.expectRevert(AntseedSessions.InvalidAddress.selector);
        sessions.setStreamChannel(address(0));
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

    function test_setIdentityContract() public {
        address newIdentity = address(0x5678);
        sessions.setIdentityContract(newIdentity);
        assertEq(address(sessions.identityContract()), newIdentity);
    }

    function test_setStakingContract() public {
        address newStaking = address(0x9ABC);
        sessions.setStakingContract(newStaking);
        assertEq(address(sessions.stakingContract()), newStaking);
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

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        vm.expectRevert();
        sessions.reserve(buyer, salt, USDC_50, deadline, metaSig);
    }

    function test_unpause_allowsReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        sessions.pause();
        sessions.unpause();

        bytes32 salt = keccak256("session-unpaused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory metaSig = signMetadataAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        sessions.reserve(buyer, salt, USDC_50, deadline, metaSig);

        (,,,,,,,,,AntseedSessions.SessionStatus sStatus) = sessions.sessions(channelId);
        assertTrue(sStatus == AntseedSessions.SessionStatus.Active);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        sessions.pause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   DOMAIN SEPARATOR TEST
    // ═══════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        bytes32 ds = sessions.domainSeparator();
        assertTrue(ds != bytes32(0));
    }

    function test_tempoDomainSeparator_differs() public view {
        // AntSeed and Tempo domains must be different
        bytes32 antseedDs = sessions.domainSeparator();
        bytes32 tempoDs = tempo.domainSeparator();
        assertTrue(antseedDs != tempoDs);
    }
}
