// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { MockUSDC } from "../MockUSDC.sol";
import { MockERC8004Registry } from "../MockERC8004Registry.sol";
import { ANTSToken } from "../ANTSToken.sol";
import { AntseedRegistry } from "../AntseedRegistry.sol";
import { AntseedDeposits } from "../AntseedDeposits.sol";
import { AntseedStaking } from "../AntseedStaking.sol";
import { AntseedChannels } from "../AntseedChannels.sol";
import { AntseedEmissions } from "../AntseedEmissions.sol";
import { DiemStakingProxy } from "../DiemStakingProxy.sol";
import { AntseedSellerDelegation } from "../AntseedSellerDelegation.sol";

import { MockDiem } from "./mocks/MockDiem.sol";

contract DiemStakingProxyTest is Test {
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant ALICE_PK = 0x0C;
    uint256 constant BOB_PK = 0x0D;
    uint256 constant BUYER_PK = 0xA11CE;

    uint256 constant DIEM_COOLDOWN = 1 days;
    uint256 constant PROXY_STAKE = 10_000_000; // MIN_SELLER_STAKE
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    address owner;
    address operator;
    address alice;
    address bob;
    address buyer;
    address buyerOperator = address(0xAA);
    address protocolReserve = address(0xFEE);
    address teamWallet = address(0xBEEF);

    MockDiem diem;
    MockUSDC usdc;
    ANTSToken ants;

    MockERC8004Registry identityRegistry;
    AntseedRegistry antseedRegistry;
    AntseedDeposits deposits;
    AntseedStaking staking;
    AntseedChannels channels;
    AntseedEmissions emissions;

    DiemStakingProxy proxy;
    uint256 proxyAgentId;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");
    uint256 constant METADATA_VERSION = 1;

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        buyer = vm.addr(BUYER_PK);

        vm.warp(1_700_000_000);

        diem = new MockDiem(DIEM_COOLDOWN);
        usdc = new MockUSDC();
        ants = new ANTSToken();

        identityRegistry = new MockERC8004Registry();
        antseedRegistry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        staking = new AntseedStaking(address(usdc), address(antseedRegistry));
        channels = new AntseedChannels(address(antseedRegistry));
        emissions = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

        antseedRegistry.setChannels(address(channels));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setStaking(address(staking));
        antseedRegistry.setEmissions(address(emissions));
        antseedRegistry.setAntsToken(address(ants));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(protocolReserve);
        antseedRegistry.setTeamWallet(teamWallet);

        deposits.setRegistry(address(antseedRegistry));
        ants.setRegistry(address(antseedRegistry));

        channels.setFirstSignCap(10_000_000_000);

        vm.prank(owner);
        proxy = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);

        vm.prank(address(proxy));
        proxyAgentId = identityRegistry.register();

        usdc.mint(address(this), PROXY_STAKE);
        usdc.approve(address(staking), PROXY_STAKE);
        staking.stakeFor(address(proxy), proxyAgentId, PROXY_STAKE);

        ants.setTransferWhitelist(address(proxy), true);

        vm.prank(owner);
        proxy.setMaxTotalStake(0);

        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(0);
    }

    function _stakeAs(address user, uint256 amount) internal {
        diem.mint(user, amount);
        vm.startPrank(user);
        diem.approve(address(proxy), amount);
        proxy.stake(amount);
        vm.stopPrank();
    }

    function _setupBuyer(uint256 depositAmount) internal {
        vm.prank(buyer);
        identityRegistry.register();

        deposits.setCreditLimitOverride(buyer, type(uint256).max);

        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), buyerOperator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, buyerOperator, nonce, abi.encodePacked(r, s, v));

        usdc.mint(buyerOperator, depositAmount);
        vm.startPrank(buyerOperator);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(buyer, depositAmount);
        vm.stopPrank();
    }

    function _hashTypedDataChannels(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _signReserveAuth(bytes32 channelId, uint128 maxAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, channelId, maxAmount, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _signSpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes memory metadata)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, channelId, cumulativeAmount, keccak256(metadata)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _encodeMetadata(uint256 inputTokens, uint256 outputTokens) internal pure returns (bytes memory) {
        return abi.encode(METADATA_VERSION, inputTokens, outputTokens, uint256(0));
    }

    function _rewardEpochs(uint32 first, uint32 count) internal pure returns (uint32[] memory epochs) {
        epochs = new uint32[](count);
        for (uint32 i = 0; i < count; i++) {
            epochs[i] = first + i;
        }
    }

    function _reserveViaProxy(bytes32 salt, uint128 maxAmount, uint256 depositAmount)
        internal
        returns (bytes32 channelId)
    {
        _setupBuyer(depositAmount);
        channelId = channels.computeChannelId(buyer, address(proxy), salt);
        bytes memory reserveSig = _signReserveAuth(channelId, maxAmount, block.timestamp + 1 days);
        vm.prank(operator);
        proxy.reserve(buyer, salt, maxAmount, block.timestamp + 1 days, reserveSig);
    }

    function _settleViaProxy(bytes32 channelId, uint128 cumulativeAmount) internal {
        bytes memory metadata = _encodeMetadata(cumulativeAmount, 0);
        bytes memory sig = _signSpendingAuth(channelId, cumulativeAmount, metadata);
        vm.prank(operator);
        proxy.settle(channelId, cumulativeAmount, metadata, sig);
    }

    function _closeViaProxy(bytes32 channelId, uint128 finalAmount) internal {
        bytes memory metadata = _encodeMetadata(finalAmount, 0);
        bytes memory sig = _signSpendingAuth(channelId, finalAmount, metadata);
        vm.prank(operator);
        proxy.close(channelId, finalAmount, metadata, sig);
    }

    function test_stake_success() public {
        _stakeAs(alice, 100e18);

        assertEq(proxy.staked(alice), 100e18);
        assertEq(proxy.totalStaked(), 100e18);
        (uint256 amountStaked,,) = diem.stakedInfos(address(proxy));
        assertEq(amountStaked, 100e18);
    }

    function test_stake_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.InvalidAmount.selector);
        proxy.stake(0);
    }

    function test_initiateUnstake_queuesAndStopsAccrual() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 100e6, 200e6);
        _settleViaProxy(channelId, 90e6);

        uint256 earnedBefore = proxy.earnedUsdc(alice);
        assertGt(earnedBefore, 0);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        assertEq(proxy.staked(alice), 0);
        assertEq(proxy.totalStaked(), 0);

        uint32 batchId = proxy.currentUnstakeBatch();
        (uint128 total, uint64 unlockAt, uint32 userCount, bool claimed) = proxy.unstakeBatches(batchId);
        assertEq(total, 100e18);
        assertEq(userCount, 1);
        assertFalse(claimed);
        assertEq(unlockAt, 0, "no unlockAt until flush");
        assertEq(proxy.unstakeBatchUserAmount(batchId, alice), 100e18);

        vm.warp(block.timestamp + 5 hours);
        uint256 earnedAfter = proxy.earnedUsdc(alice);
        assertEq(earnedAfter, earnedBefore, "no further accrual on queued balance");
    }

    function test_initiateUnstake_sameEpochAccumulates() public {
        _stakeAs(alice, 200e18);

        vm.prank(alice);
        proxy.initiateUnstake(50e18);
        uint32 batchId = proxy.currentUnstakeBatch();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(alice);
        proxy.initiateUnstake(30e18);

        (uint128 total,, uint32 userCount,) = proxy.unstakeBatches(batchId);
        assertEq(total, 80e18);
        assertEq(userCount, 1, "same user shouldn't add a second row");
        assertEq(proxy.unstakeBatchUserAmount(batchId, alice), 80e18);
    }

    function test_twoUsersSameEpoch_paidInOneClaim() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();

        vm.warp(block.timestamp + 6 hours);
        vm.prank(bob);
        proxy.initiateUnstake(50e18);

        (uint128 total,, uint32 userCount,) = proxy.unstakeBatches(batchId);
        assertEq(total, 150e18);
        assertEq(userCount, 2);

        proxy.flush();
        assertEq(proxy.currentUnstakeBatch(), batchId + 1, "flush advances currentUnstakeBatch");

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(batchId);

        assertEq(diem.balanceOf(alice), 100e18);
        assertEq(diem.balanceOf(bob), 50e18);
        assertEq(diem.balanceOf(address(proxy)), 0, "proxy direct balance must return to 0");
    }

    function test_flush_revertsWhenNothingQueued() public {
        vm.expectRevert(DiemStakingProxy.NothingToFlush.selector);
        proxy.flush();
    }

    function test_flush_revertsWhilePriorBatchUnclaimed() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        proxy.flush();

        vm.prank(bob);
        proxy.initiateUnstake(50e18);

        vm.expectRevert(DiemStakingProxy.PriorUnstakeBatchUnclaimed.selector);
        proxy.flush();
    }

    function test_flush_revertsBeforeMinUnstakeBatchOpenSecs() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        vm.warp(block.timestamp + 6 hours - 1);
        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        vm.warp(block.timestamp + 1);
        proxy.flush();
    }

    function test_flush_succeedsImmediatelyWhenBatchFull() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        for (uint256 i = 0; i < proxy.MAX_PER_UNSTAKE_BATCH(); i++) {
            address user = address(uint160(0x1000 + i));
            _stakeAs(user, 1e18);
            vm.prank(user);
            proxy.initiateUnstake(1e18);
        }

        (,, uint32 userCount,) = proxy.unstakeBatches(proxy.currentUnstakeBatch());
        assertEq(userCount, proxy.MAX_PER_UNSTAKE_BATCH());
        proxy.flush();
    }

    function test_flush_windowMeasuredFromFirstQueuer() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 50e18);
        vm.prank(alice);
        proxy.initiateUnstake(50e18);
        uint32 firstBatch = proxy.currentUnstakeBatch();
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(firstBatch);

        vm.warp(block.timestamp + 7 days);
        assertEq(proxy.currentUnstakeBatchOpenedAt(), 0, "no queuer: clock not started");

        _stakeAs(bob, 50e18);
        vm.prank(bob);
        proxy.initiateUnstake(50e18);

        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
    }

    function test_flush_windowNotExtendedByLaterQueuers() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint64 openedAt = proxy.currentUnstakeBatchOpenedAt();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(bob);
        proxy.initiateUnstake(50e18);
        assertEq(proxy.currentUnstakeBatchOpenedAt(), openedAt, "later queuer must not bump clock");

        vm.warp(openedAt + 6 hours);
        proxy.flush();
    }

    function test_flushableAt_reflectsWindow() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        assertEq(proxy.flushableAt(), 0, "empty batch: zero");

        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        uint64 openedAt = proxy.currentUnstakeBatchOpenedAt();
        assertEq(proxy.flushableAt(), openedAt + 6 hours);

        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
        assertEq(proxy.flushableAt(), 0, "post-flush empty: zero");
    }

    function test_setMinUnstakeBatchOpenSecs_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.setMinUnstakeBatchOpenSecs(1 hours);
    }

    function test_setMinUnstakeBatchOpenSecs_enforcesUpperBound() public {
        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.MinUnstakeBatchOpenSecsTooLarge.selector);
        proxy.setMinUnstakeBatchOpenSecs(7 days + 1);

        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(7 days);
        assertEq(proxy.minUnstakeBatchOpenSecs(), 7 days);
    }

    function test_pause_onlyOwnerAndUnpauseRestoresStake() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.pause();

        vm.prank(owner);
        proxy.pause();

        diem.mint(alice, 10e18);
        vm.startPrank(alice);
        diem.approve(address(proxy), 10e18);
        vm.expectRevert();
        proxy.stake(10e18);
        vm.stopPrank();

        vm.prank(owner);
        proxy.unpause();

        vm.prank(alice);
        proxy.stake(10e18);
        assertEq(proxy.staked(alice), 10e18);
    }

    function test_pause_blocksUserFacingFlowsButAllowsExitAndSync() public {
        _stakeAs(alice, 100e18);
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.prank(alice);
        proxy.initiateUnstake(50e18);
        uint32 batchId = proxy.currentUnstakeBatch();
        proxy.flush();

        vm.prank(owner);
        proxy.pause();

        diem.mint(bob, 1e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 1e18);
        vm.expectRevert();
        proxy.stake(1e18);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert();
        proxy.initiateUnstake(1e18);

        vm.expectRevert();
        proxy.flush();

        bytes memory pausedMetadata = _encodeMetadata(600e6, 0);
        bytes memory pausedSig = _signSpendingAuth(channelId, 600e6, pausedMetadata);

        vm.prank(operator);
        vm.expectRevert();
        proxy.settle(channelId, 600e6, pausedMetadata, pausedSig);

        vm.prank(operator);
        vm.expectRevert();
        proxy.close(channelId, 600e6, pausedMetadata, pausedSig);

        vm.prank(alice);
        vm.expectRevert();
        proxy.claimUsdc();

        vm.prank(alice);
        vm.expectRevert();
        proxy.claimAnts(_rewardEpochs(0, 1));

        vm.prank(alice);
        vm.expectRevert();
        proxy.catchUpPoints(1);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        proxy.syncRewardEpochs(1);
        assertEq(proxy.syncedRewardEpoch(), 1, "sync remains available while paused");

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        uint256 before = diem.balanceOf(alice);
        proxy.claimUnstakeBatch(batchId);
        assertEq(diem.balanceOf(alice) - before, 50e18, "exits remain available while paused");
    }

    function _advanceRewardEpochs(uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            skip(EPOCH_DURATION + 1);
            proxy.syncRewardEpochs(1);
        }
    }

    function test_catchUpPoints_clearsBacklog() public {
        _stakeAs(alice, 100e18);

        _advanceRewardEpochs(17);
        assertEq(proxy.syncedRewardEpoch(), 17);
        assertEq(proxy.userCurrentEpoch(alice), 0);

        diem.mint(alice, 10e18);
        vm.startPrank(alice);
        diem.approve(address(proxy), 10e18);
        vm.expectRevert(DiemStakingProxy.BacklogTooLarge.selector);
        proxy.stake(10e18);
        vm.expectRevert(DiemStakingProxy.BacklogTooLarge.selector);
        proxy.initiateUnstake(10e18);
        vm.expectRevert(DiemStakingProxy.BacklogTooLarge.selector);
        proxy.claimUsdc();
        vm.stopPrank();

        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.userCurrentEpoch(alice), 16);

        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.userCurrentEpoch(alice), 17);

        vm.prank(alice);
        proxy.initiateUnstake(10e18);
    }

    function test_catchUpPoints_settlesUsdc() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        uint256 paidBefore = proxy.userUsdcRewardPerTokenPaid(alice);
        uint256 storedAfterSettle = proxy.usdcRewardPerTokenStored();
        assertGt(storedAfterSettle, paidBefore, "settle must bump the global accumulator");

        _advanceRewardEpochs(17);

        vm.prank(alice);
        proxy.catchUpPoints(16);

        assertEq(
            proxy.userUsdcRewardPerTokenPaid(alice),
            proxy.usdcRewardPerTokenStored(),
            "per-token-paid should be caught up"
        );
        assertGt(proxy.usdcRewards(alice), 0, "pending USDC materialised");
    }

    function test_catchUpPoints_syncsGlobalBacklogInChunks() public {
        _stakeAs(alice, 100e18);

        skip((EPOCH_DURATION * 17) + 1);
        assertEq(proxy.syncedRewardEpoch(), 0, "global reward epochs not synced yet");

        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.syncedRewardEpoch(), 16, "bounded sync closes first chunk");
        assertEq(proxy.userCurrentEpoch(alice), 16, "user catches up to first chunk");

        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.syncedRewardEpoch(), 17, "second call closes remaining finalized epoch");
        assertEq(proxy.userCurrentEpoch(alice), 17, "user catches up fully");
    }

    function test_constructor_defaultMinUnstakeBatchOpenSecs() public {
        vm.prank(owner);
        DiemStakingProxy fresh = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);
        assertEq(fresh.minUnstakeBatchOpenSecs(), fresh.ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS());
        assertEq(fresh.ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS(), 1 days);
    }

    function test_claimUnstakeBatch_revertBeforeCooldown() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();
        proxy.flush();

        vm.expectRevert(DiemStakingProxy.UnstakeBatchNotReady.selector);
        proxy.claimUnstakeBatch(batchId);
    }

    function test_claimUnstakeBatch_revertOnUnflushedBatch() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();

        vm.expectRevert(DiemStakingProxy.UnstakeBatchNotReady.selector);
        proxy.claimUnstakeBatch(batchId);
    }

    function test_claimUnstakeBatch_revertOnDoubleClaim() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();
        proxy.flush();

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(batchId);

        vm.expectRevert(DiemStakingProxy.UnstakeBatchAlreadyClaimed.selector);
        proxy.claimUnstakeBatch(batchId);
    }

    function test_multipleUnstakeBatchesSerialize() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 firstBatch = proxy.currentUnstakeBatch();
        proxy.flush();

        vm.prank(bob);
        proxy.initiateUnstake(50e18);
        uint32 secondBatch = proxy.currentUnstakeBatch();
        assertEq(secondBatch, firstBatch + 1);

        skip(DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(firstBatch);

        proxy.flush();
        skip(DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(secondBatch);

        assertEq(diem.balanceOf(alice), 100e18);
        assertEq(diem.balanceOf(bob), 50e18);
    }

    function test_donationDoesNotStealOrStrand() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();
        proxy.flush();

        diem.mint(address(this), 100e18);
        diem.transfer(address(proxy), 100e18);

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(batchId);

        assertEq(diem.balanceOf(alice), 100e18, "alice got exactly her stake");
        assertEq(diem.balanceOf(address(proxy)), 100e18);
    }

    function test_reserve_forwardsToChannels() public {
        _setupBuyer(200e6);

        bytes32 salt = bytes32(uint256(1));
        bytes32 expectedChannelId = channels.computeChannelId(buyer, address(proxy), salt);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory reserveSig = _signReserveAuth(expectedChannelId, 100e6, deadline);

        vm.prank(alice);
        vm.expectRevert(AntseedSellerDelegation.NotOperator.selector);
        proxy.reserve(buyer, salt, 100e6, deadline, reserveSig);

        vm.prank(operator);
        proxy.reserve(buyer, salt, 100e6, deadline, reserveSig);

        assertEq(channels.activeChannelCount(address(proxy)), 1);
    }

    function test_settle_capturesUsdcDeltaAndNotifies() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);

        uint256 usdcBefore = usdc.balanceOf(address(proxy));
        uint256 storedBefore = proxy.usdcRewardPerTokenStored();
        _settleViaProxy(channelId, 500e6);
        uint256 inflow = usdc.balanceOf(address(proxy)) - usdcBefore;

        assertEq(inflow, 500e6 - (500e6 * 200) / 10000 - ((500e6 - (500e6 * 200) / 10000) * 1000) / 10000);

        uint256 storedAfter = proxy.usdcRewardPerTokenStored();
        assertGt(storedAfter, storedBefore);
        assertEq(proxy.earnedUsdc(alice), inflow, "alice (sole staker) earns the full inflow");
    }

    function test_close_capturesUsdcDeltaAndNotifies() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);

        uint256 usdcBefore = usdc.balanceOf(address(proxy));
        _closeViaProxy(channelId, 400e6);
        uint256 inflow = usdc.balanceOf(address(proxy)) - usdcBefore;

        assertEq(inflow, 400e6 - (400e6 * 200) / 10000 - ((400e6 - (400e6 * 200) / 10000) * 1000) / 10000);
        assertEq(proxy.earnedUsdc(alice), inflow);

        assertEq(channels.activeChannelCount(address(proxy)), 0);
    }

    function test_operatorFee_takesDefaultUsdcCutFromSettlement() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);

        uint256 recipientBefore = usdc.balanceOf(operator);
        uint256 proxyBefore = usdc.balanceOf(address(proxy));
        _settleViaProxy(channelId, 500e6);

        uint256 protocolNetInflow = 500e6 - (500e6 * 200) / 10000;
        uint256 operatorFee = (protocolNetInflow * proxy.DEFAULT_OPERATOR_FEE_BPS()) / 10000;
        uint256 stakerNet = protocolNetInflow - operatorFee;

        assertEq(proxy.operatorFeeBps(), 1000);
        assertEq(proxy.operatorFeeRecipient(), operator);
        assertEq(usdc.balanceOf(operator) - recipientBefore, operatorFee);
        assertEq(usdc.balanceOf(address(proxy)) - proxyBefore, stakerNet);
        assertEq(proxy.earnedUsdc(alice), stakerNet);
        assertEq(proxy.totalUsdcReservedForStakers(), stakerNet);
    }

    function test_setOperatorFee_enforcesMaxAndRecipient() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AntseedSellerDelegation.OperatorFeeSet(0, address(0));
        proxy.setOperatorFee(0, address(0));

        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        proxy.setOperatorFee(1, address(0));

        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.OperatorFeeTooLarge.selector);
        proxy.setOperatorFee(2001, bob);

        vm.prank(owner);
        proxy.setOperatorFee(2000, bob);
        assertEq(proxy.operatorFeeBps(), 2000);
    }

    function test_operatorFee_takesAntsCutFromEpochPot() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        (uint256 pendingSeller,) = emissions.pendingEmissions(address(proxy), ids);
        uint256 operatorFee = (pendingSeller * proxy.DEFAULT_OPERATOR_FEE_BPS()) / 10000;
        uint256 stakerPot = pendingSeller - operatorFee;

        uint256 aliceBefore = ants.balanceOf(alice);
        uint256 recipientBefore = ants.balanceOf(operator);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));

        assertEq(ants.balanceOf(operator) - recipientBefore, operatorFee);
        assertEq(ants.balanceOf(alice) - aliceBefore, stakerPot);
        (,, uint256 antsPot,) = proxy.rewardEpochs(0);
        assertEq(antsPot, stakerPot);
    }

    function test_topUp_noInflow_noNotify() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 100e6, 300e6);
        _settleViaProxy(channelId, 90e6);

        uint256 storedBefore = proxy.usdcRewardPerTokenStored();
        uint256 usdcBefore = usdc.balanceOf(address(proxy));

        uint128 newMax = 200e6;
        uint256 newDeadline = block.timestamp + 2 days;
        bytes memory newReserveSig = _signReserveAuth(channelId, newMax, newDeadline);
        bytes memory metadata = _encodeMetadata(90e6, 0);
        bytes memory spendingSig = _signSpendingAuth(channelId, 90e6, metadata);

        vm.prank(operator);
        proxy.topUp(channelId, 90e6, metadata, spendingSig, newMax, newDeadline, newReserveSig);

        assertEq(usdc.balanceOf(address(proxy)), usdcBefore, "no USDC should flow on zero-delta topUp");
        uint256 storedAfter = proxy.usdcRewardPerTokenStored();
        assertEq(storedAfter, storedBefore, "rewardPerTokenStored must not change");
    }

    function test_claimAnts_opensAndFundsRewardEpoch() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        uint32 rewardEpochBefore = proxy.syncedRewardEpoch();
        uint256 antsBefore = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));
        uint256 claimed = ants.balanceOf(alice) - antsBefore;

        assertGt(claimed, 0, "emissions should pay ANTS through the proxy");
        assertEq(proxy.syncedRewardEpoch(), rewardEpochBefore + 1, "reward epoch advanced");
        (,, uint256 antsPot,) = proxy.rewardEpochs(rewardEpochBefore);
        assertEq(antsPot, claimed, "epoch pot captures the lazy claim");
    }

    function test_claimAnts_zeroRevenueEpochDoesNotFundPot() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        (uint256 pendingSeller,) = emissions.pendingEmissions(address(proxy), ids);
        assertGt(pendingSeller, 0, "proxy has external seller emissions");

        _stakeAs(alice, 100e18);

        (,, uint256 potBefore, bool fundedBefore) = proxy.rewardEpochs(0);
        assertEq(potBefore, 0, "zero-revenue epoch has no pot before claim");
        assertFalse(fundedBefore, "zero-revenue epoch starts unfunded");

        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));

        (,, uint256 potAfter, bool fundedAfter) = proxy.rewardEpochs(0);
        assertEq(potAfter, 0, "zero-revenue epoch stays unfunded");
        assertFalse(fundedAfter, "claim must not strand an undistributable pot");
        assertEq(ants.balanceOf(address(proxy)), 0, "no ANTS minted into proxy");
        assertTrue(proxy.userEpochClaimed(alice, 0), "user can advance past empty epoch");
    }

    function test_claimUsdcAndClaimAnts_paysBothRewards() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        proxy.syncRewardEpochs(1);
        assertGt(proxy.pendingAntsForEpoch(alice, 0), 0, "pending preview uses emissions pot");

        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        proxy.claimUsdc();
        assertGt(usdc.balanceOf(alice) - usdcBefore, 0);

        uint256 antsBefore = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));
        assertGt(ants.balanceOf(alice) - antsBefore, 0);
        (,,, bool funded) = proxy.rewardEpochs(0);
        assertTrue(funded, "claimAnts lazily funded epoch");
    }

    function test_claimAnts_lazilySyncsUnsyncedFinalizedEpoch() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        assertEq(proxy.syncedRewardEpoch(), 0, "proxy has not synced the finalized epoch");
        assertEq(proxy.finalizedRewardEpoch(), 1, "emissions clock finalized epoch 0");

        uint256 antsBefore = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));

        assertEq(proxy.syncedRewardEpoch(), 1, "claimAnts syncs before claiming");
        assertGt(ants.balanceOf(alice) - antsBefore, 0, "lazy claim pays finalized epoch");
    }

    function test_multiStaker_proRataUsdc() public {
        _stakeAs(alice, 30e18);
        _stakeAs(bob, 70e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 1000e6);

        uint256 aliceUsdc = proxy.earnedUsdc(alice);
        uint256 bobUsdc = proxy.earnedUsdc(bob);
        uint256 totalEarned = aliceUsdc + bobUsdc;

        assertApproxEqAbs(aliceUsdc, (totalEarned * 30) / 100, 1);
        assertApproxEqAbs(bobUsdc, (totalEarned * 70) / 100, 1);
    }

    function test_usdcAttribution_followsInflowTiming() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        _stakeAs(bob, 100e18);

        assertGt(proxy.earnedUsdc(alice), 0);
        assertEq(proxy.earnedUsdc(bob), 0, "late staker must not capture prior inflow");
    }

    function test_usdcAttribution_unstakeBeforeSettle() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        assertEq(proxy.earnedUsdc(alice), 0, "already-unstaked alice earns nothing from later settle");
        assertGt(proxy.earnedUsdc(bob), 0);
    }

    function test_antsAttribution_matchesUsdcRevenueShare() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);
        _stakeAs(bob, 100e18);
        _settleViaProxy(channelId, 1000e6);

        uint256 aliceUsdc = proxy.earnedUsdc(alice);
        uint256 bobUsdc = proxy.earnedUsdc(bob);
        assertApproxEqAbs(aliceUsdc, bobUsdc * 3, 3, "USDC split is 3:1");

        vm.warp(block.timestamp + EPOCH_DURATION / 2 + 1);
        proxy.syncRewardEpochs(1);

        uint256 aliceAnts = proxy.pendingAntsForEpoch(alice, 0);
        uint256 bobAnts = proxy.pendingAntsForEpoch(bob, 0);
        assertGt(bobAnts, 0, "bob earns from the second settlement");
        assertApproxEqAbs(aliceAnts, bobAnts * 3, 3, "ANTS split matches USDC split");
    }

    function test_antsAttribution_delayedOperatorClaimDoesNotDilutePastEpoch() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        _stakeAs(bob, 100e18);

        assertGt(proxy.pendingAntsForEpoch(alice, 0), 0, "alice earned during epoch 0");
        assertEq(proxy.pendingAntsForEpoch(bob, 0), 0, "post-epoch staker must not dilute epoch 0");
    }

    function test_antsAttribution_backloggedClaimsDoNotStrandLaterPots() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);
        _settleViaProxy(channelId, 500e6);

        skip(EPOCH_DURATION + 1);
        _settleViaProxy(channelId, 900e6);

        skip(EPOCH_DURATION + 1);

        uint256 beforeBal = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 2));
        (,, uint256 pot0,) = proxy.rewardEpochs(0);
        (,, uint256 pot1,) = proxy.rewardEpochs(1);
        assertGt(pot0, 0, "epoch 0 pot");
        assertGt(pot1, 0, "epoch 1 pot");
        assertEq(ants.balanceOf(alice) - beforeBal, pot0 + pot1, "sole staker claims both pots");
    }

    function test_claimAnts_acceptsExplicitEpochArray() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(7)), 10_000e6, 10_000e6);
        _settleViaProxy(channelId, 500e6);

        skip(EPOCH_DURATION + 1);
        _settleViaProxy(channelId, 900e6);

        skip(EPOCH_DURATION + 1);
        proxy.syncRewardEpochs(2);

        uint256 beforeBal = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(1, 1));
        (,, uint256 pot1,) = proxy.rewardEpochs(1);
        assertEq(ants.balanceOf(alice) - beforeBal, pot1, "can claim epoch 1 before epoch 0");
        assertEq(proxy.userLastClaimedEpoch(alice), 0, "cursor waits for epoch 0");
        assertTrue(proxy.userEpochClaimed(alice, 1), "epoch 1 marked claimed");

        beforeBal = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));
        (,, uint256 pot0,) = proxy.rewardEpochs(0);
        assertEq(ants.balanceOf(alice) - beforeBal, pot0, "epoch 0 remains claimable");
        assertEq(proxy.userLastClaimedEpoch(alice), 2, "cursor advances across claimed epochs");
    }

    function test_antsAttribution_unstakePreservesPoints() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION / 2);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(proxy.oldestUnclaimedUnstakeBatch());

        vm.warp(block.timestamp + EPOCH_DURATION);
        proxy.syncRewardEpochs(1);

        assertGt(proxy.pendingAntsForEpoch(alice, 0), 0, "unstaked user retains points");
    }

    function test_setOperator_onlyOwner_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.setOperator(vm.addr(0x99), true);
    }

    function test_setOperator_addSecondOperator_bothCanCall() public {
        address secondOp = vm.addr(0x99);

        vm.prank(owner);
        proxy.setOperator(secondOp, true);

        assertTrue(proxy.isOperator(operator), "original operator still authorized");
        assertTrue(proxy.isOperator(secondOp), "new operator authorized");

        _setupBuyer(200e6);
        bytes32 salt = bytes32(uint256(42));
        bytes32 channelId = channels.computeChannelId(buyer, address(proxy), salt);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory reserveSig = _signReserveAuth(channelId, 100e6, deadline);

        vm.prank(secondOp);
        proxy.reserve(buyer, salt, 100e6, deadline, reserveSig);
        assertEq(channels.activeChannelCount(address(proxy)), 1);
    }

    function test_setOperator_removeOperator_revertsAfterRemoval() public {
        vm.prank(owner);
        proxy.setOperator(operator, false);

        assertFalse(proxy.isOperator(operator));

        vm.prank(operator);
        vm.expectRevert(AntseedSellerDelegation.NotOperator.selector);
        proxy.reserve(buyer, bytes32(0), 100e6, block.timestamp + 1 days, "");
    }

    function test_setOperator_revertZero() public {
        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        proxy.setOperator(address(0), true);
    }

    function test_withdrawAntseedStake_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.withdrawAntseedStake(alice);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit AntseedSellerDelegation.AntseedStakeWithdrawn(alice, PROXY_STAKE);
        proxy.withdrawAntseedStake(alice);
        assertEq(usdc.balanceOf(alice) - before, PROXY_STAKE);
    }

    function test_withdrawAntseedStake_revertZero() public {
        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        proxy.withdrawAntseedStake(address(0));
    }

    function test_withdrawAntseedStake_doesNotCreditStakers() public {
        _stakeAs(alice, 100e18);

        uint256 storedBefore = proxy.usdcRewardPerTokenStored();
        vm.prank(owner);
        proxy.withdrawAntseedStake(bob);

        uint256 storedAfter = proxy.usdcRewardPerTokenStored();
        assertEq(storedAfter, storedBefore, "stake recovery must not be routed to stakers as a reward");
    }

    function test_isValidSignature_validOwner() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0x1626ba7e));
    }

    function test_isValidSignature_operatorReturnsInvalid() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_nonOwnerReturnsInvalid() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_afterOwnershipTransferOldSigInvalid() public {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, hash);
        bytes memory oldSig = abi.encodePacked(r, s, v);

        vm.prank(owner);
        proxy.transferOwnership(bob);

        assertEq(proxy.isValidSignature(hash, oldSig), bytes4(0xffffffff));

        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(BOB_PK, hash);
        bytes memory newSig = abi.encodePacked(r2, s2, v2);
        assertEq(proxy.isValidSignature(hash, newSig), bytes4(0x1626ba7e));
    }

    function test_sweepOrphanUsdc_recoversInflowWithNoStakers() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);
        _settleViaProxy(channelId, 400e6);

        uint256 trapped = usdc.balanceOf(address(proxy));
        assertGt(trapped, 0, "USDC sits in proxy since no stakers");
        assertEq(proxy.totalUsdcReservedForStakers(), 0, "no liability accrued");

        uint256 recipientBefore = usdc.balanceOf(bob);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.OrphanUsdcSwept(bob, trapped);
        proxy.sweepOrphanUsdc(bob);

        assertEq(usdc.balanceOf(bob) - recipientBefore, trapped);
        assertEq(usdc.balanceOf(address(proxy)), 0);
    }

    function test_sweepOrphanUsdc_recoversDirectDonation() public {
        _stakeAs(alice, 100e18);

        uint256 donation = 123e6;
        usdc.mint(address(this), donation);
        usdc.transfer(address(proxy), donation);

        assertEq(proxy.totalUsdcReservedForStakers(), 0);

        vm.prank(owner);
        proxy.sweepOrphanUsdc(bob);
        assertEq(usdc.balanceOf(bob), donation);
    }

    function test_sweepOrphanUsdc_doesNotInvadeStakerLiabilities() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        uint256 reserved = proxy.totalUsdcReservedForStakers();
        uint256 balance = usdc.balanceOf(address(proxy));
        assertEq(reserved, balance);

        uint256 recipientBefore = usdc.balanceOf(bob);
        vm.prank(owner);
        proxy.sweepOrphanUsdc(bob);
        assertEq(usdc.balanceOf(bob), recipientBefore, "nothing to sweep");
        assertEq(usdc.balanceOf(address(proxy)), balance, "balance untouched");

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(usdc.balanceOf(alice) - aliceBefore, reserved);
    }

    function test_sweepOrphanUsdc_afterPartialClaim() public {
        _stakeAs(alice, 100e18);
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(proxy.totalUsdcReservedForStakers(), 0);

        uint256 donation = 7e6;
        usdc.mint(address(this), donation);
        usdc.transfer(address(proxy), donation);

        vm.prank(owner);
        proxy.sweepOrphanUsdc(bob);
        assertEq(usdc.balanceOf(bob), donation);
    }

    function test_sweepOrphanUsdc_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.sweepOrphanUsdc(alice);
    }

    function test_sweepOrphanUsdc_revertZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        proxy.sweepOrphanUsdc(address(0));
    }

    function test_maxTotalStake_defaultsToAlphaCap_onFreshDeploy() public {
        vm.prank(owner);
        DiemStakingProxy fresh = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);
        assertEq(fresh.maxTotalStake(), fresh.ALPHA_MAX_TOTAL_STAKE());
        assertEq(fresh.maxTotalStake(), 10e18);
    }

    function test_alphaCap_enforcedOnFreshDeploy() public {
        vm.prank(owner);
        DiemStakingProxy fresh = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);

        diem.mint(alice, 11e18);
        vm.startPrank(alice);
        diem.approve(address(fresh), 11e18);
        vm.expectRevert(DiemStakingProxy.MaxStakeExceeded.selector);
        fresh.stake(11e18); // over the 10 DIEM alpha cap
        fresh.stake(10e18);
        vm.stopPrank();
        assertEq(fresh.totalStaked(), 10e18);
    }

    function test_setMaxTotalStake_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        proxy.setMaxTotalStake(50e18);
    }

    function test_setMaxTotalStake_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit DiemStakingProxy.MaxTotalStakeSet(50e18);
        proxy.setMaxTotalStake(50e18);
        assertEq(proxy.maxTotalStake(), 50e18);
    }

    function test_stake_revertsWhenCapExceeded() public {
        vm.prank(owner);
        proxy.setMaxTotalStake(100e18);

        _stakeAs(alice, 80e18);

        diem.mint(bob, 30e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 30e18);
        vm.expectRevert(DiemStakingProxy.MaxStakeExceeded.selector);
        proxy.stake(30e18);
        vm.stopPrank();

        diem.mint(bob, 20e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 20e18);
        proxy.stake(20e18);
        vm.stopPrank();
        assertEq(proxy.totalStaked(), 100e18);
    }

    function test_setMaxTotalStake_belowCurrentTotal_doesNotTrapStakers() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);
        assertEq(proxy.totalStaked(), 200e18);

        vm.prank(owner);
        proxy.setMaxTotalStake(50e18); // below current totalStaked

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        assertEq(proxy.staked(alice), 0);

        diem.mint(bob, 10e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 10e18);
        vm.expectRevert(DiemStakingProxy.MaxStakeExceeded.selector);
        proxy.stake(10e18);
        vm.stopPrank();
    }

    function test_maxTotalStake_zeroMeansUnlimited() public {
        vm.prank(owner);
        proxy.setMaxTotalStake(0);
        _stakeAs(alice, 1_000_000e18);
        assertEq(proxy.totalStaked(), 1_000_000e18);
    }

    function test_stakerCount_startsAtZero() public view {
        assertEq(proxy.stakerCount(), 0);
    }

    function test_stakerCount_incrementsOnFirstStake() public {
        _stakeAs(alice, 10e18);
        assertEq(proxy.stakerCount(), 1);
        _stakeAs(bob, 5e18);
        assertEq(proxy.stakerCount(), 2);
    }

    function test_stakerCount_partialStakeDoesNotDoubleCount() public {
        _stakeAs(alice, 10e18);
        _stakeAs(alice, 20e18); // top-up, still one distinct staker
        assertEq(proxy.stakerCount(), 1);
    }

    function test_stakerCount_decrementsOnFullExitOnly() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);
        assertEq(proxy.stakerCount(), 2);

        vm.prank(alice);
        proxy.initiateUnstake(40e18);
        assertEq(proxy.stakerCount(), 2, "partial unstake doesn't change count");

        vm.prank(alice);
        proxy.initiateUnstake(60e18);
        assertEq(proxy.stakerCount(), 1);

        vm.prank(bob);
        proxy.initiateUnstake(50e18);
        assertEq(proxy.stakerCount(), 0);
    }

    function test_stakerCount_restakeAfterFullExitIncrements() public {
        _stakeAs(alice, 10e18);
        vm.prank(alice);
        proxy.initiateUnstake(10e18);
        assertEq(proxy.stakerCount(), 0);

        _stakeAs(alice, 5e18);
        assertEq(proxy.stakerCount(), 1, "re-entry counts again");
    }

    function test_totalUsdcDistributedEver_accumulatesAcrossSettles() public {
        _stakeAs(alice, 100e18);

        bytes32 ch1 = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);
        _settleViaProxy(ch1, 300e6);
        uint256 after1 = proxy.totalUsdcDistributedEver();
        assertGt(after1, 0);

        _closeViaProxy(ch1, 400e6); // +100 delta
        uint256 after2 = proxy.totalUsdcDistributedEver();
        assertGt(after2, after1, "increments on every inflow");
    }

    function test_totalUsdcDistributedEver_neverDecrementsOnClaim() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);
        uint256 distributed = proxy.totalUsdcDistributedEver();

        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(proxy.totalUsdcDistributedEver(), distributed, "lifetime counter must not decrement");
    }

    function test_totalUsdcDistributedEver_skipsInflowWithNoStakers() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);
        _settleViaProxy(channelId, 400e6);
        assertEq(proxy.totalUsdcDistributedEver(), 0, "no-staker inflow doesn't count as distributed");
    }

    function test_invariant_usdcClaimsSumToInflows() public {
        _stakeAs(alice, 40e18);
        _stakeAs(bob, 60e18);

        bytes32 ch1 = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);

        uint256 balBefore = usdc.balanceOf(address(proxy));
        _settleViaProxy(ch1, 3_000e6);
        _settleViaProxy(ch1, 5_000e6);
        _closeViaProxy(ch1, 7_000e6);
        uint256 netInflow = usdc.balanceOf(address(proxy)) - balBefore;

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        proxy.claimUsdc();
        vm.prank(bob);
        proxy.claimUsdc();
        uint256 paidOut = (usdc.balanceOf(alice) - aliceBefore) + (usdc.balanceOf(bob) - bobBefore);

        assertLe(paidOut, netInflow, "claims must not exceed inflows");
        assertApproxEqAbs(paidOut, netInflow, 3, "rounding dust bounded by #settles");
        assertEq(
            proxy.totalUsdcDistributedEver(), netInflow, "lifetime counter equals full inflow regardless of rounding"
        );
    }

    function test_invariant_balanceNeverBelowReserved() public {
        _stakeAs(alice, 30e18);
        _stakeAs(bob, 70e18);

        bytes32 ch1 = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);
        _settleViaProxy(ch1, 1_000e6);
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());

        _settleViaProxy(ch1, 2_500e6);
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());

        vm.prank(alice);
        proxy.claimUsdc();
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());

        _closeViaProxy(ch1, 4_000e6);
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());

        vm.prank(bob);
        proxy.claimUsdc();
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());
    }

    function test_invariant_antsClaimsSumToPot() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION / 3);
        _stakeAs(bob, 50e18);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 aliceBefore = ants.balanceOf(alice);
        uint256 bobBefore = ants.balanceOf(bob);
        vm.prank(alice);
        proxy.claimAnts(_rewardEpochs(0, 1));
        vm.prank(bob);
        proxy.claimAnts(_rewardEpochs(0, 1));
        (,, uint256 antsPot,) = proxy.rewardEpochs(0);
        assertGt(antsPot, 0);
        uint256 paidOut = (ants.balanceOf(alice) - aliceBefore) + (ants.balanceOf(bob) - bobBefore);

        assertLe(paidOut, antsPot, "sum of ANTS claims must not exceed pot");
        assertApproxEqAbs(paidOut, antsPot, 2, "rounding dust bounded by #claimants");
    }

    function test_catchUpPoints_openEpochDeferredThenCaptured() public {
        _stakeAs(alice, 100e18);

        _advanceRewardEpochs(17);
        vm.prank(alice);
        proxy.catchUpPoints(16);
        vm.prank(alice);
        proxy.catchUpPoints(16); // drains to syncedRewardEpoch = 17

        uint32 openEp = proxy.syncedRewardEpoch();
        assertEq(openEp, 17);
        assertEq(proxy.userCurrentEpoch(alice), openEp);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(99)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        assertEq(proxy.userPoints(alice, openEp), 0, "open-epoch points deferred");

        vm.prank(alice);
        proxy.initiateUnstake(1e18);
        assertGt(proxy.userPoints(alice, openEp), 0, "open-epoch points captured on next interaction");
    }

    function test_churn_stakeSettleUnstakeRestakeSettle() public {
        _stakeAs(alice, 100e18);

        bytes32 ch1 = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);
        _settleViaProxy(ch1, 1_000e6);
        uint256 aliceRound1 = proxy.earnedUsdc(alice);
        assertGt(aliceRound1, 0);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        _settleViaProxy(ch1, 2_000e6);
        uint256 orphanBefore = usdc.balanceOf(address(proxy)) - proxy.totalUsdcReservedForStakers();
        assertGt(orphanBefore, 0, "settle with zero totalStaked is orphaned");

        vm.warp(block.timestamp + 1 hours);
        _stakeAs(alice, 50e18);
        _settleViaProxy(ch1, 3_000e6);

        uint256 aliceRound2 = proxy.earnedUsdc(alice) - aliceRound1;
        assertGt(aliceRound2, 0, "restake earns again");

        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());
    }

    function test_flush_windowAfterImmediateNextQueue() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 firstBatch = proxy.currentUnstakeBatch();
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(firstBatch);

        vm.prank(bob);
        proxy.initiateUnstake(100e18);

        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
    }

    function test_isValidSignature_malformedSigReturnsInvalid() public {
        bytes32 hash = keccak256("venice-api-key-challenge");
        bytes memory bad = hex"deadbeef"; // 4 bytes, not 65
        assertEq(proxy.isValidSignature(hash, bad), bytes4(0xffffffff));
    }

    function test_rewardPerToken_precisionAtHighTvl() public {
        vm.prank(owner);
        proxy.setMaxTotalStake(0);

        _stakeAs(alice, 5e23);
        _stakeAs(bob, 5e23);

        uint256 before = proxy.usdcRewardPerTokenStored();

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(123)), 1e6, 1e6);
        _settleViaProxy(channelId, 1e6);

        uint256 afterStored = proxy.usdcRewardPerTokenStored();
        assertGt(afterStored, before, "RAY scalar preserves small-inflow precision at 1e24 TVL");
    }
}
