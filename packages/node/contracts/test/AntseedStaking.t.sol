// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedIdentity.sol";
import "../AntseedStaking.sol";
import "../MockUSDC.sol";

contract AntseedStakingTest is Test {
    AntseedIdentity public identity;
    AntseedStaking public staking;
    MockUSDC public usdc;

    address public owner;
    address public seller = address(0x1);
    address public seller2 = address(0x2);
    address public thirdParty = address(0x3);
    address public reserve = address(0x4);

    bytes32 public peerId1 = keccak256("seller1");
    bytes32 public peerId2 = keccak256("seller2");

    uint256 public constant MIN_STAKE = 10_000_000; // 10 USDC
    uint256 public constant LARGE_STAKE = 100_000_000; // 100 USDC

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        identity = new AntseedIdentity();
        staking = new AntseedStaking(address(usdc), address(identity));

        // Wire: this test contract is the sessionsContract on both Identity and Staking
        // so we can call updateReputation and increment/decrement sessions directly
        identity.setSessionsContract(address(this));
        identity.setStakingContract(address(staking));
        staking.setSessionsContract(address(this));
        staking.setProtocolReserve(reserve);

        // Register sellers
        vm.prank(seller);
        identity.register(peerId1, "ipfs://seller1");

        vm.prank(seller2);
        identity.register(peerId2, "ipfs://seller2");
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _stakeAs(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _addGhosts(uint256 tokenId, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            identity.updateReputation(
                tokenId,
                AntseedIdentity.ReputationUpdate(1, 0, 0, 0) // ghost
            );
        }
    }

    function _addSessions(uint256 tokenId, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            identity.updateReputation(
                tokenId,
                AntseedIdentity.ReputationUpdate(0, 1_000_000, 500, 1200) // settlement
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    function test_constructor_setsState() public view {
        assertEq(address(staking.usdc()), address(usdc));
        assertEq(address(staking.identityContract()), address(identity));
    }

    function test_constructor_revert_zeroUsdc() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        new AntseedStaking(address(0), address(identity));
    }

    function test_constructor_revert_zeroIdentity() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        new AntseedStaking(address(usdc), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        stake()
    // ═══════════════════════════════════════════════════════════════════

    function test_stake_success() public {
        usdc.mint(seller, MIN_STAKE);

        vm.startPrank(seller);
        usdc.approve(address(staking), MIN_STAKE);

        vm.expectEmit(true, false, false, true);
        emit AntseedStaking.Staked(seller, MIN_STAKE);
        staking.stake(MIN_STAKE);
        vm.stopPrank();

        (uint256 stakeAmt, uint256 stakedAt) = staking.getSellerAccount(seller);
        assertEq(stakeAmt, MIN_STAKE);
        assertEq(stakedAt, block.timestamp);
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE);
    }

    function test_stake_revert_zeroAmount() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.stake(0);
    }

    function test_stake_revert_notRegistered() public {
        address unregistered = address(0x99);
        usdc.mint(unregistered, MIN_STAKE);

        vm.startPrank(unregistered);
        usdc.approve(address(staking), MIN_STAKE);
        vm.expectRevert(AntseedStaking.NotRegistered.selector);
        staking.stake(MIN_STAKE);
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

        vm.expectEmit(true, false, false, true);
        emit AntseedStaking.Staked(seller, MIN_STAKE);
        staking.stakeFor(seller, MIN_STAKE);
        vm.stopPrank();

        assertEq(staking.getStake(seller), MIN_STAKE);
        assertEq(usdc.balanceOf(thirdParty), 0);
    }

    function test_stakeFor_revert_notRegistered() public {
        address unregistered = address(0x99);
        usdc.mint(thirdParty, MIN_STAKE);

        vm.startPrank(thirdParty);
        usdc.approve(address(staking), MIN_STAKE);
        vm.expectRevert(AntseedStaking.NotRegistered.selector);
        staking.stakeFor(unregistered, MIN_STAKE);
        vm.stopPrank();
    }

    function test_stakeFor_revert_zeroAmount() public {
        vm.prank(thirdParty);
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.stakeFor(seller, 0);
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

    function test_unstake_revert_activeSessions() public {
        _stakeAs(seller, MIN_STAKE);

        // increment active sessions (we are the sessionsContract)
        staking.incrementActiveSessions(seller);

        vm.prank(seller);
        vm.expectRevert(AntseedStaking.ActiveSessions.selector);
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

    // Tier 1: ghosts >= SLASH_GHOST_THRESHOLD AND zero sessions -> full slash
    function test_slash_tier1_fullSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        uint256 tokenId = identity.getTokenId(seller);
        // Add 5 ghosts (= SLASH_GHOST_THRESHOLD), zero sessions
        _addGhosts(tokenId, 5);

        vm.prank(seller);
        staking.unstake();

        // Full slash: seller gets 0, reserve gets everything
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(reserve), LARGE_STAKE);
    }

    // Tier 2: sessions > 0, ghost ratio >= SLASH_RATIO_THRESHOLD -> half slash
    function test_slash_tier2_halfSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        uint256 tokenId = identity.getTokenId(seller);
        // Ghost ratio = ghosts / (sessions + ghosts) >= 30%
        // 3 ghosts, 3 sessions -> ratio = 3*100/(3+3) = 50% >= 30%
        _addSessions(tokenId, 3);
        _addGhosts(tokenId, 3);

        vm.prank(seller);
        staking.unstake();

        assertEq(usdc.balanceOf(seller), LARGE_STAKE / 2);
        assertEq(usdc.balanceOf(reserve), LARGE_STAKE / 2);
    }

    // Tier 3: sessions > 0, inactive (lastSettledAt + SLASH_INACTIVITY_DAYS < now) -> 20% slash
    function test_slash_tier3_inactivitySlash() public {
        _stakeAs(seller, LARGE_STAKE);

        uint256 tokenId = identity.getTokenId(seller);
        // Add sessions (with recent settlement)
        _addSessions(tokenId, 10);

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

        uint256 tokenId = identity.getTokenId(seller);
        // Add sessions with recent settlement, no ghosts
        _addSessions(tokenId, 10);

        vm.prank(seller);
        staking.unstake();

        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
        assertEq(usdc.balanceOf(reserve), 0);
    }

    // Edge: tier 1 boundary — ghosts just below threshold, zero sessions -> no slash
    function test_slash_tier1_belowThreshold_noSlash() public {
        _stakeAs(seller, LARGE_STAKE);

        uint256 tokenId = identity.getTokenId(seller);
        _addGhosts(tokenId, 4); // below threshold of 5

        vm.prank(seller);
        staking.unstake();

        // ghosts < threshold and sessions == 0 -> no tier matches, 0 slash
        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
    }

    // Edge: tier 2 boundary — ghost ratio just below threshold -> skip to tier 3 or 4
    function test_slash_tier2_belowRatioThreshold() public {
        _stakeAs(seller, LARGE_STAKE);

        uint256 tokenId = identity.getTokenId(seller);
        // 1 ghost, 10 sessions -> ratio = 1*100/(10+1) = 9% < 30%
        _addSessions(tokenId, 10);
        _addGhosts(tokenId, 1);

        vm.prank(seller);
        staking.unstake();

        // Recent settlement, so tier 3 won't trigger either -> no slash
        assertEq(usdc.balanceOf(seller), LARGE_STAKE);
    }

    // Edge: slash with no protocolReserve set -> slashed funds stay in contract
    function test_slash_noReserve_fundsStayInContract() public {
        // Deploy a new staking without reserve
        AntseedStaking staking2 = new AntseedStaking(address(usdc), address(identity));
        staking2.setSessionsContract(address(this));
        // Don't set protocolReserve

        usdc.mint(seller, LARGE_STAKE);
        vm.startPrank(seller);
        usdc.approve(address(staking2), LARGE_STAKE);
        staking2.stake(LARGE_STAKE);
        vm.stopPrank();

        uint256 tokenId = identity.getTokenId(seller);
        _addGhosts(tokenId, 5); // tier 1 full slash

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

        uint256 tokenId = identity.getTokenId(seller);
        _addSessions(tokenId, 5);

        // stakeCap = (100_000_000 * 20) / 1_000_000 = 2000
        // sessionCount = 5, which is < 2000
        assertEq(staking.effectiveSettlements(seller), 5);
    }

    function test_effectiveSettlements_aboveCap() public {
        // Tiny stake to make cap small
        _stakeAs(seller, 100_000); // 0.1 USDC

        uint256 tokenId = identity.getTokenId(seller);
        // stakeCap = (100_000 * 20) / 1_000_000 = 2
        _addSessions(tokenId, 10);

        assertEq(staking.effectiveSettlements(seller), 2);
    }

    function test_effectiveSettlements_zeroStake() public {
        uint256 tokenId = identity.getTokenId(seller);
        _addSessions(tokenId, 5);

        // stakeCap = 0, sessionCount = 5 -> min(5, 0) = 0
        assertEq(staking.effectiveSettlements(seller), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //              incrementActiveSessions / decrementActiveSessions
    // ═══════════════════════════════════════════════════════════════════

    function test_incrementActiveSessions() public {
        staking.incrementActiveSessions(seller);
        assertEq(staking.activeSessionCount(seller), 1);

        staking.incrementActiveSessions(seller);
        assertEq(staking.activeSessionCount(seller), 2);
    }

    function test_incrementActiveSessions_revert_notSessions() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStaking.NotAuthorized.selector);
        staking.incrementActiveSessions(seller);
    }

    function test_decrementActiveSessions() public {
        staking.incrementActiveSessions(seller);
        staking.incrementActiveSessions(seller);
        staking.decrementActiveSessions(seller);

        assertEq(staking.activeSessionCount(seller), 1);
    }

    function test_decrementActiveSessions_revert_notSessions() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStaking.NotAuthorized.selector);
        staking.decrementActiveSessions(seller);
    }

    function test_decrementActiveSessions_revert_underflow() public {
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.decrementActiveSessions(seller);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function test_setSessionsContract() public {
        address newSessions = address(0x55);
        staking.setSessionsContract(newSessions);
        assertEq(staking.sessionsContract(), newSessions);
    }

    function test_setSessionsContract_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setSessionsContract(address(0x55));
    }

    function test_setSessionsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setSessionsContract(address(0));
    }

    function test_setIdentityContract() public {
        address newIdentity = address(0x66);
        staking.setIdentityContract(newIdentity);
        assertEq(address(staking.identityContract()), newIdentity);
    }

    function test_setIdentityContract_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setIdentityContract(address(0x66));
    }

    function test_setIdentityContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setIdentityContract(address(0));
    }

    function test_setProtocolReserve() public {
        address newReserve = address(0x77);
        staking.setProtocolReserve(newReserve);
        assertEq(staking.protocolReserve(), newReserve);
    }

    function test_setProtocolReserve_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setProtocolReserve(address(0x77));
    }

    function test_setProtocolReserve_revert_zeroAddress() public {
        vm.expectRevert(AntseedStaking.InvalidAddress.selector);
        staking.setProtocolReserve(address(0));
    }

    // ─── setConstant ─────────────────────────────────────────────────

    function test_setConstant_minSellerStake() public {
        bytes32 key = keccak256("MIN_SELLER_STAKE");
        vm.expectEmit(true, false, false, true);
        emit AntseedStaking.ConstantUpdated(key, 5_000_000);
        staking.setConstant(key, 5_000_000);

        assertEq(staking.MIN_SELLER_STAKE(), 5_000_000);
    }

    function test_setConstant_reputationCapCoefficient() public {
        bytes32 key = keccak256("REPUTATION_CAP_COEFFICIENT");
        staking.setConstant(key, 50);
        assertEq(staking.REPUTATION_CAP_COEFFICIENT(), 50);
    }

    function test_setConstant_slashRatioThreshold() public {
        bytes32 key = keccak256("SLASH_RATIO_THRESHOLD");
        staking.setConstant(key, 50);
        assertEq(staking.SLASH_RATIO_THRESHOLD(), 50);
    }

    function test_setConstant_slashGhostThreshold() public {
        bytes32 key = keccak256("SLASH_GHOST_THRESHOLD");
        staking.setConstant(key, 10);
        assertEq(staking.SLASH_GHOST_THRESHOLD(), 10);
    }

    function test_setConstant_slashInactivityDays() public {
        bytes32 key = keccak256("SLASH_INACTIVITY_DAYS");
        staking.setConstant(key, 60 days);
        assertEq(staking.SLASH_INACTIVITY_DAYS(), 60 days);
    }

    function test_setConstant_slashInactivityDays_revert_belowMin() public {
        bytes32 key = keccak256("SLASH_INACTIVITY_DAYS");
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.setConstant(key, 1 hours); // less than 1 day
    }

    function test_setConstant_slashInactivityDays_exactlyOneDay() public {
        bytes32 key = keccak256("SLASH_INACTIVITY_DAYS");
        staking.setConstant(key, 1 days);
        assertEq(staking.SLASH_INACTIVITY_DAYS(), 1 days);
    }

    function test_setConstant_revert_unknownKey() public {
        vm.expectRevert(AntseedStaking.InvalidAmount.selector);
        staking.setConstant(keccak256("UNKNOWN_KEY"), 100);
    }

    function test_setConstant_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", seller));
        staking.setConstant(keccak256("MIN_SELLER_STAKE"), 100);
    }
}
