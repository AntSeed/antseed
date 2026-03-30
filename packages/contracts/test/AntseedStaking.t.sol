// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStaking.sol";
import "../AntseedStats.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";

/// @dev Minimal mock that exposes activeChannelCount for Staking tests.
contract MockChannelsForStaking {
    mapping(address => uint256) private _activeChannelCount;

    function activeChannelCount(address seller) external view returns (uint256) {
        return _activeChannelCount[seller];
    }

    function setActiveChannelCount(address seller, uint256 count) external {
        _activeChannelCount[seller] = count;
    }
}

contract AntseedStakingTest is Test {
    MockERC8004Registry public registry;
    AntseedStats public stats;
    AntseedStaking public staking;
    MockUSDC public usdc;

    address public owner;
    address public seller = address(0x1);
    address public seller2 = address(0x2);
    address public thirdParty = address(0x3);
    address public reserve = address(0x4);

    uint256 public sellerAgentId;
    uint256 public seller2AgentId;

    uint256 public constant MIN_STAKE = 10_000_000; // 10 USDC
    uint256 public constant LARGE_STAKE = 100_000_000; // 100 USDC

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        registry = new MockERC8004Registry();
        stats = new AntseedStats();
        staking = new AntseedStaking(address(usdc), address(registry), address(stats));

        // Wire: this test contract is the channelsContract on Stats
        // so we can call updateStats directly
        stats.setChannelsContract(address(this));

        // Set a mock channels contract on Staking that reports 0 active channels by default
        MockChannelsForStaking mockChannels = new MockChannelsForStaking();
        staking.setChannelsContract(address(mockChannels));
        staking.setProtocolReserve(reserve);

        // Register sellers on MockERC8004Registry
        vm.prank(seller);
        sellerAgentId = registry.register();

        vm.prank(seller2);
        seller2AgentId = registry.register();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _stakeAs(address who, uint256 amount) internal {
        uint256 agentId;
        if (who == seller) agentId = sellerAgentId;
        else if (who == seller2) agentId = seller2AgentId;
        else revert("Unknown seller in _stakeAs");

        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(staking), amount);
        staking.stake(agentId, amount);
        vm.stopPrank();
    }

    function _addGhosts(uint256 agentId, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            stats.updateStats(
                agentId,
                IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0) // ghost
            );
        }
    }

    function _addChannels(uint256 agentId, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            stats.updateStats(
                agentId,
                IAntseedStats.StatsUpdate(0, 1_000_000, 500, 1200, 0, 0) // settlement
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    function test_constructor_setsState() public view {
        assertEq(address(staking.usdc()), address(usdc));
        assertEq(address(staking.identityRegistry()), address(registry));
        assertEq(address(staking.statsContract()), address(stats));
    }

    function test_constructor_revert_zeroUsdc() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        new AntseedStaking(address(0), address(registry), address(stats));
    }

    function test_constructor_revert_zeroRegistry() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        new AntseedStaking(address(usdc), address(0), address(stats));
    }

    function test_constructor_revert_zeroStats() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        new AntseedStaking(address(usdc), address(registry), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        stake()
    // ═══════════════════════════════════════════════════════════════════

    function test_stake_success() public {
        usdc.mint(seller, MIN_STAKE);

        vm.startPrank(seller);
        usdc.approve(address(staking), MIN_STAKE);

        vm.expectEmit(true, true, false, true);
        emit AntseedStaking.Staked(seller, sellerAgentId, MIN_STAKE);
        staking.stake(sellerAgentId, MIN_STAKE);
        vm.stopPrank();

        (uint256 stakeAmt, uint256 stakedAt) = staking.getSellerAccount(seller);
        assertEq(stakeAmt, MIN_STAKE);
        assertEq(stakedAt, block.timestamp);
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE);
    }

    function test_stake_revert_zeroAmount() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.stake(sellerAgentId, 0);
    }

    function test_stake_revert_notAgentOwner() public {
        address unregistered = address(0x99);
        usdc.mint(unregistered, MIN_STAKE);

        vm.startPrank(unregistered);
        usdc.approve(address(staking), MIN_STAKE);
        vm.expectRevert(AntseedStaking.NotAgentOwner.selector);
        staking.stake(sellerAgentId, MIN_STAKE);
        vm.stopPrank();
    }

    function test_stake_cumulative() public {
        _stakeAs(seller, MIN_STAKE);
        _stakeAs(seller, MIN_STAKE);

        assertEq(staking.getStake(seller), MIN_STAKE * 2);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        stakeFor()
    // ═══════════════════════════════════════════════════════════════════

    function test_stakeFor_success() public {
        usdc.mint(thirdParty, MIN_STAKE);

        vm.startPrank(thirdParty);
        usdc.approve(address(staking), MIN_STAKE);

        vm.expectEmit(true, true, false, true);
        emit AntseedStaking.Staked(seller, sellerAgentId, MIN_STAKE);
        staking.stakeFor(seller, sellerAgentId, MIN_STAKE);
        vm.stopPrank();

        assertEq(staking.getStake(seller), MIN_STAKE);
        assertEq(usdc.balanceOf(thirdParty), 0);
    }

    function test_stakeFor_revert_notAgentOwner() public {
        address unregistered = address(0x99);
        usdc.mint(thirdParty, MIN_STAKE);

        vm.startPrank(thirdParty);
        usdc.approve(address(staking), MIN_STAKE);
        vm.expectRevert(AntseedStaking.NotAgentOwner.selector);
        staking.stakeFor(unregistered, sellerAgentId, MIN_STAKE);
        vm.stopPrank();
    }

    function test_stakeFor_revert_zeroAmount() public {
        vm.prank(thirdParty);
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.stakeFor(seller, sellerAgentId, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        unstake()
    // ═══════════════════════════════════════════════════════════════════

    function test_unstake_noSlash() public {
        _stakeAs(seller, MIN_STAKE);

        vm.prank(seller);
        vm.expectEmit(true, false, false, true);
        emit AntseedStaking.Unstaked(seller, MIN_STAKE, 0);
        staking.unstake();

        assertEq(staking.getStake(seller), 0);
        assertEq(usdc.balanceOf(seller), MIN_STAKE);
    }

    function test_unstake_revert_noStake() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStaking.InsufficientStake.selector);
        staking.unstake();
    }

    function test_unstake_revert_activeChannels() public {
        _stakeAs(seller, MIN_STAKE);

        // Deploy a mock channels contract that reports active channels
        MockChannelsForStaking mockChannels = new MockChannelsForStaking();
        staking.setChannelsContract(address(mockChannels));
        mockChannels.setActiveChannelCount(seller, 1);

        vm.prank(seller);
        vm.expectRevert(AntseedStaking.ActiveChannels.selector);
        staking.unstake();
    }

    function test_unstake_clearsAccount() public {
        _stakeAs(seller, MIN_STAKE);

        vm.prank(seller);
        staking.unstake();

        (uint256 stakeAmt, uint256 stakedAt) = staking.getSellerAccount(seller);
        assertEq(stakeAmt, 0);
        assertEq(stakedAt, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  SLASH TIERS (via unstake)
    // ═══════════════════════════════════════════════════════════════════

    // Tier 1: ghosts >= SLASH_GHOST_THRESHOLD AND zero channels -> full slash
    function test_slash_tier1_fullSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        // Add 5 ghosts (= SLASH_GHOST_THRESHOLD), zero channels
        _addGhosts(sellerAgentId, 5);

        vm.prank(seller);
        staking.unstake();

        // Full slash: seller gets 0, reserve gets everything
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(reserve), LARGE_STAKE);
    }

    // Tier 2: channels > 0, ghost ratio >= SLASH_RATIO_THRESHOLD -> half slash
    function test_slash_tier2_halfSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        // Ghost ratio = ghosts / (channels + ghosts) >= 30%
        // 3 ghosts, 3 channels -> ratio = 3*100/(3+3) = 50% >= 30%
        _addChannels(sellerAgentId, 3);
        _addGhosts(sellerAgentId, 3);

        vm.prank(seller);
        staking.unstake();

        assertEq(usdc.balanceOf(seller), LARGE_STAKE / 2);
        assertEq(usdc.balanceOf(reserve), LARGE_STAKE / 2);
    }

    // Tier 3: channels > 0, inactive (lastSettledAt + SLASH_INACTIVITY_DAYS < now) -> 20% slash
    function test_slash_tier3_inactivitySlash() public {
        _stakeAs(seller, LARGE_STAKE);

        // Add channels (with recent settlement)
        _addChannels(sellerAgentId, 10);

        // Warp time past inactivity threshold (30 days + 1 second)
        vm.warp(block.timestamp + 30 days + 1);

        vm.prank(seller);
        staking.unstake();

        uint256 slashed = LARGE_STAKE / 5; // 20%
        assertEq(usdc.balanceOf(seller), LARGE_STAKE - slashed);
        assertEq(usdc.balanceOf(reserve), slashed);
    }

    // Tier 4: no slash (good standing)
    function test_slash_tier4_noSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        // Add channels with recent settlement, no ghosts
        _addChannels(sellerAgentId, 10);

        vm.prank(seller);
        staking.unstake();

        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
        assertEq(usdc.balanceOf(reserve), 0);
    }

    // Edge: tier 1 boundary — ghosts just below threshold, zero channels -> no slash
    function test_slash_tier1_belowThreshold_noSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        _addGhosts(sellerAgentId, 4); // below threshold of 5

        vm.prank(seller);
        staking.unstake();

        // ghosts < threshold and channels == 0 -> no tier matches, 0 slash
        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
    }

    // Edge: tier 2 boundary — ghost ratio just below threshold -> skip to tier 3 or 4
    function test_slash_tier2_belowRatioThreshold() public {
        _stakeAs(seller, LARGE_STAKE);

        // 1 ghost, 10 channels -> ratio = 1*100/(10+1) = 9% < 30%
        _addChannels(sellerAgentId, 10);
        _addGhosts(sellerAgentId, 1);

        vm.prank(seller);
        staking.unstake();

        // Recent settlement, so tier 3 won't trigger either -> no slash
        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
    }

    // Edge: slash with no protocolReserve set -> slashed funds stay in contract
    function test_slash_noReserve_fundsStayInContract() public {
        // Deploy a new staking without reserve
        AntseedStaking staking2 = new AntseedStaking(address(usdc), address(registry), address(stats));
        MockChannelsForStaking mockChannels2 = new MockChannelsForStaking();
        staking2.setChannelsContract(address(mockChannels2));
        // Don't set protocolReserve

        usdc.mint(seller, LARGE_STAKE);
        vm.startPrank(seller);
        usdc.approve(address(staking2), LARGE_STAKE);
        staking2.stake(sellerAgentId, LARGE_STAKE);
        vm.stopPrank();

        _addGhosts(sellerAgentId, 5); // tier 1 full slash

        vm.prank(seller);
        staking2.unstake();

        // Seller gets 0, reserve is address(0) so slashed funds stay in contract
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(staking2)), LARGE_STAKE);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        validateSeller()
    // ═══════════════════════════════════════════════════════════════════

    function test_validateSeller_true() public {
        _stakeAs(seller, MIN_STAKE);
        assertTrue(staking.validateSeller(seller));
    }

    function test_validateSeller_false_notStaked() public view {
        assertFalse(staking.validateSeller(seller));
    }

    function test_validateSeller_false_belowMin() public {
        _stakeAs(seller, MIN_STAKE - 1);
        assertFalse(staking.validateSeller(seller));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  getStake / isStakedAboveMin / getSellerAccount
    // ═══════════════════════════════════════════════════════════════════

    function test_getStake() public {
        _stakeAs(seller, MIN_STAKE);
        assertEq(staking.getStake(seller), MIN_STAKE);
    }

    function test_getStake_zero() public view {
        assertEq(staking.getStake(seller), 0);
    }

    function test_isStakedAboveMin_true() public {
        _stakeAs(seller, MIN_STAKE);
        assertTrue(staking.isStakedAboveMin(seller));
    }

    function test_isStakedAboveMin_false() public view {
        assertFalse(staking.isStakedAboveMin(seller));
    }

    function test_getSellerAccount() public {
        uint256 ts = block.timestamp;
        _stakeAs(seller, MIN_STAKE);

        (uint256 stakeAmt, uint256 stakedAt) = staking.getSellerAccount(seller);
        assertEq(stakeAmt, MIN_STAKE);
        assertEq(stakedAt, ts);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                     effectiveSettlements()
    // ═══════════════════════════════════════════════════════════════════

    function test_effectiveSettlements_belowCap() public {
        _stakeAs(seller, LARGE_STAKE); // 100 USDC

        _addChannels(sellerAgentId, 5);

        // stakeCap = (100_000_000 * 20) / 1_000_000 = 2000
        // channelCount = 5, which is < 2000
        assertEq(staking.effectiveSettlements(seller), 5);
    }

    function test_effectiveSettlements_aboveCap() public {
        // Tiny stake to make cap small
        _stakeAs(seller, 100_000); // 0.1 USDC

        // stakeCap = (100_000 * 20) / 1_000_000 = 2
        _addChannels(sellerAgentId, 10);

        assertEq(staking.effectiveSettlements(seller), 2);
    }

    function test_effectiveSettlements_zeroStake() public {
        _addChannels(sellerAgentId, 5);

        // stakeCap = 0, channelCount = 5 -> min(5, 0) = 0
        assertEq(staking.effectiveSettlements(seller), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function test_setChannelsContract() public {
        address newSessions = address(0x55);
        staking.setChannelsContract(newSessions);
        assertEq(staking.channelsContract(), newSessions);
    }

    function test_setChannelsContract_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setChannelsContract(address(0x55));
    }

    function test_setChannelsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setChannelsContract(address(0));
    }

    function test_setIdentityRegistry() public {
        address newRegistry = address(0x66);
        staking.setIdentityRegistry(newRegistry);
        assertEq(address(staking.identityRegistry()), newRegistry);
    }

    function test_setIdentityRegistry_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setIdentityRegistry(address(0x66));
    }

    function test_setIdentityRegistry_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setIdentityRegistry(address(0));
    }

    function test_setStatsContract() public {
        address newStats = address(0x77);
        staking.setStatsContract(newStats);
        assertEq(address(staking.statsContract()), newStats);
    }

    function test_setStatsContract_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setStatsContract(address(0x77));
    }

    function test_setStatsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setStatsContract(address(0));
    }

    function test_setProtocolReserve() public {
        address newReserve = address(0x88);
        staking.setProtocolReserve(newReserve);
        assertEq(staking.protocolReserve(), newReserve);
    }

    function test_setProtocolReserve_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setProtocolReserve(address(0x88));
    }

    function test_setProtocolReserve_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setProtocolReserve(address(0));
    }

    // ─── Individual Setters ────────────────────────────────────────────

    function test_setMinSellerStake() public {
        staking.setMinSellerStake(5_000_000);
        assertEq(staking.MIN_SELLER_STAKE(), 5_000_000);
    }

    function test_setReputationCapCoefficient() public {
        staking.setReputationCapCoefficient(50);
        assertEq(staking.REPUTATION_CAP_COEFFICIENT(), 50);
    }

    function test_setSlashRatioThreshold() public {
        staking.setSlashRatioThreshold(50);
        assertEq(staking.SLASH_RATIO_THRESHOLD(), 50);
    }

    function test_setSlashGhostThreshold() public {
        staking.setSlashGhostThreshold(10);
        assertEq(staking.SLASH_GHOST_THRESHOLD(), 10);
    }

    function test_setSlashInactivityDays() public {
        staking.setSlashInactivityDays(60 days);
        assertEq(staking.SLASH_INACTIVITY_DAYS(), 60 days);
    }

    function test_setSlashInactivityDays_revert_belowMin() public {
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.setSlashInactivityDays(1 hours); // less than 1 day
    }

    function test_setSlashInactivityDays_exactlyOneDay() public {
        staking.setSlashInactivityDays(1 days);
        assertEq(staking.SLASH_INACTIVITY_DAYS(), 1 days);
    }

    function test_setMinSellerStake_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setMinSellerStake(100);
    }
}
