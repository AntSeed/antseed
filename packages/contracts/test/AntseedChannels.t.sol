// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedChannels.sol";
import "../AntseedDeposits.sol";
import "../AntseedStaking.sol";
import "../AntseedStats.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";

contract AntseedChannelsTest is Test {
    MockUSDC public usdc;
    MockERC8004Registry public registry;
    AntseedStats public stats;
    AntseedStaking public staking;
    AntseedDeposits public deposits;
    AntseedChannels public channels;

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
        channels = new AntseedChannels(
            address(deposits),
            address(stats),
            address(staking)
        );

        // Wire contracts together
        deposits.setChannelsContract(address(channels));
        stats.setChannelsContract(address(channels));
        staking.setChannelsContract(address(channels));
        channels.setProtocolReserve(protocolReserve);

        // Raise FIRST_SIGN_CAP for tests that need large reservations
        channels.setFirstSignCap(500_000_000);
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
        bytes32 digest = _hashTypedDataChannels(structHash);
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
        bytes32 digest = _hashTypedDataChannels(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function encodeMetadata(
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(cumulativeInputTokens, cumulativeOutputTokens, uint256(0), uint256(0));
    }

    function _hashTypedDataChannels(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    /**
     * @dev Compute the channelId: keccak256(abi.encode(buyer, seller, salt))
     */
    function computeChannelId(bytes32 salt) internal view returns (bytes32) {
        return channels.computeChannelId(buyer, seller, salt);
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
        channels.reserve(buyer, salt, maxAmount, deadline, reserveSig);
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
            AntseedChannels.ChannelStatus sStatus
        ) = channels.channels(channelId);

        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, 0);
        assertGt(sDeadline, 0);
        assertEq(sSettledAt, 0);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);

        // USDC stays in Deposits (locked via reserved)
        assertEq(usdc.balanceOf(address(channels)), 0);
        assertEq(usdc.balanceOf(address(deposits)), USDC_100);

        // Assert buyer's Deposits: reserved = maxAmount, available = 0
        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
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
        vm.expectRevert(AntseedChannels.SellerNotStaked.selector);
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_reserve_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 pastDeadline = block.timestamp - 1;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExpired.selector);
        channels.reserve(buyer, salt, USDC_50, pastDeadline, reserveSig);
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
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, USDC_50, deadline, badSig);
    }

    function test_reserve_revert_firstSignCapExceeded() public {
        channels.setFirstSignCap(1_000_000);

        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint128 overCap = 1_000_001;
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, overCap, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.FirstSignCapExceeded.selector);
        channels.reserve(buyer, salt, overCap, deadline, reserveSig);
    }

    function test_reserve_revert_sessionExists() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        // Try to reserve again with same salt (same channelId)
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_30, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExists.selector);
        channels.reserve(buyer, salt, USDC_30, deadline, reserveSig);
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
        channels.close(channelId, finalAmount, encodeMetadata(inputTokens, outputTokens), metaSig);

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
            AntseedChannels.ChannelStatus sStatus
        ) = channels.channels(channelId);

        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);
        assertGt(sSettledAt, 0);

        // Platform fee = 60 * 500 / 10000 = 3 USDC
        uint256 platformFee = (uint256(USDC_60) * 500) / 10000;
        uint256 sellerPayout = uint256(USDC_60) - platformFee;
        assertEq(deposits.sellerPayouts(seller), sellerPayout);

        // Protocol reserve got the fee
        assertEq(usdc.balanceOf(protocolReserve), platformFee);

        // Buyer: refund of 40 USDC credited back
        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
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
        channels.close(channelId, finalAmount, encodeMetadata(10000, 5000), metaSig);

        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertEq(sSettled, USDC_100);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);

        // Buyer should have 0 available (no refund)
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    function test_close_zeroAmount() public {
        bytes32 salt = keccak256("session-close-zero");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Close with 0 — full refund to buyer
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        channels.close(channelId, 0, encodeMetadata(0, 0), metaSig);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);

        assertEq(deposits.sellerPayouts(seller), 0);
    }

    function test_close_revert_notSeller() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);
    }

    function test_close_revert_invalidMetadataSignature() public {
        bytes32 salt = keccak256("session-close-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Sign metadata with wrong key
        bytes memory badMetaSig = signSpendingAuth(RANDOM_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), badMetaSig);
    }

    function test_close_revert_doubleClose() public {
        bytes32 salt = keccak256("session-double-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);

        // Try again — session already Settled
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, USDC_30, 0, 0);
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.close(channelId, USDC_30, encodeMetadata(0, 0), metaSig2);
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
        channels.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Session still active
        (,, uint128 sDeposit, uint128 sSettled,,,,, AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, USDC_30);

        // Seller payouts credited for first settle
        uint256 fee1 = (uint256(USDC_30) * 500) / 10000;
        uint256 payout1 = uint256(USDC_30) - fee1;
        assertEq(deposits.sellerPayouts(seller), payout1);
    }

    function test_settle_thenClose() public {
        bytes32 salt = keccak256("session-settle-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // First settle: 30 USDC
        uint128 amount1 = USDC_30;
        bytes memory metaSig1 = signSpendingAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        channels.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Then close: final cumulative = 60 USDC
        uint128 finalAmount = USDC_60;
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, finalAmount, 3000, 1500);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(3000, 1500), metaSig2);

        // Session settled
        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);

        // Total seller payouts = payout from 30 (settle) + payout from delta 30 (close)
        // Each delta of 30 has its own fee: 30 * 500/10000 = 1.5 USDC per delta
        uint256 fee30 = (uint256(USDC_30) * 500) / 10000;
        uint256 expectedPayouts = (uint256(USDC_30) - fee30) * 2; // two deltas of 30
        assertEq(deposits.sellerPayouts(seller), expectedPayouts);

        // Buyer refund = 100 - 60 = 40
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100 - USDC_60);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TIMEOUT TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_requestClose_and_withdraw() public {
        bytes32 salt = keccak256("session-close-req");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Operator can request close anytime — no deadline dependency
        vm.prank(operator);
        channels.requestClose(channelId);

        // Can't withdraw yet — need to wait for grace period (15 min)
        vm.prank(operator);
        vm.expectRevert(AntseedChannels.CloseNotReady.selector);
        channels.withdraw(channelId);

        // Warp past grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Operator can withdraw after grace period
        vm.prank(operator);
        channels.withdraw(channelId);

        // Session timed out (withdrawn)
        (,,,,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.TimedOut);

        // Full deposit returned to buyer
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_requestClose_revert_notBuyer() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Seller can't request close
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);

        // Random user can't request close
        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

    function test_requestClose_revert_alreadyRequested() public {
        bytes32 salt = keccak256("session-close-dup");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        vm.prank(operator);
        channels.requestClose(channelId);

        vm.prank(operator);
        vm.expectRevert(AntseedChannels.CloseAlreadyRequested.selector);
        channels.requestClose(channelId);
    }

    function test_withdraw_revert_notOperator() public {
        bytes32 salt = keccak256("session-withdraw-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        vm.prank(operator);
        channels.requestClose(channelId);

        vm.warp(block.timestamp + 15 minutes + 1);

        // Seller can't withdraw
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.withdraw(channelId);
    }

    function test_withdraw_revert_withoutRequestClose() public {
        bytes32 salt = keccak256("session-withdraw-no-req");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // withdraw without calling requestClose first
        vm.prank(operator);
        vm.expectRevert(AntseedChannels.CloseNotReady.selector);
        channels.withdraw(channelId);
    }

    function test_sellerCanStillCloseDuringGracePeriod() public {
        bytes32 salt = keccak256("session-grace-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Operator requests close
        vm.prank(operator);
        channels.requestClose(channelId);

        // Seller can still close with a SpendingAuth during grace period
        uint128 finalAmount = USDC_60;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 5000, 2000);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(5000, 2000), metaSig);

        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);

        // Buyer gets refund of 40 USDC
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100 - USDC_60);
    }

    function test_sellerCanSettleDuringGracePeriod() public {
        bytes32 salt = keccak256("session-grace-mid");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator for buyer
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Operator requests close
        vm.prank(operator);
        channels.requestClose(channelId);

        // Seller can still settle mid-session during grace period
        uint128 amount = USDC_30;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, amount, 1000, 500);

        vm.prank(seller);
        channels.settle(channelId, amount, encodeMetadata(1000, 500), metaSig);

        (,,, uint128 sSettled,,,,, AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sSettled, USDC_30);
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
        channels.close(channelId, chargeAmount, encodeMetadata(0, 0), metaSig);

        assertEq(deposits.sellerPayouts(seller), expectedSellerPayout);
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
        channels.close(channelId, USDC_50, encodeMetadata(inputToks, outputToks), metaSig);

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

    function test_setFirstSignCap() public {
        channels.setFirstSignCap(2_000_000);
        assertEq(channels.FIRST_SIGN_CAP(), 2_000_000);
    }

    function test_setPlatformFeeBps() public {
        channels.setPlatformFeeBps(300);
        assertEq(channels.PLATFORM_FEE_BPS(), 300);
    }

    function test_setPlatformFeeBps_revert_aboveMax() public {
        vm.expectRevert(AntseedChannels.InvalidFee.selector);
        channels.setPlatformFeeBps(1001);
    }

    function test_setDepositsContract() public {
        address newDeposits = address(0x1234);
        channels.setDepositsContract(newDeposits);
        assertEq(address(channels.depositsContract()), newDeposits);
    }

    function test_setDepositsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedChannels.InvalidAddress.selector);
        channels.setDepositsContract(address(0));
    }

    function test_setDepositsContract_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        channels.setDepositsContract(address(0x1234));
    }

    function test_setStatsContract() public {
        address newStats = address(0x5678);
        channels.setStatsContract(newStats);
        assertEq(address(channels.statsContract()), newStats);
    }

    function test_setStatsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedChannels.InvalidAddress.selector);
        channels.setStatsContract(address(0));
    }

    function test_setStakingContract() public {
        address newStaking = address(0x9ABC);
        channels.setStakingContract(newStaking);
        assertEq(address(channels.stakingContract()), newStaking);
    }

    function test_setStakingContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedChannels.InvalidAddress.selector);
        channels.setStakingContract(address(0));
    }

    function test_setProtocolReserve() public {
        address newReserve = address(0xDEF0);
        channels.setProtocolReserve(newReserve);
        assertEq(channels.protocolReserve(), newReserve);
    }

    function test_setProtocolReserve_revert_zeroAddress() public {
        vm.expectRevert(AntseedChannels.InvalidAddress.selector);
        channels.setProtocolReserve(address(0));
    }

    function test_setProtocolReserve_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        channels.setProtocolReserve(address(0xDEF0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PAUSE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        channels.pause();

        bytes32 salt = keccak256("session-paused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert();
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_unpause_allowsReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        channels.pause();
        channels.unpause();

        bytes32 salt = keccak256("session-unpaused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);

        (,,,,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        channels.pause();
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
        channels.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        // Top up: increase reserve from 100 to 150 USDC
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        channels.topUp(channelId, newMax, newDeadline, topUpSig);

        // Verify session state updated
        (,, uint128 sDeposit, uint128 sSettled,,uint256 sDeadline,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sDeposit, USDC_150);
        assertEq(sSettled, settleAmount);
        assertEq(sDeadline, newDeadline);

        // Additional 50 USDC locked in Deposits
        (, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        // reserved = 100 (initial) - 85 (settled via chargeAndCreditPayouts releases reserved)
        // + 50 (topUp) ... but settle only charges, doesn't release reservation proportionally
        // Actually: settle charges delta=85 from reserved. reserved was 100, after settle reserved=100-85=15
        // No wait — chargeAndCreditPayouts gets reservedAmount=delta for settle, so reserved goes 100-85=15
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
        channels.settle(channelId, settleAmount, encodeMetadata(3000, 1000), settleSig);

        // Try top up — should revert
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.TopUpThresholdNotMet.selector);
        channels.topUp(channelId, newMax, newDeadline, topUpSig);
    }

    function test_topUp_revert_newAmountNotHigher() public {
        bytes32 salt = keccak256("session-topup-low");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        channels.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        // Try topUp with same amount — should revert
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, USDC_100, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.TopUpAmountTooLow.selector);
        channels.topUp(channelId, USDC_100, newDeadline, topUpSig);
    }

    function test_topUp_revert_notSeller() public {
        bytes32 salt = keccak256("session-topup-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        channels.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.topUp(channelId, newMax, newDeadline, topUpSig);
    }

    function test_topUp_revert_expiredDeadline() public {
        bytes32 salt = keccak256("session-topup-expired");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        channels.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 pastDeadline = block.timestamp - 1;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExpired.selector);
        channels.topUp(channelId, newMax, pastDeadline, topUpSig);
    }

    function test_topUp_revert_invalidSignature() public {
        bytes32 salt = keccak256("session-topup-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory settleSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        vm.prank(seller);
        channels.settle(channelId, settleAmount, encodeMetadata(5000, 2000), settleSig);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        // Sign with wrong key
        bytes memory badSig = signReserveAuth(RANDOM_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.topUp(channelId, newMax, newDeadline, badSig);
    }

    function test_topUp_settleAfterTopUp() public {
        bytes32 salt = keccak256("session-topup-then-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90 USDC
        uint128 settleAmount1 = 90_000_000;
        bytes memory settleSig1 = signSpendingAuth(BUYER_PK, channelId, settleAmount1, 5000, 2000);
        vm.prank(seller);
        channels.settle(channelId, settleAmount1, encodeMetadata(5000, 2000), settleSig1);

        // Top up to 150 USDC
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory topUpSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);
        vm.prank(seller);
        channels.topUp(channelId, newMax, newDeadline, topUpSig);

        // Continue settling up to the new ceiling (120 cumulative)
        uint128 settleAmount2 = 120_000_000;
        bytes memory settleSig2 = signSpendingAuth(BUYER_PK, channelId, settleAmount2, 8000, 3500);
        vm.prank(seller);
        channels.settle(channelId, settleAmount2, encodeMetadata(8000, 3500), settleSig2);

        (,, uint128 sDeposit, uint128 sSettled,,,,, AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sDeposit, USDC_150);
        assertEq(sSettled, 120_000_000);

        // Close at 130 cumulative
        uint128 finalAmount = 130_000_000;
        bytes memory closeSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 10000, 4000);
        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(10000, 4000), closeSig);

        (,,, uint128 sSettledFinal,,,,, AntseedChannels.ChannelStatus sStatusFinal) = channels.channels(channelId);
        assertTrue(sStatusFinal == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettledFinal, 130_000_000);

        // Buyer refund = 150 - 130 = 20 USDC
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 20_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   DOMAIN SEPARATOR TEST
    // ═══════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        bytes32 ds = channels.domainSeparator();
        assertTrue(ds != bytes32(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   OPERATOR TESTS
    // ═══════════════════════════════════════════════════════════════════

    bytes32 constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address operator,uint256 nonce)"
    );

    function signSetOperator(
        uint256 buyerPk,
        address operator,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(SET_OPERATOR_TYPEHASH, operator, nonce)
        );
        bytes32 digest = _hashTypedDataChannels(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_setOperator() public {
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, operator, 0);

        channels.setOperator(buyer, operator, 0, sig);
        assertEq(deposits.getOperator(buyer), operator);
        assertEq(deposits.getOperatorNonce(buyer), 1);
    }

    function test_setOperator_revert_wrongNonce() public {
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, operator, 1); // nonce should be 0

        vm.expectRevert(AntseedChannels.InvalidNonce.selector);
        channels.setOperator(buyer, operator, 1, sig);
    }

    function test_setOperator_revert_wrongSigner() public {
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(RANDOM_PK, operator, 0); // wrong signer

        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.setOperator(buyer, operator, 0, sig);
    }

    function test_setOperator_revert_alreadySet() public {
        address op1 = address(0xABCDE2);
        address op2 = address(0xABCDE3);

        bytes memory sig1 = signSetOperator(BUYER_PK, op1, 0);
        channels.setOperator(buyer, op1, 0, sig1);

        // setOperator reverts when operator is already set
        bytes memory sig2 = signSetOperator(BUYER_PK, op2, 1);
        vm.expectRevert(AntseedChannels.OperatorAlreadySet.selector);
        channels.setOperator(buyer, op2, 1, sig2);
    }

    function test_transferOperator() public {
        address op1 = address(0xABCDE2);
        address op2 = address(0xABCDE3);

        // Set initial operator via buyer sig
        bytes memory sig = signSetOperator(BUYER_PK, op1, 0);
        channels.setOperator(buyer, op1, 0, sig);
        assertEq(deposits.getOperator(buyer), op1);

        // Current operator transfers to new operator
        vm.prank(op1);
        channels.transferOperator(buyer, op2);
        assertEq(deposits.getOperator(buyer), op2);
    }

    function test_transferOperator_revoke() public {
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, sig);

        // Operator revokes themselves
        vm.prank(operator);
        channels.transferOperator(buyer, address(0));
        assertEq(deposits.getOperator(buyer), address(0));
    }

    function test_transferOperator_revert_notOperator() public {
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, sig);

        // Random user cannot transfer
        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.transferOperator(buyer, address(0xBEEF));

        // Buyer cannot transfer (only operator can)
        vm.prank(buyer);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.transferOperator(buyer, address(0xBEEF));
    }

    function test_transferOperator_thenSetAgain() public {
        address op1 = address(0xABCDE2);
        address op2 = address(0xABCDE3);

        // Set initial operator
        bytes memory sig1 = signSetOperator(BUYER_PK, op1, 0);
        channels.setOperator(buyer, op1, 0, sig1);

        // Operator revokes (sets to zero)
        vm.prank(op1);
        channels.transferOperator(buyer, address(0));

        // Now buyer can setOperator again with a new sig (nonce is 2: incremented by setOperator + transferOperator)
        bytes memory sig2 = signSetOperator(BUYER_PK, op2, 2);
        channels.setOperator(buyer, op2, 2, sig2);
        assertEq(deposits.getOperator(buyer), op2);
    }

    function test_operator_canRequestClose() public {
        bytes32 salt = keccak256("session-operator-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Operator calls requestClose
        vm.prank(operator);
        channels.requestClose(channelId);

        (,,,,,,,uint256 closeRequestedAt,) = channels.channels(channelId);
        assertTrue(closeRequestedAt > 0);
    }

    function test_operator_canWithdraw() public {
        bytes32 salt = keccak256("session-operator-withdraw");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Operator requests close
        vm.prank(operator);
        channels.requestClose(channelId);

        // Wait grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Operator withdraws
        vm.prank(operator);
        channels.withdraw(channelId);

        // Funds returned to buyer's deposits balance
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_operator_revert_randomUserCannotClose() public {
        bytes32 salt = keccak256("session-operator-random");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Set operator to a specific address
        address operator = address(0xABCDE1);
        bytes memory opSig = signSetOperator(BUYER_PK, operator, 0);
        channels.setOperator(buyer, operator, 0, opSig);

        // Random user cannot close
        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

    function test_operator_revert_sellerCannotClose() public {
        bytes32 salt = keccak256("session-operator-seller");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // No operator set — seller should not be able to close
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

    function test_operator_anyoneCanSubmitSetOperator() public {
        // The tx can be submitted by anyone — auth comes from the buyer signature
        address operator = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, operator, 0);

        // Random user submits the tx
        vm.prank(randomUser);
        channels.setOperator(buyer, operator, 0, sig);

        assertEq(deposits.getOperator(buyer), operator);
    }
}
