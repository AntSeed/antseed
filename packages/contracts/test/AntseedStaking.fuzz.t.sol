// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedStaking} from "../AntseedStaking.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {MockUSDC} from "../MockUSDC.sol";
import {MockERC8004Registry} from "../MockERC8004Registry.sol";
import {MockChannelsCounter} from "./mocks/MockChannelsCounter.sol";

/**
 * @title AntseedStakingFuzz
 * @notice Stateless fuzz tests for AntseedStaking custody and identity-binding mechanics.
 *         Deployed WITHOUT a slashing module (slashing is being reworked), so these assert
 *         the structural, incentive-independent properties: exact stake custody, the
 *         agentId<->seller binding, and the unstake guard.
 */
contract AntseedStakingFuzz is Test {
    MockUSDC usdc;
    MockERC8004Registry identity;
    AntseedRegistry registry;
    MockChannelsCounter mockChannels;
    AntseedStaking staking;

    address sellerA = address(0xA1);
    address sellerB = address(0xB2);
    address payer = address(0xBEEF);

    function setUp() public {
        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        registry = new AntseedRegistry();
        mockChannels = new MockChannelsCounter();
        staking = new AntseedStaking(address(usdc), address(registry));

        registry.setIdentityRegistry(address(identity));
        registry.setChannels(address(mockChannels));
        registry.setProtocolReserve(address(0xFEE));
        // No slashing module set -> unstake returns the full stake.
    }

    function _register(address who) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = identity.register();
    }

    function _stake(address seller, uint256 agentId, uint256 amount) internal {
        usdc.mint(seller, amount);
        vm.startPrank(seller);
        usdc.approve(address(staking), amount);
        staking.stake(agentId, amount);
        vm.stopPrank();
    }

    // ── stake custody + binding ──────────────────────────────────────────────
    function testFuzz_stake_custodyAndBinding(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agentId = _register(sellerA);
        _stake(sellerA, agentId, amount);

        assertEq(staking.getStake(sellerA), amount, "stake amount");
        assertEq(usdc.balanceOf(address(staking)), amount, "custody");
        assertEq(staking.sellerAgentId(sellerA), agentId, "seller->agent");
        assertEq(staking.agentSeller(agentId), sellerA, "agent->seller");
    }

    function testFuzz_stake_isAdditive(uint256 a, uint256 b) public {
        a = bound(a, 1, 1e15);
        b = bound(b, 1, 1e15);
        uint256 agentId = _register(sellerA);
        _stake(sellerA, agentId, a);
        _stake(sellerA, agentId, b);
        assertEq(staking.getStake(sellerA), a + b);
        assertEq(usdc.balanceOf(address(staking)), a + b);
    }

    // ── ownership / binding rejections ───────────────────────────────────────
    /// @notice A seller cannot stake an agentId owned by someone else.
    function testFuzz_stake_requiresOwnership(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agentB = _register(sellerB); // owned by B
        usdc.mint(sellerA, amount);
        vm.startPrank(sellerA);
        usdc.approve(address(staking), amount);
        vm.expectRevert(AntseedStaking.NotAgentOwner.selector);
        staking.stake(agentB, amount);
        vm.stopPrank();
    }

    /// @notice A seller bound to one agentId cannot stake under a different agentId.
    function testFuzz_stake_agentIdMismatch(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agent1 = _register(sellerA);
        uint256 agent2 = _register(sellerA); // same owner, second agent
        _stake(sellerA, agent1, amount);

        usdc.mint(sellerA, amount);
        vm.startPrank(sellerA);
        usdc.approve(address(staking), amount);
        vm.expectRevert(AntseedStaking.AgentIdMismatch.selector);
        staking.stake(agent2, amount);
        vm.stopPrank();
    }

    // ── unstake ──────────────────────────────────────────────────────────────
    function testFuzz_unstake_returnsExactStake(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agentId = _register(sellerA);
        _stake(sellerA, agentId, amount);

        vm.prank(sellerA);
        staking.unstake();

        assertEq(usdc.balanceOf(sellerA), amount, "exact stake returned");
        assertEq(staking.getStake(sellerA), 0, "stake cleared");
        assertEq(usdc.balanceOf(address(staking)), 0, "custody emptied");
        assertEq(staking.sellerAgentId(sellerA), 0, "seller->agent cleared");
        assertEq(staking.agentSeller(agentId), address(0), "agent->seller cleared");
    }

    function testFuzz_unstake_blockedWithActiveChannels(uint256 amount, uint256 count) public {
        amount = bound(amount, 1, 1e15);
        count = bound(count, 1, type(uint256).max);
        uint256 agentId = _register(sellerA);
        _stake(sellerA, agentId, amount);

        mockChannels.setActiveCount(sellerA, count);

        vm.prank(sellerA);
        vm.expectRevert(AntseedStaking.ActiveChannels.selector);
        staking.unstake();
    }

    function test_unstake_requiresStake() public {
        vm.prank(sellerA);
        vm.expectRevert(AntseedStaking.InsufficientStake.selector);
        staking.unstake();
    }

    // ── stakeFor ───────────────────────────────────────────────────────────
    function testFuzz_stakeFor_paysFromCallerBindsSeller(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agentId = _register(sellerA); // seller owns the agent

        usdc.mint(payer, amount);
        vm.startPrank(payer);
        usdc.approve(address(staking), amount);
        staking.stakeFor(sellerA, agentId, amount);
        vm.stopPrank();

        assertEq(staking.getStake(sellerA), amount, "stake credited to seller");
        assertEq(usdc.balanceOf(payer), 0, "paid from caller");
        assertEq(usdc.balanceOf(address(staking)), amount, "custody");
        assertEq(staking.agentSeller(agentId), sellerA, "binding");
    }

    // ── threshold view ──────────────────────────────────────────────────────
    function testFuzz_isStakedAboveMin(uint256 amount) public {
        amount = bound(amount, 1, 1e15);
        uint256 agentId = _register(sellerA);
        _stake(sellerA, agentId, amount);
        assertEq(staking.isStakedAboveMin(sellerA), amount >= staking.MIN_SELLER_STAKE());
    }
}
