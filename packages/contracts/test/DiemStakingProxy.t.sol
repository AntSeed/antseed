// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MockUSDC} from "../MockUSDC.sol";
import {DiemStakingProxy} from "../DiemStakingProxy.sol";
import {MockDiem} from "./mocks/MockDiem.sol";
import {MockAntseedChannels} from "./mocks/MockAntseedChannels.sol";
import {MockAntseedEmissions} from "./mocks/MockAntseedEmissions.sol";
import {MockAntseedStaking} from "./mocks/MockAntseedStaking.sol";

contract DiemStakingProxyTest is Test {
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant ALICE_PK = 0x0C;
    uint256 constant BOB_PK = 0x0D;

    uint256 constant DIEM_COOLDOWN = 1 days;
    uint256 constant USDC_DURATION = 1 days;
    uint256 constant ANTS_DURATION = 1 days;

    address owner;
    address operator;
    address alice;
    address bob;

    MockDiem diem;
    MockUSDC usdc;
    MockUSDC ants;
    MockAntseedChannels channelsMock;
    MockAntseedEmissions emissionsMock;
    MockAntseedStaking stakingMock;
    DiemStakingProxy proxy;

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);

        diem = new MockDiem(DIEM_COOLDOWN);
        usdc = new MockUSDC();
        ants = new MockUSDC();
        channelsMock = new MockAntseedChannels(address(usdc));
        emissionsMock = new MockAntseedEmissions(address(ants));
        stakingMock = new MockAntseedStaking(address(usdc));

        vm.prank(owner);
        proxy = new DiemStakingProxy(
            address(diem), address(usdc), address(ants),
            address(channelsMock), address(emissionsMock), address(stakingMock),
            operator,
            USDC_DURATION, ANTS_DURATION
        );

        usdc.mint(address(channelsMock), 1_000_000e6);
        ants.mint(address(emissionsMock), 1_000_000e18);
    }

    function _stakeAs(address user, uint256 amount) internal {
        diem.mint(user, amount);
        vm.startPrank(user);
        diem.approve(address(proxy), amount);
        proxy.stake(amount);
        vm.stopPrank();
    }

    // ─── STAKING ───────────────────────────────────────────────────────

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

        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        vm.warp(block.timestamp + 12 hours);
        (uint256 earnedBefore,) = proxy.earned(alice);
        assertGt(earnedBefore, 0);

        uint256 expectedUnlockAt = block.timestamp + DIEM_COOLDOWN;
        vm.prank(alice);
        proxy.initiateUnstake(100e18);

        assertEq(proxy.staked(alice), 0);
        assertEq(proxy.totalStaked(), 0);

        (uint128 pendingAmt, uint64 unlockAt) = proxy.pendingUnstake(alice);
        assertEq(pendingAmt, 100e18);
        assertEq(unlockAt, uint64(expectedUnlockAt));

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

    /// @dev Shared-bucket: bob's late initiateUnstake resets Venice's cooldown
    ///      for the whole proxy. Alice's per-user unlock has passed, but
    ///      diem.unstake() reverts until Venice's cooldown elapses.
    function test_unstake_sharedVeniceCooldownBlocksUntilLatestRequest() public {
        uint256 t0 = block.timestamp;
        _stakeAs(alice, 100e18);
        _stakeAs(bob, 50e18);

        vm.prank(alice);
        proxy.initiateUnstake(100e18); // alice.unlockAt = t0 + 1 day; Venice unlock = t0 + 1 day

        vm.warp(t0 + 12 hours);
        vm.prank(bob);
        proxy.initiateUnstake(50e18); // bob.unlockAt = t0 + 36h; Venice unlock reset to t0 + 36h

        // Advance past alice's per-user unlock but not Venice's shared cooldown.
        skip(12 hours + 1);
        (, uint64 aliceUnlock) = proxy.pendingUnstake(alice);
        assertLe(aliceUnlock, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(bytes("COOLDOWN_NOT_OVER"));
        proxy.unstake();

        // Advance past Venice's shared cooldown.
        skip(12 hours);
        vm.prank(alice);
        proxy.unstake();
        assertEq(diem.balanceOf(alice), 100e18);
    }

    // ─── CHANNELS FAÇADE ───────────────────────────────────────────────

    function test_reserve_forwardsToChannels() public {
        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.NotOperator.selector);
        proxy.reserve(alice, bytes32(0), 100e6, block.timestamp + 1 days, "");

        bytes32 expectedChannelId = channelsMock.computeChannelId(alice, address(proxy), bytes32(0));
        vm.prank(operator);
        vm.expectEmit(true, true, false, true);
        emit DiemStakingProxy.ForwardedReserve(expectedChannelId, alice, 100e6);
        proxy.reserve(alice, bytes32(0), 100e6, block.timestamp + 1 days, "");
    }

    function test_settle_capturesUsdcDeltaAndNotifies() public {
        channelsMock.setPayout(1000e6);
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.ForwardedSettle(bytes32(0), 0, 1000e6);
        proxy.settle(bytes32(0), 0, "", "");

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0);
    }

    function test_close_capturesUsdcDeltaAndNotifies() public {
        channelsMock.setPayout(500e6);
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.ForwardedClose(bytes32(0), 0, 500e6);
        proxy.close(bytes32(0), 0, "", "");

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0);
    }

    function test_topUp_noInflow_noNotify() public {
        channelsMock.setPayout(0);
        vm.prank(operator);
        proxy.topUp(bytes32(0), 0, "", "", 0, block.timestamp + 1 days, "");

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertEq(rewardRate, 0);
    }

    // ─── EMISSIONS ─────────────────────────────────────────────────────

    function test_operatorClaimEmissions_notifiesAntsStream() public {
        emissionsMock.setPayout(500e18);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;

        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);

        (uint256 rewardRate,,,,) = proxy.antsStream();
        assertGt(rewardRate, 0);
    }

    // ─── REWARDS ───────────────────────────────────────────────────────

    function test_getReward_paysBothStreams() public {
        _stakeAs(alice, 100e18);

        channelsMock.setPayout(1000e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        emissionsMock.setPayout(500e18);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;
        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);

        vm.warp(block.timestamp + USDC_DURATION);

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

        channelsMock.setPayout(1000e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        vm.warp(block.timestamp + USDC_DURATION);

        (uint256 aliceUsdc,) = proxy.earned(alice);
        (uint256 bobUsdc,) = proxy.earned(bob);
        uint256 totalEarned = aliceUsdc + bobUsdc;

        assertApproxEqAbs(aliceUsdc, totalEarned * 30 / 100, 1);
        assertApproxEqAbs(bobUsdc, totalEarned * 70 / 100, 1);
    }

    // ─── ADMIN ─────────────────────────────────────────────────────────

    function test_setOperator_onlyOwner() public {
        address newOperator = vm.addr(0x99);

        vm.prank(alice);
        vm.expectRevert();
        proxy.setOperator(newOperator);

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit DiemStakingProxy.OperatorRotated(operator, newOperator);
        proxy.setOperator(newOperator);

        assertEq(proxy.operator(), newOperator);
    }

    function test_setOperator_revertZero() public {
        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.InvalidAddress.selector);
        proxy.setOperator(address(0));
    }

    function test_withdrawAntseedStake_onlyOwner() public {
        stakingMock.setPayout(10_000e6);
        usdc.mint(address(stakingMock), 10_000e6);

        vm.prank(alice);
        vm.expectRevert();
        proxy.withdrawAntseedStake(alice);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.AntseedStakeWithdrawn(alice, 10_000e6);
        proxy.withdrawAntseedStake(alice);
        assertEq(usdc.balanceOf(alice) - before, 10_000e6);
    }

    function test_withdrawAntseedStake_revertZero() public {
        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.InvalidAddress.selector);
        proxy.withdrawAntseedStake(address(0));
    }

    function test_withdrawAntseedStake_doesNotNotifyUsdcStream() public {
        _stakeAs(alice, 100e18);
        stakingMock.setPayout(10_000e6);
        usdc.mint(address(stakingMock), 10_000e6);

        vm.prank(owner);
        proxy.withdrawAntseedStake(bob);

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertEq(rewardRate, 0, "stake recovery must not be routed to stakers as a reward");
    }

    function test_setRewardsDuration_revertDuringActivePeriod() public {
        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.RewardPeriodActive.selector);
        proxy.setRewardsDuration(0, 2 days);
    }

    function test_setRewardsDuration_successAfterFinish() public {
        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        vm.warp(block.timestamp + USDC_DURATION + 1);
        vm.prank(owner);
        proxy.setRewardsDuration(0, 2 days);

        (,,,, uint256 rewardsDuration) = proxy.usdcStream();
        assertEq(rewardsDuration, 2 days);
    }

    // ─── EIP-712 DELEGATION ────────────────────────────────────────────

    function _signDelegation(
        uint256 signerPk,
        address peerAddress,
        address _sellerContract,
        uint256 chainId,
        uint256 expiresAt
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                proxy.SELLER_DELEGATION_TYPEHASH(),
                peerAddress,
                _sellerContract,
                chainId,
                expiresAt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", proxy.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_isValidDelegation_valid() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, address(proxy), block.chainid, expiresAt);
        assertTrue(proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig));
    }

    function test_isValidDelegation_expired() public view {
        uint256 expiresAt = block.timestamp - 1;
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, address(proxy), block.chainid, expiresAt);
        assertFalse(proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig));
    }

    function test_isValidDelegation_wrongChainId() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        uint256 wrongChain = block.chainid + 1;
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, address(proxy), wrongChain, expiresAt);
        assertFalse(proxy.isValidDelegation(alice, address(proxy), wrongChain, expiresAt, sig));
    }

    function test_isValidDelegation_wrongSellerContract() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        address wrongSeller = vm.addr(0x50);
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, wrongSeller, block.chainid, expiresAt);
        assertFalse(proxy.isValidDelegation(alice, wrongSeller, block.chainid, expiresAt, sig));
    }

    function test_isValidDelegation_sigFromNonOperator() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        bytes memory sig = _signDelegation(ALICE_PK, alice, address(proxy), block.chainid, expiresAt);
        assertFalse(proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig));
    }

    function test_isValidDelegation_afterRotation() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        bytes memory oldSig = _signDelegation(OPERATOR_PK, alice, address(proxy), block.chainid, expiresAt);

        vm.prank(owner);
        proxy.setOperator(bob);

        assertFalse(proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, oldSig));

        bytes memory newSig = _signDelegation(BOB_PK, alice, address(proxy), block.chainid, expiresAt);
        assertTrue(proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, newSig));
    }

    // ─── EIP-1271 ──────────────────────────────────────────────────────

    function test_isValidSignature_validOperator() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0x1626ba7e));
    }

    function test_isValidSignature_nonOperatorReturnsInvalid() public view {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, hash);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(proxy.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_isValidSignature_afterRotationOldSigInvalid() public {
        bytes32 hash = keccak256("venice-api-key-challenge");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, hash);
        bytes memory oldSig = abi.encodePacked(r, s, v);

        vm.prank(owner);
        proxy.setOperator(bob);

        assertEq(proxy.isValidSignature(hash, oldSig), bytes4(0xffffffff));
    }
}
