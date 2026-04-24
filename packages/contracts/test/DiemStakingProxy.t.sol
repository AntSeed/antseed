// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockUSDC} from "../MockUSDC.sol";
import {MockERC8004Registry} from "../MockERC8004Registry.sol";
import {ANTSToken} from "../ANTSToken.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedStaking} from "../AntseedStaking.sol";
import {AntseedChannels} from "../AntseedChannels.sol";
import {AntseedEmissions} from "../AntseedEmissions.sol";
import {DiemStakingProxy} from "../DiemStakingProxy.sol";
import {AntseedSellerDelegation} from "../AntseedSellerDelegation.sol";

import {MockDiem} from "./mocks/MockDiem.sol";

/// @dev Integration tests for DiemStakingProxy against the real AntSeed stack
///      (Channels, Deposits, Staking, Emissions, Registry, ANTSToken). The only
///      mock is MockDiem — Venice's DIEM contract is external, we don't own it.
contract DiemStakingProxyTest is Test {
    // ─── Deterministic private keys ──────────────────────────────────
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant ALICE_PK = 0x0C;
    uint256 constant BOB_PK = 0x0D;
    uint256 constant BUYER_PK = 0xA11CE;

    // ─── Durations / amounts ─────────────────────────────────────────
    uint256 constant DIEM_COOLDOWN = 1 days;
    uint256 constant PROXY_STAKE = 10_000_000; // MIN_SELLER_STAKE
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    // ─── Actors ──────────────────────────────────────────────────────
    address owner;
    address operator;
    address alice;
    address bob;
    address buyer;
    address buyerOperator = address(0xAA);
    address protocolReserve = address(0xFEE);
    address teamWallet = address(0xBEEF);

    // ─── Tokens ──────────────────────────────────────────────────────
    MockDiem diem;
    MockUSDC usdc;
    ANTSToken ants;

    // ─── Real AntSeed stack ──────────────────────────────────────────
    MockERC8004Registry identityRegistry;
    AntseedRegistry antseedRegistry;
    AntseedDeposits deposits;
    AntseedStaking staking;
    AntseedChannels channels;
    AntseedEmissions emissions;

    // ─── Target ──────────────────────────────────────────────────────
    DiemStakingProxy proxy;
    uint256 proxyAgentId;

    // ─── AntSeed EIP-712 typehashes (mirror contracts) ───────────────
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

        // Start at a non-zero timestamp so epoch 0 has a clean window.
        vm.warp(1_700_000_000);

        // ── Tokens ──
        diem = new MockDiem(DIEM_COOLDOWN);
        usdc = new MockUSDC();
        ants = new ANTSToken();

        // ── Real stack ──
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

        // Allow larger reservations for tests.
        channels.setFirstSignCap(10_000_000_000);

        // ── Proxy ──
        vm.prank(owner);
        proxy = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);

        // Register proxy as an ERC-8004 agent and fund its seller stake so
        // AntseedChannels.reserve accepts the proxy (isStakedAboveMin check).
        vm.prank(address(proxy));
        proxyAgentId = identityRegistry.register();

        usdc.mint(address(this), PROXY_STAKE);
        usdc.approve(address(staking), PROXY_STAKE);
        staking.stakeFor(address(proxy), proxyAgentId, PROXY_STAKE);

        // ANTS is Phase-1 non-transferable. Whitelist the proxy so it can pay
        // rewards to DIEM stakers in getReward().
        ants.setTransferWhitelist(address(proxy), true);

        // Lift the 50-DIEM alpha cap for the default test fixture. Tests that
        // specifically exercise the cap set their own value via setMaxTotalStake.
        vm.prank(owner);
        proxy.setMaxTotalStake(0);

        // Disable the minimum batch-open window for the default fixture so
        // legacy tests that `flush()` immediately after `initiateUnstake`
        // still pass. Tests that specifically exercise the gate set their
        // own value via setMinUnstakeBatchOpenSecs.
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        STAKING HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _stakeAs(address user, uint256 amount) internal {
        diem.mint(user, amount);
        vm.startPrank(user);
        diem.approve(address(proxy), amount);
        proxy.stake(amount);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        BUYER / CHANNEL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Register buyer, set EIP-712 operator, deposit USDC through the operator.
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

    /// @dev Full reserve helper via the proxy. Buyer is created if needed.
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

    /// @dev Settle `cumulativeAmount` on a pre-existing channel via the proxy.
    function _settleViaProxy(bytes32 channelId, uint128 cumulativeAmount) internal {
        bytes memory metadata = _encodeMetadata(cumulativeAmount, 0);
        bytes memory sig = _signSpendingAuth(channelId, cumulativeAmount, metadata);
        vm.prank(operator);
        proxy.settle(channelId, cumulativeAmount, metadata, sig);
    }

    /// @dev Close a channel via the proxy with a final settlement.
    function _closeViaProxy(bytes32 channelId, uint128 finalAmount) internal {
        bytes memory metadata = _encodeMetadata(finalAmount, 0);
        bytes memory sig = _signSpendingAuth(channelId, finalAmount, metadata);
        vm.prank(operator);
        proxy.close(channelId, finalAmount, metadata, sig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        STAKING (DIEM)
    // ═══════════════════════════════════════════════════════════════════

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

        // Drive a real inflow through the full channel path. USDC is
        // instant-credited at settle so Alice has rewards immediately.
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

    /// @dev Same-user re-queues in the current (unflushed) epoch accumulate
    ///      into one slot, not a duplicate user row.
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

    /// @dev Alice and Bob queue into the same epoch, operator flushes, then a
    ///      single claim pays both in one tx.
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

        // Flush the batch (permissionless).
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

        // Batch 1 still in Venice cooldown, not yet claimed.
        vm.expectRevert(DiemStakingProxy.PriorUnstakeBatchUnclaimed.selector);
        proxy.flush();
    }

    // ── Minimum batch-open window ─────────────────────────────────────

    /// @dev Alice queues and tries to flush immediately — gate must reject.
    ///      Without the gate, a first queuer could push every later unstaker
    ///      into the next batch and force them to wait an extra full
    ///      Venice cooldown.
    function test_flush_revertsBeforeMinUnstakeBatchOpenSecs() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        // Same block as queue — gate closed.
        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        // Just short of the window.
        vm.warp(block.timestamp + 6 hours - 1);
        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        // Exactly at the boundary — accepted (uses `<`, not `<=`).
        vm.warp(block.timestamp + 1);
        proxy.flush();
    }

    /// @dev Window measures from the first queuer into the batch, not from
    ///      `flush` of the previous batch. A dry spell doesn't fast-track a
    ///      late queuer — they still need to wait `minUnstakeBatchOpenSecs` after
    ///      joining an empty batch.
    function test_flush_windowMeasuredFromFirstQueuer() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        // Seed and fully cycle a first batch so the batch slot for batch 2
        // has existed for a while before anyone queues into it.
        _stakeAs(alice, 50e18);
        vm.prank(alice);
        proxy.initiateUnstake(50e18);
        uint32 firstBatch = proxy.currentUnstakeBatch();
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(firstBatch);

        // Dry spell: no queuers for a week. `currentUnstakeBatchOpenedAt` stays 0.
        vm.warp(block.timestamp + 7 days);
        assertEq(proxy.currentUnstakeBatchOpenedAt(), 0, "no queuer: clock not started");

        // Bob queues — clock starts now.
        _stakeAs(bob, 50e18);
        vm.prank(bob);
        proxy.initiateUnstake(50e18);

        // Immediate flush still blocked despite the long dry spell.
        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        // Wait the window → flush accepted.
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
    }

    /// @dev Subsequent queuers into the same batch do not extend the
    ///      window — the clock is anchored to the first queuer, so the
    ///      batch's earliest-flush time is predictable from the moment it
    ///      opens.
    function test_flush_windowNotExtendedByLaterQueuers() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint64 openedAt = proxy.currentUnstakeBatchOpenedAt();

        // Bob piles in 3h later — the clock should not move.
        vm.warp(block.timestamp + 3 hours);
        vm.prank(bob);
        proxy.initiateUnstake(50e18);
        assertEq(proxy.currentUnstakeBatchOpenedAt(), openedAt, "later queuer must not bump clock");

        // 6h after Alice's queue → flush accepted.
        vm.warp(openedAt + 6 hours);
        proxy.flush();
    }

    /// @dev `flushableAt()` returns the predicted earliest-flush timestamp
    ///      while the batch is non-empty, and `0` while empty.
    function test_flushableAt_reflectsWindow() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        assertEq(proxy.flushableAt(), 0, "empty batch: zero");

        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        uint64 openedAt = proxy.currentUnstakeBatchOpenedAt();
        assertEq(proxy.flushableAt(), openedAt + 6 hours);

        // After flush, the next batch is empty again → flushableAt resets.
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

        // Exactly the bound is allowed.
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(7 days);
        assertEq(proxy.minUnstakeBatchOpenSecs(), 7 days);
    }

    // ── catchUpPoints ────────────────────────────────────────────────────────────────
    //
    // BacklogTooLarge is the escape-valve failure mode: when a staker's
    // userCurrentEpoch lags currentRewardEpoch by more than
    // MAX_EPOCHS_PER_CAPTURE, any call that hits `updateRewards` (stake,
    // initiateUnstake, claimUsdc, claimAnts) reverts. `catchUpPoints`
    // lets the staker drain the backlog incrementally so those calls
    // can proceed again. These tests cover that round-trip + the new
    // "catchUpPoints also settles USDC" guarantee.

    /// @dev Advance the proxy's reward epoch by driving emissions ticks.
    ///      Each iteration warps past EPOCH_DURATION so the emission
    ///      contract finalises the next epoch, then calls
    ///      `operatorClaimEmissions`. No seller activity is required for
    ///      the reward epoch to advance — emissions just distribute 0.
    function _advanceRewardEpochs(uint256 fromEpochId, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            skip(EPOCH_DURATION + 1);
            vm.prank(operator);
            proxy.operatorClaimEmissions(fromEpochId + i);
        }
    }

    /// @dev Alice stakes, then the reward epoch is advanced past the
    ///      MAX_EPOCHS_PER_CAPTURE threshold. `initiateUnstake` must revert
    ///      until she calls `catchUpPoints` to drain the backlog. A second
    ///      `catchUpPoints` call drains the remainder.
    function test_catchUpPoints_clearsBacklog() public {
        _stakeAs(alice, 100e18);

        // Alice's userCurrentEpoch is 0 here (set on her stake via
        // _captureUserPoints). Advance 17 reward epochs so the gap is 17,
        // which is > MAX_EPOCHS_PER_CAPTURE (16).
        _advanceRewardEpochs(0, 17);
        assertEq(proxy.currentRewardEpoch(), 17);
        assertEq(proxy.userCurrentEpoch(alice), 0);

        // stake, initiateUnstake and claimUsdc all revert: updateRewards →
        // _captureUserPoints sees a 17-epoch gap and bails.
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

        // Drain 16 reward epochs — leaves a 1-epoch gap, which is within the limit.
        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.userCurrentEpoch(alice), 16);

        // Second drain: targetEp is clamped to currentEp (17), so only one
        // epoch is processed and userCurrentEpoch catches up exactly.
        vm.prank(alice);
        proxy.catchUpPoints(16);
        assertEq(proxy.userCurrentEpoch(alice), 17);

        // With the backlog fully cleared, the normal update-rewards path
        // no longer reverts.
        vm.prank(alice);
        proxy.initiateUnstake(10e18);
    }

    /// @dev `catchUpPoints` also settles USDC reward debt so the caller is
    ///      left in a consistent state across both reward surfaces. This
    ///      test isolates the USDC-settlement effect from the points loop.
    function test_catchUpPoints_settlesUsdc() public {
        _stakeAs(alice, 100e18);

        // Real USDC inflow: instant-credits Alice via usdcRewardPerTokenStored,
        // but her usdcRewards ledger entry isn't materialised until a call
        // fires `_updateUsdcForUser(alice)`.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        uint256 paidBefore = proxy.userUsdcRewardPerTokenPaid(alice);
        uint256 storedAfterSettle = proxy.usdcRewardPerTokenStored();
        assertGt(storedAfterSettle, paidBefore, "settle must bump the global accumulator");

        // Build a backlog so the only reasonable way to "clear" it is via
        // catchUpPoints (a stake/unstake would revert BacklogTooLarge).
        _advanceRewardEpochs(0, 17);

        vm.prank(alice);
        proxy.catchUpPoints(16);

        // catchUpPoints called _updateUsdcForUser(alice), so her
        // per-token-paid snapshot now matches the global accumulator and
        // her pending USDC is materialised in usdcRewards.
        assertEq(
            proxy.userUsdcRewardPerTokenPaid(alice),
            proxy.usdcRewardPerTokenStored(),
            "per-token-paid should be caught up"
        );
        assertGt(proxy.usdcRewards(alice), 0, "pending USDC materialised");
    }

    function test_constructor_defaultMinUnstakeBatchOpenSecs() public {
        // Default fixture sets it to 0 explicitly; deploy a fresh proxy to
        // verify the constructor ships with the alpha default.
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

        // Not yet flushed → unlockAt is 0 → UnstakeBatchNotReady.
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

    /// @dev After a batch is claimed, new queuers land in a fresh batch and
    ///      flush/claim cycles continue normally.
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

        // Second batch can now flush.
        proxy.flush();
        skip(DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(secondBatch);

        assertEq(diem.balanceOf(alice), 100e18);
        assertEq(diem.balanceOf(bob), 50e18);
    }

    /// @dev Direct DIEM donation to the proxy does not corrupt accounting —
    ///      `claimUnstakeBatch` pays from explicit per-user amounts, not balanceOf.
    function test_donationDoesNotStealOrStrand() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 batchId = proxy.currentUnstakeBatch();
        proxy.flush();

        // Attacker drops DIEM directly on the proxy.
        diem.mint(address(this), 100e18);
        diem.transfer(address(proxy), 100e18);

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(batchId);

        assertEq(diem.balanceOf(alice), 100e18, "alice got exactly her stake");
        // Donation remains in the proxy as unaccounted dust; admin can
        // recover separately. Critically it did not corrupt the payout.
        assertEq(diem.balanceOf(address(proxy)), 100e18);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNELS FAÇADE (real Channels)
    // ═══════════════════════════════════════════════════════════════════

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

        // AntseedChannels emits Reserved(channelId, buyer, seller, maxAmount) — we verify
        // indirectly by checking activeChannelCount on the real Channels contract.
        assertEq(channels.activeChannelCount(address(proxy)), 1);
    }

    function test_settle_capturesUsdcDeltaAndNotifies() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);

        uint256 usdcBefore = usdc.balanceOf(address(proxy));
        uint256 storedBefore = proxy.usdcRewardPerTokenStored();
        _settleViaProxy(channelId, 500e6);
        uint256 inflow = usdc.balanceOf(address(proxy)) - usdcBefore;

        // 2% platform fee goes to protocolReserve; proxy receives the rest.
        assertEq(inflow, 500e6 - (500e6 * 200) / 10000);

        // Instant-credit: usdcRewardPerTokenStored bumps inline with the
        // settle and Alice has claimable USDC immediately (no tick needed).
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

        assertEq(inflow, 400e6 - (400e6 * 200) / 10000);
        assertEq(proxy.earnedUsdc(alice), inflow);

        // Channel is fully closed → no active channels left.
        assertEq(channels.activeChannelCount(address(proxy)), 0);
    }

    /// @dev topUp with cumulativeAmount == channel.settled (no new delta) must
    ///      not touch the USDC accumulator.
    function test_topUp_noInflow_noNotify() public {
        _stakeAs(alice, 100e18);

        // Reserve 100, settle 90 (>= 85% threshold for topUp).
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 100e6, 300e6);
        _settleViaProxy(channelId, 90e6);

        uint256 storedBefore = proxy.usdcRewardPerTokenStored();
        uint256 usdcBefore = usdc.balanceOf(address(proxy));

        // topUp with no new delta: cumulativeAmount == settled.
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

    // ═══════════════════════════════════════════════════════════════════
    //                        EMISSIONS (real Emissions)
    // ═══════════════════════════════════════════════════════════════════

    function test_operatorClaimEmissions_opensRewardEpoch() public {
        _stakeAs(alice, 100e18);

        // Real settle accrues seller points to the proxy in the current epoch.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Warp past epoch 0 so it's claimable.
        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        uint32 rewardEpochBefore = proxy.currentRewardEpoch();
        uint256 antsBefore = ants.balanceOf(address(proxy));
        vm.prank(operator);
        proxy.operatorClaimEmissions(0);
        uint256 minted = ants.balanceOf(address(proxy)) - antsBefore;

        assertGt(minted, 0, "emissions should mint ANTS to the proxy");
        assertEq(proxy.currentRewardEpoch(), rewardEpochBefore + 1, "reward epoch advanced");
        (,, uint256 antsPot) = proxy.rewardEpochs(rewardEpochBefore);
        assertEq(antsPot, minted, "epoch pot captures the inflow");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARDS (real flows, both streams)
    // ═══════════════════════════════════════════════════════════════════

    function test_claimUsdcAndClaimAnts_paysBothRewards() public {
        _stakeAs(alice, 100e18);

        // USDC inflow is instant-credited at settle.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Cross an emission-epoch boundary so ANTS becomes claimable, then
        // operator ticks — closes reward epoch 0 with ANTS pot.
        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        vm.prank(operator);
        proxy.operatorClaimEmissions(0);

        // Claim USDC (O(1)).
        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        proxy.claimUsdc();
        assertGt(usdc.balanceOf(alice) - usdcBefore, 0);

        // Claim ANTS for the first completed reward epoch.
        uint256 antsBefore = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(1);
        assertGt(ants.balanceOf(alice) - antsBefore, 0);
    }

    function test_multiStaker_proRataUsdc() public {
        _stakeAs(alice, 30e18);
        _stakeAs(bob, 70e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 1000e6);

        // USDC is instant-credited at settle — check earnings directly.
        uint256 aliceUsdc = proxy.earnedUsdc(alice);
        uint256 bobUsdc = proxy.earnedUsdc(bob);
        uint256 totalEarned = aliceUsdc + bobUsdc;

        assertApproxEqAbs(aliceUsdc, (totalEarned * 30) / 100, 1);
        assertApproxEqAbs(bobUsdc, (totalEarned * 70) / 100, 1);
    }

    /// @dev The reviewer's P1 concern: USDC earned during one user's staked
    ///      period must not be misattributed to a later staker. Alice stakes,
    ///      settles fire, Bob joins only afterward → all USDC belongs to Alice.
    function test_usdcAttribution_followsInflowTiming() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Bob joins AFTER Alice's settle.
        _stakeAs(bob, 100e18);

        // Alice must get everything from the pre-Bob settle.
        assertGt(proxy.earnedUsdc(alice), 0);
        assertEq(proxy.earnedUsdc(bob), 0, "late staker must not capture prior inflow");
    }

    /// @dev Companion to the above: if Alice unstakes before a settle, the
    ///      inflow goes to whoever is staked at the moment of settlement.
    function test_usdcAttribution_unstakeBeforeSettle() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);

        // Alice queues out of her stake before any settle.
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        assertEq(proxy.earnedUsdc(alice), 0, "already-unstaked alice earns nothing from later settle");
        assertGt(proxy.earnedUsdc(bob), 0);
    }

    /// @dev Stake-time weighted ANTS: Alice staked twice as long as Bob
    ///      gets more ANTS than Bob at claim time.
    function test_antsAttribution_stakeTimeWeighted() public {
        _stakeAs(alice, 100e18);

        // Drive seller activity so emissions epoch 0 pays out.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Halfway into the emission epoch, Bob joins with the same amount.
        vm.warp(block.timestamp + EPOCH_DURATION / 2);
        _stakeAs(bob, 100e18);

        // Finish the reward epoch and tick.
        vm.warp(block.timestamp + EPOCH_DURATION / 2 + 1);
        vm.prank(operator);
        proxy.operatorClaimEmissions(0);

        uint256 aliceAnts = proxy.pendingAntsForEpoch(alice, 0);
        uint256 bobAnts = proxy.pendingAntsForEpoch(bob, 0);
        assertGt(aliceAnts, bobAnts, "longer staker earns more");
    }

    /// @dev ANTS attribution must follow the finalized Antseed emission epoch,
    ///      not the later operator claim timestamp. Bob joins only after epoch 0
    ///      has ended, so a delayed claim for epoch 0 must not give him points.
    function test_antsAttribution_delayedOperatorClaimDoesNotDilutePastEpoch() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Epoch 0 is finalized, but the operator has not claimed it yet.
        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        // Bob joins after the epoch-0 accrual window. His stake call syncs the
        // finalized reward epoch before adding his stake.
        _stakeAs(bob, 100e18);

        vm.prank(operator);
        proxy.operatorClaimEmissions(0);

        assertGt(proxy.pendingAntsForEpoch(alice, 0), 0, "alice earned during epoch 0");
        assertEq(proxy.pendingAntsForEpoch(bob, 0), 0, "post-epoch staker must not dilute epoch 0");
    }

    /// @dev If the operator catches up multiple finalized Antseed epochs in the
    ///      same block, each ANTS pot must still have a non-zero point window.
    ///      Otherwise later pots become permanently unclaimable.
    function test_antsAttribution_backloggedClaimsDoNotStrandLaterPots() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);
        _settleViaProxy(channelId, 500e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        _settleViaProxy(channelId, 900e6);

        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        vm.prank(operator);
        proxy.operatorClaimEmissions(0);
        vm.prank(operator);
        proxy.operatorClaimEmissions(1);

        (,, uint256 pot0) = proxy.rewardEpochs(0);
        (,, uint256 pot1) = proxy.rewardEpochs(1);
        assertGt(pot0, 0, "epoch 0 pot");
        assertGt(pot1, 0, "epoch 1 pot");

        uint256 beforeBal = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.claimAnts(2);
        assertEq(ants.balanceOf(alice) - beforeBal, pot0 + pot1, "sole staker claims both pots");
    }

    /// @dev Staker who unstakes BEFORE the operator tick still earns ANTS
    ///      for their contribution during the completed epoch. Points
    ///      persist past unstaking.
    function test_antsAttribution_unstakePreservesPoints() public {
        _stakeAs(alice, 100e18);

        // Drive seller activity so emissions epoch 0 pays out.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Alice queues to unstake after some time.
        vm.warp(block.timestamp + EPOCH_DURATION / 2);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(proxy.oldestUnclaimedUnstakeBatch());

        // Alice is now fully unstaked. Operator ticks later.
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(operator);
        proxy.operatorClaimEmissions(0);

        // Alice should still have ANTS claimable for her contribution.
        assertGt(proxy.pendingAntsForEpoch(alice, 0), 0, "unstaked user retains points");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN (real Staking)
    // ═══════════════════════════════════════════════════════════════════

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

        // Second operator can drive channel operations too.
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
        // No active channels → real AntseedStaking.unstake returns the full stake.
        vm.prank(alice);
        vm.expectRevert();
        proxy.withdrawAntseedStake(alice);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.AntseedStakeWithdrawn(alice, PROXY_STAKE);
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

    // ═══════════════════════════════════════════════════════════════════
    //                        EIP-1271 (Venice onboarding — owner only)
    // ═══════════════════════════════════════════════════════════════════

    function test_isValidSignature_validOwner() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0x1626ba7e));
    }

    /// @dev Operators drive channel ops but are NOT authorized for Venice.
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

    // ════════════════════════════════════════════════════════════════════
    //                        sweepOrphanUsdc
    // ════════════════════════════════════════════════════════════════════

    /// @dev Inflows that arrive while totalStaked == 0 are not distributed;
    ///      sweep recovers them without touching staker liabilities.
    function test_sweepOrphanUsdc_recoversInflowWithNoStakers() public {
        // No one has staked — drive a settle anyway.
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

    /// @dev Random USDC donated to the proxy is sweepable.
    function test_sweepOrphanUsdc_recoversDirectDonation() public {
        _stakeAs(alice, 100e18);

        // No settle happened — stakers have nothing reserved. Attacker drops
        // USDC directly on the proxy.
        uint256 donation = 123e6;
        usdc.mint(address(this), donation);
        usdc.transfer(address(proxy), donation);

        assertEq(proxy.totalUsdcReservedForStakers(), 0);

        vm.prank(owner);
        proxy.sweepOrphanUsdc(bob);
        assertEq(usdc.balanceOf(bob), donation);
    }

    /// @dev Sweep must NEVER touch USDC that stakers have actually earned.
    function test_sweepOrphanUsdc_doesNotInvadeStakerLiabilities() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Full inflow is reserved for alice. Balance before sweep ==
        // reserved (modulo rounding dust kept as safety margin).
        uint256 reserved = proxy.totalUsdcReservedForStakers();
        uint256 balance = usdc.balanceOf(address(proxy));
        assertEq(reserved, balance);

        uint256 recipientBefore = usdc.balanceOf(bob);
        vm.prank(owner);
        proxy.sweepOrphanUsdc(bob);
        assertEq(usdc.balanceOf(bob), recipientBefore, "nothing to sweep");
        assertEq(usdc.balanceOf(address(proxy)), balance, "balance untouched");

        // Alice can still claim her full earnings.
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(usdc.balanceOf(alice) - aliceBefore, reserved);
    }

    /// @dev After alice claims, her portion of the reserved liability is
    ///      retired. Any subsequent direct donation is cleanly sweepable.
    function test_sweepOrphanUsdc_afterPartialClaim() public {
        _stakeAs(alice, 100e18);
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(proxy.totalUsdcReservedForStakers(), 0);

        // Direct donation post-claim is fully sweepable.
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

    // ════════════════════════════════════════════════════════════════════
    //                        maxTotalStake (owner-settable cap)
    // ════════════════════════════════════════════════════════════════════

    function test_maxTotalStake_defaultsToAlphaCap_onFreshDeploy() public {
        // Deploy a fresh proxy so the constructor-set alpha cap is observable
        // (the shared fixture lifts it in setUp so other tests aren't blocked).
        vm.prank(owner);
        DiemStakingProxy fresh = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);
        assertEq(fresh.maxTotalStake(), fresh.ALPHA_MAX_TOTAL_STAKE());
        assertEq(fresh.maxTotalStake(), 50e18);
    }

    /// @dev The alpha cap must be enforced on the very first stake — it's the
    ///      whole point of shipping with it on.
    function test_alphaCap_enforcedOnFreshDeploy() public {
        vm.prank(owner);
        DiemStakingProxy fresh = new DiemStakingProxy(address(diem), address(usdc), address(antseedRegistry), operator);

        diem.mint(alice, 60e18);
        vm.startPrank(alice);
        diem.approve(address(fresh), 60e18);
        vm.expectRevert(DiemStakingProxy.MaxStakeExceeded.selector);
        fresh.stake(60e18); // over the 50 DIEM alpha cap
        // Exactly the cap works.
        fresh.stake(50e18);
        vm.stopPrank();
        assertEq(fresh.totalStaked(), 50e18);
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

        // A further 30 would push totalStaked to 110, over the 100 cap.
        diem.mint(bob, 30e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 30e18);
        vm.expectRevert(DiemStakingProxy.MaxStakeExceeded.selector);
        proxy.stake(30e18);
        vm.stopPrank();

        // Exactly hitting the cap is allowed.
        diem.mint(bob, 20e18);
        vm.startPrank(bob);
        diem.approve(address(proxy), 20e18);
        proxy.stake(20e18);
        vm.stopPrank();
        assertEq(proxy.totalStaked(), 100e18);
    }

    /// @dev Lowering the cap must never trap existing stakers. Unstakes still
    ///      work even when totalStaked is above the new cap.
    function test_setMaxTotalStake_belowCurrentTotal_doesNotTrapStakers() public {
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);
        assertEq(proxy.totalStaked(), 200e18);

        vm.prank(owner);
        proxy.setMaxTotalStake(50e18); // below current totalStaked

        // Alice can still unstake freely.
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        assertEq(proxy.staked(alice), 0);

        // New stakes are blocked until totalStaked drops below cap.
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
        // Arbitrary large stake works.
        _stakeAs(alice, 1_000_000e18);
        assertEq(proxy.totalStaked(), 1_000_000e18);
    }

    // ════════════════════════════════════════════════════════════════════
    //                        stakerCount (distinct-staker tracker)
    // ════════════════════════════════════════════════════════════════════

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

        // Partial unstake — alice still counted.
        vm.prank(alice);
        proxy.initiateUnstake(40e18);
        assertEq(proxy.stakerCount(), 2, "partial unstake doesn't change count");

        // Alice's full remaining exit.
        vm.prank(alice);
        proxy.initiateUnstake(60e18);
        assertEq(proxy.stakerCount(), 1);

        // Bob's full exit.
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

    // ════════════════════════════════════════════════════════════════════
    //                        totalUsdcDistributedEver (lifetime counter)
    // ════════════════════════════════════════════════════════════════════

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

    /// @dev Claims don't decrement the lifetime counter (only the reservation ledger).
    function test_totalUsdcDistributedEver_neverDecrementsOnClaim() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);
        uint256 distributed = proxy.totalUsdcDistributedEver();

        vm.prank(alice);
        proxy.claimUsdc();
        assertEq(proxy.totalUsdcDistributedEver(), distributed, "lifetime counter must not decrement");
    }

    /// @dev Inflows with no stakers skip distribution entirely and don't bump
    ///      the lifetime counter. They're sweepable orphans instead.
    function test_totalUsdcDistributedEver_skipsInflowWithNoStakers() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);
        _settleViaProxy(channelId, 400e6);
        assertEq(proxy.totalUsdcDistributedEver(), 0, "no-staker inflow doesn't count as distributed");
    }

    // ════════════════════════════════════════════════════════════════════
    //                        Conservation invariants
    // ════════════════════════════════════════════════════════════════════
    //
    // These tests enforce the contract's core solvency guarantees:
    //   - Sum of user USDC claims ≤ sum of net inflows (never overpay).
    //   - Sum of user ANTS claims <= the reward epoch pot (never mint more than was
    //     distributed by AntseedEmissions).
    // Any regression that breaks these is a direct loss-of-funds bug.

    /// @dev Multi-staker, multi-settle: Alice and Bob claim independently; sum
    ///      of claims must equal the net inflow to the proxy (modulo
    ///      per-user integer-division rounding, which is bounded above by N
    ///      wei where N is the number of settles).
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

        // Must never exceed the inflow (solvency). Rounding dust (< 3 wei
        // for 3 distribution events) stays in the proxy as sweepable residue.
        assertLe(paidOut, netInflow, "claims must not exceed inflows");
        assertApproxEqAbs(paidOut, netInflow, 3, "rounding dust bounded by #settles");
        assertEq(
            proxy.totalUsdcDistributedEver(), netInflow, "lifetime counter equals full inflow regardless of rounding"
        );
    }

    /// @dev Balance-vs-reservation invariant: after any sequence of settles
    ///      and claims, `balanceOf(proxy) >= totalUsdcReservedForStakers`.
    ///      This is what makes `sweepOrphanUsdc` safe.
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

    /// @dev Multi-staker ANTS claim conservation: the sum of users' actual
    ///      received ANTS must not exceed the reward epoch's pot.
    function test_invariant_antsClaimsSumToPot() public {
        _stakeAs(alice, 100e18);

        // Drive a settle so emissions has activity to reward.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Bob joins mid-epoch with a different amount.
        vm.warp(block.timestamp + EPOCH_DURATION / 3);
        _stakeAs(bob, 50e18);

        // Finish epoch 0 and tick.
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(operator);
        proxy.operatorClaimEmissions(0);

        (,, uint256 antsPot) = proxy.rewardEpochs(0);
        assertGt(antsPot, 0);

        uint256 aliceBefore = ants.balanceOf(alice);
        uint256 bobBefore = ants.balanceOf(bob);
        vm.prank(alice);
        proxy.claimAnts(1);
        vm.prank(bob);
        proxy.claimAnts(1);
        uint256 paidOut = (ants.balanceOf(alice) - aliceBefore) + (ants.balanceOf(bob) - bobBefore);

        // Never over-pay; rounding dust bounded by #claimants.
        assertLe(paidOut, antsPot, "sum of ANTS claims must not exceed pot");
        assertApproxEqAbs(paidOut, antsPot, 2, "rounding dust bounded by #claimants");
    }

    // ════════════════════════════════════════════════════════════════════
    //                        catchUpPoints coverage
    // ════════════════════════════════════════════════════════════════════

    /// @dev After `catchUpPoints` drains the backlog, the user's contribution
    ///      to the still-open reward epoch is deferred — then materialised by
    ///      the next call that fires `updateRewards` (e.g. `initiateUnstake`).
    ///      The deferred points must match what the user would have accrued
    ///      if they had been caught up continuously.
    function test_catchUpPoints_openEpochDeferredThenCaptured() public {
        _stakeAs(alice, 100e18);

        // Build a backlog that forces catchUpPoints.
        _advanceRewardEpochs(0, 17);
        vm.prank(alice);
        proxy.catchUpPoints(16);
        vm.prank(alice);
        proxy.catchUpPoints(16); // drains to currentRewardEpoch = 17

        uint32 openEp = proxy.currentRewardEpoch();
        assertEq(openEp, 17);
        assertEq(proxy.userCurrentEpoch(alice), openEp);

        // Stake-time passes in the still-open epoch. `catchUpPoints` does not
        // touch `userPoints[alice][openEp]` — it's deferred to the next
        // `updateRewards` trigger.
        assertEq(proxy.userPoints(alice, openEp), 0, "open-epoch points deferred");

        vm.warp(block.timestamp + 3 days);

        // Any interaction that hits updateRewards materialises the deferred
        // points (initiateUnstake is the simplest non-allocating trigger).
        vm.prank(alice);
        proxy.initiateUnstake(1e18);
        assertGt(proxy.userPoints(alice, openEp), 0, "open-epoch points captured on next interaction");
    }

    // ════════════════════════════════════════════════════════════════════
    //                        Rapid churn
    // ════════════════════════════════════════════════════════════════════

    /// @dev Stake → settle → unstake → restake → settle, all within one emission
    ///      epoch. Balances across both reward surfaces must stay consistent.
    function test_churn_stakeSettleUnstakeRestakeSettle() public {
        _stakeAs(alice, 100e18);

        bytes32 ch1 = _reserveViaProxy(bytes32(uint256(1)), 10_000e6, 10_000e6);
        _settleViaProxy(ch1, 1_000e6);
        uint256 aliceRound1 = proxy.earnedUsdc(alice);
        assertGt(aliceRound1, 0);

        // Alice fully exits the reward stream.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        // Settle while Alice is fully unstaked and no one else is staked:
        // orphan inflow, sweepable.
        _settleViaProxy(ch1, 2_000e6);
        uint256 orphanBefore = usdc.balanceOf(address(proxy)) - proxy.totalUsdcReservedForStakers();
        assertGt(orphanBefore, 0, "settle with zero totalStaked is orphaned");

        // Alice re-stakes. A later settle credits only the post-restake portion.
        vm.warp(block.timestamp + 1 hours);
        _stakeAs(alice, 50e18);
        _settleViaProxy(ch1, 3_000e6);

        uint256 aliceRound2 = proxy.earnedUsdc(alice) - aliceRound1;
        assertGt(aliceRound2, 0, "restake earns again");

        // Invariant still holds after the full sequence.
        assertGe(usdc.balanceOf(address(proxy)), proxy.totalUsdcReservedForStakers());
    }

    // ════════════════════════════════════════════════════════════════════
    //                        Flush window boundary
    // ════════════════════════════════════════════════════════════════════

    /// @dev A fresh batch opens at exactly the same block as the prior
    ///      `flush()`. The window clock must anchor to that queuer's
    ///      timestamp and block immediate re-flush.
    function test_flush_windowAfterImmediateNextQueue() public {
        vm.prank(owner);
        proxy.setMinUnstakeBatchOpenSecs(6 hours);

        _stakeAs(alice, 100e18);
        _stakeAs(bob, 100e18);

        // Batch 1: alice queues + waits + flushes + claims (serialization:
        // next flush requires prior batch to be claimed).
        vm.prank(alice);
        proxy.initiateUnstake(100e18);
        uint32 firstBatch = proxy.currentUnstakeBatch();
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);
        proxy.claimUnstakeBatch(firstBatch);

        // Bob queues into the NEW batch in the same block as the claim.
        vm.prank(bob);
        proxy.initiateUnstake(100e18);

        // Immediate flush of batch 2 must be rejected by the window gate —
        // batch opened this very block.
        vm.expectRevert(DiemStakingProxy.UnstakeBatchTooYoung.selector);
        proxy.flush();

        // Wait the window and it's fine.
        vm.warp(block.timestamp + 6 hours);
        proxy.flush();
    }

    // ════════════════════════════════════════════════════════════════════
    //                        ERC-1271 malformed signature
    // ════════════════════════════════════════════════════════════════════

    /// @dev Malformed (non-65-byte) signature must not recover to the owner.
    ///      OpenZeppelin's ECDSA.recover reverts on invalid length; the
    ///      proxy's isValidSignature propagates the revert rather than
    ///      silently returning the magic value. Either behaviour (revert
    ///      or return 0xffffffff) is spec-compliant; we just pin it so any
    ///      future change is deliberate.
    function test_isValidSignature_malformedSigReverts() public {
        bytes32 hash = keccak256("venice-api-key-challenge");
        bytes memory bad = hex"deadbeef"; // 4 bytes, not 65
        vm.expectRevert();
        proxy.isValidSignature(hash, bad);
    }

    // ════════════════════════════════════════════════════════════════════
    //                        Precision (1e27 scalar)
    // ════════════════════════════════════════════════════════════════════

    /// @dev At high TVL, per-second integrator increments must not round to
    ///      zero. With the 1e27 (RAY) scalar, even 1 second of accrual on
    ///      1e24 total stake produces a strictly non-zero increment. Under
    ///      the legacy 1e18 scalar, the same increment would have been 0.
    function test_integrator_precisionAtHighTvl() public {
        vm.prank(owner);
        proxy.setMaxTotalStake(0);

        // Stake 1e24 wei DIEM (≈ 1M DIEM) across Alice and Bob so the
        // integrator denominator is large.
        _stakeAs(alice, 5e23);
        _stakeAs(bob, 5e23);

        uint256 before = proxy.stakeIntegrator();

        // Advance one second and trigger an integrator update via a no-op
        // reward-touching path (catchUpPoints calls _updateStakeIntegrator).
        vm.warp(block.timestamp + 1);
        // catchUpPoints requires numEpochs > 0 and at least one finalised
        // reward epoch to drain; advance one so the call is well-formed.
        _advanceRewardEpochs(0, 1);
        vm.prank(alice);
        proxy.catchUpPoints(1);

        uint256 afterInt = proxy.stakeIntegrator();
        assertGt(afterInt, before, "RAY scalar preserves sub-second precision at 1e24 TVL");
    }
}
