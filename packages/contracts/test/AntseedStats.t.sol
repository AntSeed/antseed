// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStats.sol";
import "../AntseedStaking.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";

contract AntseedStatsTest is Test {
    AntseedStats public stats;
    AntseedStaking public staking;
    MockERC8004Registry public registry;
    MockUSDC public usdc;
    address public owner;
    address public peer1 = address(0x1);
    address public peer2 = address(0x2);

    function setUp() public {
        owner = address(this);
        usdc = new MockUSDC();
        registry = new MockERC8004Registry();
        stats = new AntseedStats();
        staking = new AntseedStaking(address(usdc), address(registry), address(stats));

        // Set this test contract as the sessions contract so it can call updateStats
        stats.setChannelsContract(address(this));
    }

    function test_register() public {
        vm.prank(peer1);
        uint256 agentId = registry.register();

        assertEq(registry.ownerOf(agentId), peer1);
        assertEq(registry.balanceOf(peer1), 1);
    }

    function test_register_multipleAgents() public {
        vm.prank(peer1);
        uint256 agentId1 = registry.register();

        vm.prank(peer2);
        uint256 agentId2 = registry.register();

        assertEq(registry.ownerOf(agentId1), peer1);
        assertEq(registry.ownerOf(agentId2), peer2);
        assertTrue(agentId1 != agentId2);
    }

    function test_setMetadata() public {
        vm.prank(peer1);
        uint256 agentId = registry.register();

        bytes memory peerId = abi.encodePacked(keccak256("peer1"));
        vm.prank(peer1);
        registry.setMetadata(agentId, "antseed.peerId", peerId);

        assertEq(registry.getMetadata(agentId, "antseed.peerId"), peerId);
    }

    function test_setMetadata_revert_notOwner() public {
        vm.prank(peer1);
        uint256 agentId = registry.register();

        vm.prank(peer2);
        vm.expectRevert("Not owner");
        registry.setMetadata(agentId, "antseed.peerId", abi.encodePacked("hacked"));
    }

    function test_stake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 agentId = registry.register();

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
        uint256 agentId = registry.register();

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
        uint256 agentId = registry.register();

        usdc.approve(address(staking), stakeAmount);
        staking.stakeFor(peer1, agentId, stakeAmount);

        (uint256 stake,) = staking.getSellerAccount(peer1);
        assertEq(stake, stakeAmount);
    }

    function test_unstake() public {
        uint256 stakeAmount = 10_000_000;
        usdc.mint(peer1, stakeAmount);

        vm.prank(peer1);
        uint256 agentId = registry.register();

        vm.startPrank(peer1);
        usdc.approve(address(staking), stakeAmount);
        staking.stake(agentId, stakeAmount);
        staking.unstake();
        vm.stopPrank();

        (uint256 stake,) = staking.getSellerAccount(peer1);
        assertEq(stake, 0);
    }

    function test_setChannelsContract() public {
        stats.setChannelsContract(address(0x99));
        assertEq(stats.channelsContract(), address(0x99));
    }

    function test_setChannelsContract_revert_zeroAddress() public {
        vm.expectRevert(AntseedStats.InvalidAddress.selector);
        stats.setChannelsContract(address(0));
    }

    function test_getStats_default() public view {
        IAntseedStats.AgentStats memory s = stats.getStats(999);
        assertEq(s.sessionCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
    }
}
