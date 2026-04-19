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
    uint256 constant OWNER_PK    = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant ALICE_PK    = 0x0C;
    uint256 constant BOB_PK      = 0x0D;
    uint256 constant BUYER_PK    = 0xA11CE;

    // ─── Durations / amounts ─────────────────────────────────────────
    uint256 constant DIEM_COOLDOWN    = 1 days;
    uint256 constant USDC_DURATION    = 1 days;
    uint256 constant ANTS_DURATION    = 1 days;
    uint256 constant PROXY_STAKE      = 10_000_000;     // MIN_SELLER_STAKE
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION   = 1 weeks;

    // ─── Actors ──────────────────────────────────────────────────────
    address owner;
    address operator;
    address alice;
    address bob;
    address buyer;
    address buyerOperator  = address(0xAA);
    address protocolReserve = address(0xFEE);
    address teamWallet     = address(0xBEEF);

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
    bytes32 constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );
    bytes32 constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );
    uint256 constant METADATA_VERSION = 1;

    function setUp() public {
        owner    = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        alice    = vm.addr(ALICE_PK);
        bob      = vm.addr(BOB_PK);
        buyer    = vm.addr(BUYER_PK);

        // Start at a non-zero timestamp so epoch 0 has a clean window.
        vm.warp(1_700_000_000);

        // ── Tokens ──
        diem = new MockDiem(DIEM_COOLDOWN);
        usdc = new MockUSDC();
        ants = new ANTSToken();

        // ── Real stack ──
        identityRegistry = new MockERC8004Registry();
        antseedRegistry  = new AntseedRegistry();
        deposits         = new AntseedDeposits(address(usdc));
        staking          = new AntseedStaking(address(usdc), address(antseedRegistry));
        channels         = new AntseedChannels(address(antseedRegistry));
        emissions        = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

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
        proxy = new DiemStakingProxy(
            address(diem),
            address(usdc),
            address(ants),
            address(antseedRegistry),
            address(emissions),
            address(staking),
            operator,
            USDC_DURATION,
            ANTS_DURATION
        );

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
        bytes32 structHash = keccak256(
            abi.encode(deposits.SET_OPERATOR_TYPEHASH(), buyerOperator, nonce)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash)
        );
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

    function _signReserveAuth(
        bytes32 channelId,
        uint128 maxAmount,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(RESERVE_AUTH_TYPEHASH, channelId, maxAmount, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _signSpendingAuth(
        bytes32 channelId,
        uint256 cumulativeAmount,
        bytes memory metadata
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(SPENDING_AUTH_TYPEHASH, channelId, cumulativeAmount, keccak256(metadata))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _encodeMetadata(uint256 inputTokens, uint256 outputTokens)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(METADATA_VERSION, inputTokens, outputTokens, uint256(0));
    }

    /// @dev Full reserve helper via the proxy. Buyer is created if needed.
    function _reserveViaProxy(
        bytes32 salt,
        uint128 maxAmount,
        uint256 depositAmount
    ) internal returns (bytes32 channelId) {
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

    function test_initiateUnstake_setsPerUserUnlockAndStopsAccrual() public {
        _stakeAs(alice, 100e18);

        // Drive a real inflow through the full channel path.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 100e6, 200e6);
        _settleViaProxy(channelId, 90e6);

        vm.warp(block.timestamp + 12 hours);
        (uint256 earnedBefore,) = proxy.earned(alice);
        assertGt(earnedBefore, 0);

        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        assertEq(proxy.staked(alice), 0);
        assertEq(proxy.totalStaked(), 0);

        (uint128 pendingAmt, uint64 unlockAt) = proxy.pendingUnstake(alice);
        assertEq(pendingAmt, 100e18);
        // Exact cooldown is verified by test_initiateUnstake_accumulatesAndResetsOwnUnlock;
        // here we just assert the unlock is in the future.
        assertGt(uint256(unlockAt), block.timestamp);

        vm.warp(block.timestamp + 5 hours);
        (uint256 earnedAfter,) = proxy.earned(alice);
        assertEq(earnedAfter, earnedBefore);
    }

    function test_initiateUnstake_accumulatesAndResetsOwnUnlock() public {
        _stakeAs(alice, 200e18);

        vm.prank(alice);
        proxy.initiateUnstake(50e18);
        (uint128 amt1, uint64 unlock1) = proxy.pendingUnstake(alice);
        assertEq(amt1, 50e18);

        vm.warp(block.timestamp + 3 hours);
        vm.prank(alice);
        proxy.initiateUnstake(30e18);
        (uint128 amt2, uint64 unlock2) = proxy.pendingUnstake(alice);
        assertEq(amt2, 80e18);
        assertGt(unlock2, unlock1);
        assertEq(unlock2, uint64(block.timestamp + DIEM_COOLDOWN));
    }

    function test_unstake_revertBeforeUserCooldown() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.StillCoolingDown.selector);
        proxy.unstake();
    }

    function test_unstake_success() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        vm.warp(block.timestamp + DIEM_COOLDOWN + 1);

        uint256 balBefore = diem.balanceOf(alice);
        vm.prank(alice);
        proxy.unstake();
        assertEq(diem.balanceOf(alice) - balBefore, 100e18);

        (uint128 pendingAmt,) = proxy.pendingUnstake(alice);
        assertEq(pendingAmt, 0);
    }

    /// @dev Bob's late initiateUnstake resets Venice's shared cooldown for the
    ///      whole proxy. Alice's per-user unlock has passed, but diem.unstake()
    ///      reverts until Venice's cooldown elapses.
    function test_unstake_sharedVeniceCooldownBlocksUntilLatestRequest() public {
        uint256 t0 = block.timestamp;
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18); // alice.unlockAt = t0 + 1 day; Venice unlock = t0 + 1 day

        vm.warp(t0 + 12 hours);
        vm.prank(bob);
        proxy.initiateUnstake(50e18); // bob.unlockAt = t0 + 36h; Venice unlock reset to t0 + 36h

        // Past alice's per-user unlock, not Venice's shared cooldown.
        skip(12 hours + 1);
        (, uint64 aliceUnlock) = proxy.pendingUnstake(alice);
        assertLe(aliceUnlock, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(bytes("COOLDOWN_NOT_OVER"));
        proxy.unstake();

        skip(12 hours);
        vm.prank(alice);
        proxy.unstake();
        assertEq(diem.balanceOf(alice), 100e18);
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
        _settleViaProxy(channelId, 500e6);
        uint256 inflow = usdc.balanceOf(address(proxy)) - usdcBefore;

        // 2% platform fee goes to protocolReserve; proxy receives the rest.
        assertEq(inflow, 500e6 - (500e6 * 200) / 10000);

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0);
    }

    function test_close_capturesUsdcDeltaAndNotifies() public {
        _stakeAs(alice, 100e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 500e6, 500e6);

        uint256 usdcBefore = usdc.balanceOf(address(proxy));
        _closeViaProxy(channelId, 400e6);
        uint256 inflow = usdc.balanceOf(address(proxy)) - usdcBefore;

        assertEq(inflow, 400e6 - (400e6 * 200) / 10000);

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0);

        // Channel is fully closed → no active channels left.
        assertEq(channels.activeChannelCount(address(proxy)), 0);
    }

    /// @dev topUp with cumulativeAmount == channel.settled (no new delta) must
    ///      not transfer USDC to the proxy, and must not notify the stream.
    function test_topUp_noInflow_noNotify() public {
        _stakeAs(alice, 100e18);

        // Reserve 100, settle 90 (>= 85% threshold for topUp).
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 100e6, 300e6);
        _settleViaProxy(channelId, 90e6);

        (uint256 rateBefore, uint256 finishBefore,,,) = proxy.usdcStream();
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
        (uint256 rateAfter, uint256 finishAfter,,,) = proxy.usdcStream();
        assertEq(rateAfter, rateBefore);
        assertEq(finishAfter, finishBefore);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EMISSIONS (real Emissions)
    // ═══════════════════════════════════════════════════════════════════

    function test_operatorClaimEmissions_notifiesAntsStream() public {
        _stakeAs(alice, 100e18);

        // Real settle accrues seller points to the proxy in the current epoch.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Warp past epoch 0 so it's claimable.
        vm.warp(block.timestamp + EPOCH_DURATION + 1);

        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;

        uint256 antsBefore = ants.balanceOf(address(proxy));
        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);
        uint256 minted = ants.balanceOf(address(proxy)) - antsBefore;

        assertGt(minted, 0, "emissions should mint ANTS to the proxy");

        (uint256 rewardRate,,,,) = proxy.antsStream();
        assertGt(rewardRate, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARDS (real flows, both streams)
    // ═══════════════════════════════════════════════════════════════════

    function test_getReward_paysBothStreams() public {
        _stakeAs(alice, 100e18);

        // Drive USDC inflow.
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 500e6);

        // Drive ANTS inflow via real emissions (cross an epoch boundary).
        vm.warp(block.timestamp + EPOCH_DURATION + 1);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;
        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);

        // Drain both reward durations so Alice has earned something from each.
        vm.warp(block.timestamp + USDC_DURATION + ANTS_DURATION);

        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 antsBefore = ants.balanceOf(alice);
        vm.prank(alice);
        proxy.getReward();

        assertGt(usdc.balanceOf(alice) - usdcBefore, 0);
        assertGt(ants.balanceOf(alice) - antsBefore, 0);
    }

    function test_multiStaker_proRataUsdc() public {
        _stakeAs(alice, 30e18);
        _stakeAs(bob, 70e18);

        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 1000e6);

        vm.warp(block.timestamp + USDC_DURATION);

        (uint256 aliceUsdc,) = proxy.earned(alice);
        (uint256 bobUsdc,) = proxy.earned(bob);
        uint256 totalEarned = aliceUsdc + bobUsdc;

        assertApproxEqAbs(aliceUsdc, (totalEarned * 30) / 100, 1);
        assertApproxEqAbs(bobUsdc,   (totalEarned * 70) / 100, 1);
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

    function test_withdrawAntseedStake_doesNotNotifyUsdcStream() public {
        _stakeAs(alice, 100e18);

        vm.prank(owner);
        proxy.withdrawAntseedStake(bob);

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertEq(rewardRate, 0, "stake recovery must not be routed to stakers as a reward");
    }

    function test_setRewardsDuration_revertDuringActivePeriod() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 100e6);

        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.RewardPeriodActive.selector);
        proxy.setRewardsDuration(0, 2 days);
    }

    function test_setRewardsDuration_successAfterFinish() public {
        bytes32 channelId = _reserveViaProxy(bytes32(uint256(1)), 1000e6, 1000e6);
        _settleViaProxy(channelId, 100e6);

        vm.warp(block.timestamp + USDC_DURATION + 1);
        vm.prank(owner);
        proxy.setRewardsDuration(0, 2 days);

        (,,,, uint256 rewardsDuration) = proxy.usdcStream();
        assertEq(rewardsDuration, 2 days);
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
}
