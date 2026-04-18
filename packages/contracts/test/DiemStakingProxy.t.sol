// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MockUSDC} from "../MockUSDC.sol";
import {DiemStakingProxy} from "../DiemStakingProxy.sol";
import {MockVeniceStaking} from "./mocks/MockVeniceStaking.sol";
import {MockAntseedChannels} from "./mocks/MockAntseedChannels.sol";
import {MockAntseedEmissions} from "./mocks/MockAntseedEmissions.sol";

contract DiemStakingProxyTest is Test {
    // Private keys — follow house convention
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant ALICE_PK = 0x0C;
    uint256 constant BOB_PK = 0x0D;

    address owner;
    address operator;
    address alice;
    address bob;

    MockUSDC diem;
    MockUSDC usdc;
    MockUSDC ants;
    MockVeniceStaking venice;
    MockAntseedChannels channelsMock;
    MockAntseedEmissions emissionsMock;
    DiemStakingProxy proxy;

    uint256 constant USDC_DURATION = 1 days;
    uint256 constant ANTS_DURATION = 1 days;

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);

        diem = new MockUSDC();
        usdc = new MockUSDC();
        ants = new MockUSDC();
        venice = new MockVeniceStaking(address(diem));
        channelsMock = new MockAntseedChannels(address(usdc));
        emissionsMock = new MockAntseedEmissions(address(ants));

        vm.prank(owner);
        proxy = new DiemStakingProxy(
            address(diem), address(usdc), address(ants),
            address(venice), address(channelsMock), address(emissionsMock),
            operator,
            USDC_DURATION, ANTS_DURATION
        );

        // Fund channels mock with USDC so it can pay out.
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

    // ─────────────────────────────────────────────────────────────────
    //                     STAKING TESTS
    // ─────────────────────────────────────────────────────────────────

    function test_stake_success() public {
        _stakeAs(alice, 100e18);

        assertEq(proxy.staked(alice), 100e18);
        assertEq(proxy.totalStaked(), 100e18);
        assertEq(venice.staked(address(proxy)), 100e18);
    }

    function test_stake_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.InvalidAmount.selector);
        proxy.stake(0);
    }

    function test_requestWithdraw_startsCooldownAndStopsAccrual() public {
        // 1 staker stakes
        _stakeAs(alice, 100e18);

        // Operator notifies 100 USDC into the stream
        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        // Advance 12 hours — alice accrues rewards
        vm.warp(block.timestamp + 12 hours);

        // Record earned before withdraw request
        (uint256 earnedBefore,) = proxy.earned(alice);
        assertGt(earnedBefore, 0, "alice should have earned something");

        // Request withdraw of full stake
        uint256 expectedUnlockAt = block.timestamp + 7 days;
        vm.prank(alice);
        proxy.requestWithdraw(100e18);

        // Stake is zeroed out
        assertEq(proxy.staked(alice), 0);
        assertEq(proxy.totalStaked(), 0);

        // Pending withdrawal is set with correct unlock time
        (uint128 pendingAmt, uint64 unlockAt) = proxy.pendingWithdrawal(alice);
        assertEq(pendingAmt, 100e18);
        assertEq(unlockAt, uint64(expectedUnlockAt));

        // Advance another 5 hours — no further accrual (totalStaked == 0)
        vm.warp(block.timestamp + 5 hours);
        (uint256 earnedAfter,) = proxy.earned(alice);
        assertEq(earnedAfter, earnedBefore, "no additional accrual after requestWithdraw");
    }

    function test_withdraw_revertBeforeCooldown() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.requestWithdraw(100e18);

        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.StillCoolingDown.selector);
        proxy.withdraw();
    }

    function test_withdraw_success() public {
        _stakeAs(alice, 100e18);
        vm.prank(alice);
        proxy.requestWithdraw(100e18);

        vm.warp(block.timestamp + 7 days + 1);

        uint256 balBefore = diem.balanceOf(alice);
        vm.prank(alice);
        proxy.withdraw();
        uint256 balAfter = diem.balanceOf(alice);

        assertEq(balAfter - balBefore, 100e18);

        // Pending withdrawal cleared
        (uint128 pendingAmt,) = proxy.pendingWithdrawal(alice);
        assertEq(pendingAmt, 0);
    }

    // ─────────────────────────────────────────────────────────────────
    //                     CHANNELS FAÇADE TESTS
    // ─────────────────────────────────────────────────────────────────

    function test_reserve_forwardsToChannels() public {
        // Non-operator reverts
        vm.prank(alice);
        vm.expectRevert(DiemStakingProxy.NotOperator.selector);
        proxy.reserve(alice, bytes32(0), 100e6, block.timestamp + 1 days, "");

        // Operator call emits ForwardedReserve
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

        // Stream notified — rewardRate should be > 0
        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0, "usdcStream.rewardRate should be > 0");
    }

    function test_close_capturesUsdcDeltaAndNotifies() public {
        channelsMock.setPayout(500e6);

        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit DiemStakingProxy.ForwardedClose(bytes32(0), 0, 500e6);
        proxy.close(bytes32(0), 0, "", "");

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertGt(rewardRate, 0, "usdcStream.rewardRate should be > 0 after close");
    }

    function test_topUp_noInflow_noNotify() public {
        channelsMock.setPayout(0);

        vm.prank(operator);
        proxy.topUp(bytes32(0), 0, "", "", 0, block.timestamp + 1 days, "");

        (uint256 rewardRate,,,,) = proxy.usdcStream();
        assertEq(rewardRate, 0, "usdcStream.rewardRate should remain 0 when no inflow");
    }

    // ─────────────────────────────────────────────────────────────────
    //                     EMISSIONS TESTS
    // ─────────────────────────────────────────────────────────────────

    function test_operatorClaimEmissions_notifiesAntsStream() public {
        emissionsMock.setPayout(500e18);

        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;

        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);

        (uint256 rewardRate,,,,) = proxy.antsStream();
        assertGt(rewardRate, 0, "antsStream.rewardRate should be > 0 after claim");
    }

    // ─────────────────────────────────────────────────────────────────
    //                     REWARD DISTRIBUTION TESTS
    // ─────────────────────────────────────────────────────────────────

    function test_getReward_paysBothStreams() public {
        _stakeAs(alice, 100e18);

        // Notify both streams
        channelsMock.setPayout(1000e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        emissionsMock.setPayout(500e18);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 0;
        vm.prank(operator);
        proxy.operatorClaimEmissions(epochs);

        // Warp full period
        vm.warp(block.timestamp + USDC_DURATION);

        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 antsBefore = ants.balanceOf(alice);

        vm.prank(alice);
        proxy.getReward();

        uint256 usdcAfter = usdc.balanceOf(alice);
        uint256 antsAfter = ants.balanceOf(alice);

        assertGt(usdcAfter - usdcBefore, 0, "alice should receive USDC rewards");
        assertGt(antsAfter - antsBefore, 0, "alice should receive ANTS rewards");
    }

    function test_multiStaker_proRataUsdc() public {
        _stakeAs(alice, 30e18);
        _stakeAs(bob, 70e18);

        // Notify 1000 USDC
        channelsMock.setPayout(1000e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        // Warp full period
        vm.warp(block.timestamp + USDC_DURATION);

        (uint256 aliceUsdc,) = proxy.earned(alice);
        (uint256 bobUsdc,) = proxy.earned(bob);

        // alice ~30% of distributed, bob ~70%. Tolerance accounts for rewardRate integer
        // truncation (amount / duration) and 1e18 scaling — total rounding is at most
        // duration / 1e18 * totalStaked + duration wrt the nominal 1000e6 input.
        uint256 totalEarned = aliceUsdc + bobUsdc;
        assertApproxEqAbs(aliceUsdc, totalEarned * 30 / 100, 1, "alice should earn ~30% of USDC");
        assertApproxEqAbs(bobUsdc, totalEarned * 70 / 100, 1, "bob should earn ~70% of USDC");
    }

    // ─────────────────────────────────────────────────────────────────
    //                     ADMIN TESTS
    // ─────────────────────────────────────────────────────────────────

    function test_setOperator_onlyOwner() public {
        address newOperator = vm.addr(0x99);

        // Non-owner reverts
        vm.prank(alice);
        vm.expectRevert();
        proxy.setOperator(newOperator);

        // Owner succeeds and emits OperatorRotated
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

    function test_setRewardsDuration_revertDuringActivePeriod() public {
        // Notify to start a period
        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        // Try to change duration while period is active
        vm.prank(owner);
        vm.expectRevert(DiemStakingProxy.RewardPeriodActive.selector);
        proxy.setRewardsDuration(0, 2 days);
    }

    function test_setRewardsDuration_successAfterFinish() public {
        // Notify to start a period
        channelsMock.setPayout(100e6);
        vm.prank(operator);
        proxy.settle(bytes32(0), 0, "", "");

        // Warp past periodFinish
        vm.warp(block.timestamp + USDC_DURATION + 1);

        // Now changing duration should succeed
        vm.prank(owner);
        proxy.setRewardsDuration(0, 2 days);

        (,,,, uint256 rewardsDuration) = proxy.usdcStream();
        assertEq(rewardsDuration, 2 days);
    }

    // ─────────────────────────────────────────────────────────────────
    //                     EIP-712 DELEGATION TESTS
    // ─────────────────────────────────────────────────────────────────

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

        bool valid = proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig);
        assertTrue(valid, "valid delegation should return true");
    }

    function test_isValidDelegation_expired() public view {
        uint256 expiresAt = block.timestamp - 1;
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, address(proxy), block.chainid, expiresAt);

        bool valid = proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig);
        assertFalse(valid, "expired delegation should return false");
    }

    function test_isValidDelegation_wrongChainId() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        uint256 wrongChain = block.chainid + 1;
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, address(proxy), wrongChain, expiresAt);

        bool valid = proxy.isValidDelegation(alice, address(proxy), wrongChain, expiresAt, sig);
        assertFalse(valid, "wrong chainId delegation should return false");
    }

    function test_isValidDelegation_wrongSellerContract() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        address wrongSeller = vm.addr(0x50);
        bytes memory sig = _signDelegation(OPERATOR_PK, alice, wrongSeller, block.chainid, expiresAt);

        bool valid = proxy.isValidDelegation(alice, wrongSeller, block.chainid, expiresAt, sig);
        assertFalse(valid, "wrong sellerContract should return false");
    }

    function test_isValidDelegation_sigFromNonOperator() public view {
        uint256 expiresAt = block.timestamp + 1 hours;
        // Signed by alice, not operator
        bytes memory sig = _signDelegation(ALICE_PK, alice, address(proxy), block.chainid, expiresAt);

        bool valid = proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, sig);
        assertFalse(valid, "sig from non-operator should return false");
    }

    function test_isValidDelegation_afterRotation() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Old operator signs
        bytes memory oldSig = _signDelegation(OPERATOR_PK, alice, address(proxy), block.chainid, expiresAt);

        // Rotate operator to bob
        vm.prank(owner);
        proxy.setOperator(bob);

        // Old sig now invalid
        bool oldValid = proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, oldSig);
        assertFalse(oldValid, "old operator sig should be invalid after rotation");

        // New operator (bob) signs and it should be valid
        bytes memory newSig = _signDelegation(BOB_PK, alice, address(proxy), block.chainid, expiresAt);
        bool newValid = proxy.isValidDelegation(alice, address(proxy), block.chainid, expiresAt, newSig);
        assertTrue(newValid, "new operator sig should be valid after rotation");
    }

    function test_syncVeniceCooldown_onlyOwner() public {
        // Non-owner reverts
        vm.prank(alice);
        vm.expectRevert();
        proxy.syncVeniceCooldown(14 days);

        // Owner succeeds and event emitted
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit DiemStakingProxy.VeniceCooldownSynced(14 days);
        proxy.syncVeniceCooldown(14 days);

        assertEq(proxy.VENICE_COOLDOWN(), 14 days);
    }
}
