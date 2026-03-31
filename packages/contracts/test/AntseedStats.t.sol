// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStats.sol";
import "../AntseedStaking.sol";
import "../AntseedRegistry.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";
import {MockChannelsForStaking} from "./AntseedStaking.t.sol";

contract AntseedStatsTest is Test {
    AntseedStats public stats;
    AntseedStaking public staking;
    MockERC8004Registry public identityRegistry;
    AntseedRegistry public statsRegistry;
    AntseedRegistry public stakingRegistry;
    MockUSDC public usdc;
    address public owner;
    address public peer1 = address(0x1);
    address public peer2 = address(0x2);

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        identityRegistry = new MockERC8004Registry();
        stats = new AntseedStats();

        // Registry for stats: channels = address(this) so test can call updateStats
        statsRegistry = new AntseedRegistry();
        statsRegistry.setChannels(address(this));
        stats.setRegistry(address(statsRegistry));

        // Registry for staking: channels = mockChannels (needed for unstake's activeChannelCount check)
        MockChannelsForStaking mockChannels = new MockChannelsForStaking();
        stakingRegistry = new AntseedRegistry();
        stakingRegistry.setChannels(address(mockChannels));
        stakingRegistry.setIdentityRegistry(address(identityRegistry));
        stakingRegistry.setStats(address(stats));

        staking = new AntseedStaking(address(usdc), address(stakingRegistry));
    }

    function test_register() public {
        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        assertEq(identityRegistry.ownerOf(agentId), peer1);
        assertEq(identityRegistry.balanceOf(peer1), 1);
    }

    function test_register_multipleAgents() public {
        vm.prank(peer1);
        uint256 agentId1 = identityRegistry.register();

        vm.prank(peer2);
        uint256 agentId2 = identityRegistry.register();

        assertEq(identityRegistry.ownerOf(agentId1), peer1);
        assertEq(identityRegistry.ownerOf(agentId2), peer2);
        assertTrue(agentId1 != agentId2);
    }

    function test_setMetadata() public {
        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        bytes memory peerId = abi.encodePacked(keccak256("peer1"));
        vm.prank(peer1);
        identityRegistry.setMetadata(agentId, "antseed.peerId", peerId);

        assertEq(identityRegistry.getMetadata(agentId, "antseed.peerId"), peerId);
    }

    function test_setMetadata_revert_notOwner() public {
        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        vm.prank(peer2);
        vm.expectRevert("Not owner");
        identityRegistry.setMetadata(agentId, "antseed.peerId", abi.encodePacked("hacked"));
    }

    function test_stake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        vm.startPrank(peer1);
        usdc.approve(address(staking), stakeAmount);
        staking.stake(agentId, stakeAmount);
        vm.stopPrank();

        (uint256 stake,) = staking.getSellerAccount(peer1);
        assertEq(stake, stakeAmount);
        assertEq(staking.getAgentId(peer1), agentId);
    }

    function test_stake_revert_notAgentOwner() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer2, stakeAmount);

        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        vm.startPrank(peer2);
        usdc.approve(address(staking), stakeAmount);
        vm.expectRevert(AntseedStaking.NotAgentOwner.selector);
        staking.stake(agentId, stakeAmount);
        vm.stopPrank();
    }

    function test_stakeFor() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(address(this), stakeAmount);

        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        usdc.approve(address(staking), stakeAmount);
        staking.stakeFor(peer1, agentId, stakeAmount);

        (uint256 stake,) = staking.getSellerAccount(peer1);
        assertEq(stake, stakeAmount);
    }

    function test_unstake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 agentId = identityRegistry.register();

        vm.startPrank(peer1);
        usdc.approve(address(staking), stakeAmount);
        staking.stake(agentId, stakeAmount);
        staking.unstake();
        vm.stopPrank();

        (uint256 stake,) = staking.getSellerAccount(peer1);
        assertEq(stake, 0);
    }

    function test_setRegistry() public {
        AntseedRegistry newRegistry = new AntseedRegistry();
        newRegistry.setChannels(address(0x99));
        stats.setRegistry(address(newRegistry));
        assertEq(address(stats.registry()), address(newRegistry));
    }

    function test_setRegistry_revert_zeroAddress() public {
        vm.expectRevert(AntseedStats.InvalidAddress.selector);
        stats.setRegistry(address(0));
    }

    function test_getStats_default() public view {
        IAntseedStats.AgentStats memory s = stats.getStats(999);
        assertEq(s.channelCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
    }
}
