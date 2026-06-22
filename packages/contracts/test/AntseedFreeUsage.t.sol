// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../payments/AntseedFreeUsage.sol";
import "../interfaces/IAntseedFreeUsage.sol";
import "../interfaces/IAntseedStats.sol";
import "../staking/AntseedStaking.sol";
import "../core/AntseedRegistry.sol";
import "../stats/AntseedStats.sol";
import "./mocks/MockERC8004Registry.sol";
import "./mocks/MockUSDC.sol";

contract AntseedFreeUsageTest is Test {
    MockUSDC public usdc;
    MockERC8004Registry public identityRegistry;
    AntseedRegistry public registry;
    AntseedStaking public staking;
    AntseedStats public stats;
    AntseedFreeUsage public freeUsage;

    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    uint256 constant RANDOM_PK = 0xDEAD;
    uint256 constant STAKE_AMOUNT = 10_000_000;

    bytes32 constant FREE_USAGE_OPEN_TYPEHASH = keccak256(
        "FreeUsageOpen(bytes32 channelId,uint256 deadline)"
    );
    bytes32 constant FREE_USAGE_AUTH_TYPEHASH = keccak256(
        "FreeUsageAuth(bytes32 channelId,uint256 sequence,bytes32 metadataHash,uint256 deadline)"
    );

    address public buyer;
    address public seller;
    address public randomUser;
    uint256 public sellerAgentId;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        randomUser = vm.addr(RANDOM_PK);

        usdc = new MockUSDC();
        identityRegistry = new MockERC8004Registry();
        registry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(registry));
        stats = new AntseedStats();
        freeUsage = new AntseedFreeUsage(address(registry));

        registry.setStaking(address(staking));
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setStats(address(stats));

        vm.prank(seller);
        sellerAgentId = identityRegistry.register();

        usdc.mint(seller, STAKE_AMOUNT);
        vm.startPrank(seller);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(sellerAgentId, STAKE_AMOUNT);
        vm.stopPrank();
    }

    function test_openRecordAndCloseFreeUsage() public {
        bytes32 salt = keccak256("free-session-1");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 openDeadline = block.timestamp + 1 hours;
        bytes memory openSig = signOpen(BUYER_PK, channelId, openDeadline);

        vm.prank(seller);
        freeUsage.open(buyer, salt, openDeadline, openSig);

        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        uint256 usageDeadline = block.timestamp + 30 minutes;
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, usageDeadline);
        vm.prank(seller);
        freeUsage.record(channelId, 1, metadata, usageDeadline, usageSig);

        (
            address storedBuyer,
            address storedSeller,
            uint256 latestSequence,
            bytes32 metadataHash,
            ,
            ,
            ,
            IAntseedFreeUsage.ChannelStatus status
        ) = freeUsage.channels(channelId);

        assertEq(storedBuyer, buyer);
        assertEq(storedSeller, seller);
        assertEq(latestSequence, 1);
        assertEq(metadataHash, keccak256(metadata));
        assertEq(uint256(status), uint256(IAntseedFreeUsage.ChannelStatus.Active));

        AntseedFreeUsage.AgentStats memory agentStats = freeUsage.getAgentStats(sellerAgentId);
        assertEq(agentStats.channelCount, 1);
        assertEq(agentStats.lastSettledAt, block.timestamp);

        bytes memory closeMetadata = encodeMetadata(150, 80, 2, oneService(), zeroPrices());
        bytes memory closeSig = signUsage(BUYER_PK, channelId, 2, closeMetadata, usageDeadline);
        vm.prank(seller);
        freeUsage.close(channelId, 2, closeMetadata, usageDeadline, closeSig);

        agentStats = freeUsage.getAgentStats(sellerAgentId);
        assertEq(agentStats.channelCount, 1);
        assertEq(agentStats.lastSettledAt, block.timestamp);
        assertEq(freeUsage.activeChannelCount(seller), 0);
    }

    function test_record_acceptsOpaqueMetadataWithoutPriceValidation() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1;
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), prices);
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, deadline);

        vm.prank(seller);
        freeUsage.record(channelId, 1, metadata, deadline, usageSig);

        (, , uint256 latestSequence, bytes32 metadataHash, , , , ) = freeUsage.channels(channelId);
        assertEq(latestSequence, 1);
        assertEq(metadataHash, keccak256(metadata));
    }

    function test_record_revert_badSignature() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(RANDOM_PK, channelId, 1, metadata, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.InvalidSignature.selector);
        freeUsage.record(channelId, 1, metadata, deadline, usageSig);
    }

    function test_record_revert_nonMonotonicSequence() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata1 = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        bytes memory usageSig1 = signUsage(BUYER_PK, channelId, 1, metadata1, deadline);
        vm.prank(seller);
        freeUsage.record(channelId, 1, metadata1, deadline, usageSig1);

        bytes memory metadata2 = encodeMetadata(110, 50, 1, oneService(), zeroPrices());
        bytes memory usageSig2 = signUsage(BUYER_PK, channelId, 1, metadata2, deadline);
        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.InvalidAmount.selector);
        freeUsage.record(channelId, 1, metadata2, deadline, usageSig2);
    }

    function test_record_syncsOptionalExternalStatsWhenAuthorized() public {
        stats.setWriter(address(freeUsage), true);

        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata = encodeMetadata(100, 40, 2, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 2, metadata, deadline);

        vm.prank(seller);
        freeUsage.record(channelId, 2, metadata, deadline, usageSig);

        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(sellerAgentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 2);
    }

    function test_open_revert_expired() public {
        vm.warp(1000);
        bytes32 salt = keccak256("expired-open");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp - 1;
        bytes memory openSig = signOpen(BUYER_PK, channelId, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.ChannelExpired.selector);
        freeUsage.open(buyer, salt, deadline, openSig);
    }

    function test_open_revert_paused() public {
        bytes32 salt = keccak256("paused-open");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory openSig = signOpen(BUYER_PK, channelId, deadline);

        freeUsage.pause();

        vm.prank(seller);
        vm.expectRevert();
        freeUsage.open(buyer, salt, deadline, openSig);
    }

    function test_open_revert_sellerNotStaked() public {
        bytes32 salt = keccak256("unstaked-open");
        bytes32 channelId = freeUsage.computeChannelId(buyer, randomUser, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory openSig = signOpen(BUYER_PK, channelId, deadline);

        vm.prank(randomUser);
        vm.expectRevert(AntseedFreeUsage.SellerNotStaked.selector);
        freeUsage.open(buyer, salt, deadline, openSig);
    }

    function test_open_revert_channelExists() public {
        bytes32 salt = keccak256("double-open");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory openSig = signOpen(BUYER_PK, channelId, deadline);

        vm.startPrank(seller);
        freeUsage.open(buyer, salt, deadline, openSig);
        vm.expectRevert(AntseedFreeUsage.ChannelExists.selector);
        freeUsage.open(buyer, salt, deadline, openSig);
        vm.stopPrank();
    }

    function test_record_revert_expiredChannel() public {
        bytes32 salt = keccak256("expired-record");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 channelDeadline = block.timestamp + 1;
        bytes memory openSig = signOpen(BUYER_PK, channelId, channelDeadline);
        vm.prank(seller);
        freeUsage.open(buyer, salt, channelDeadline, openSig);

        vm.warp(channelDeadline + 1);
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        uint256 usageDeadline = block.timestamp + 1 hours;
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, usageDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.ChannelExpired.selector);
        freeUsage.record(channelId, 1, metadata, usageDeadline, usageSig);
    }

    function test_close_revert_expiredChannel() public {
        bytes32 salt = keccak256("expired-close");
        bytes32 channelId = freeUsage.computeChannelId(buyer, seller, salt);
        uint256 channelDeadline = block.timestamp + 1;
        bytes memory openSig = signOpen(BUYER_PK, channelId, channelDeadline);
        vm.prank(seller);
        freeUsage.open(buyer, salt, channelDeadline, openSig);

        vm.warp(channelDeadline + 1);
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        uint256 usageDeadline = block.timestamp + 1 hours;
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, usageDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.ChannelExpired.selector);
        freeUsage.close(channelId, 1, metadata, usageDeadline, usageSig);
    }

    function test_recordAndClose_revert_notAuthorized() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, deadline);

        vm.prank(randomUser);
        vm.expectRevert(AntseedFreeUsage.NotAuthorized.selector);
        freeUsage.record(channelId, 1, metadata, deadline, usageSig);

        vm.prank(randomUser);
        vm.expectRevert(AntseedFreeUsage.NotAuthorized.selector);
        freeUsage.close(channelId, 1, metadata, deadline, usageSig);
    }

    function test_record_revert_afterClose() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 1, metadata, deadline);

        vm.prank(seller);
        freeUsage.close(channelId, 1, metadata, deadline, usageSig);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.ChannelNotActive.selector);
        freeUsage.record(channelId, 1, metadata, deadline, usageSig);
    }

    function test_record_revert_crossChannelSignature() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes32 otherChannelId = freeUsage.computeChannelId(buyer, seller, keccak256("other-channel"));
        bytes memory metadata = encodeMetadata(100, 40, 1, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(BUYER_PK, otherChannelId, 1, metadata, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedFreeUsage.InvalidSignature.selector);
        freeUsage.record(channelId, 1, metadata, deadline, usageSig);
    }

    function test_close_sequenceZeroDoesNotIncrementStats() public {
        (bytes32 channelId, uint256 deadline) = openFreeChannel();
        bytes memory metadata = encodeMetadata(0, 0, 0, oneService(), zeroPrices());
        bytes memory usageSig = signUsage(BUYER_PK, channelId, 0, metadata, deadline);

        vm.prank(seller);
        freeUsage.close(channelId, 0, metadata, deadline, usageSig);

        AntseedFreeUsage.AgentStats memory agentStats = freeUsage.getAgentStats(sellerAgentId);
        assertEq(agentStats.channelCount, 0);
        assertEq(agentStats.lastSettledAt, 0);
        assertEq(freeUsage.activeChannelCount(seller), 0);
    }

    function test_computeChannelId_isSeparatedFromPaidChannels() public view {
        bytes32 salt = keccak256("shared-salt");
        bytes32 paidChannelId = keccak256(abi.encode(buyer, seller, salt));
        bytes32 freeChannelId = freeUsage.computeChannelId(buyer, seller, salt);

        assertTrue(freeChannelId != paidChannelId);
    }

    function openFreeChannel() internal returns (bytes32 channelId, uint256 deadline) {
        bytes32 salt = keccak256("free-session");
        channelId = freeUsage.computeChannelId(buyer, seller, salt);
        deadline = block.timestamp + 1 hours;
        bytes memory openSig = signOpen(BUYER_PK, channelId, deadline);
        vm.prank(seller);
        freeUsage.open(buyer, salt, deadline, openSig);
    }

    function signOpen(uint256 pk, bytes32 channelId, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(FREE_USAGE_OPEN_TYPEHASH, channelId, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", freeUsage.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function signUsage(
        uint256 pk,
        bytes32 channelId,
        uint256 sequence,
        bytes memory metadata,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(FREE_USAGE_AUTH_TYPEHASH, channelId, sequence, keccak256(metadata), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", freeUsage.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function encodeMetadata(
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens,
        uint256 cumulativeRequestCount,
        bytes32[] memory services,
        uint256[] memory prices
    ) internal pure returns (bytes memory) {
        return abi.encode(uint256(1), cumulativeInputTokens, cumulativeOutputTokens, cumulativeRequestCount, services, prices);
    }

    function oneService() internal pure returns (bytes32[] memory services) {
        services = new bytes32[](1);
        services[0] = keccak256("gpt-free");
    }

    function zeroPrices() internal pure returns (uint256[] memory prices) {
        prices = new uint256[](1);
        prices[0] = 0;
    }
}
