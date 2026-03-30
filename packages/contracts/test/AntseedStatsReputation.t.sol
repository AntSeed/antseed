// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStats.sol";
import "../MockERC8004Registry.sol";

contract AntseedStatsReputationTest is Test {
    AntseedStats public stats;
    MockERC8004Registry public registry;
    address public peer1 = address(0x1);
    uint256 public agentId;

    function setUp() public {
        registry = new MockERC8004Registry();
        stats = new AntseedStats();
        // Set this test contract as the channels contract so it can call updateStats
        stats.setChannelsContract(address(this));

        vm.prank(peer1);
        agentId = registry.register();
    }

    // ── updateStats tests ──

    function test_updateStats_settlement() public {
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 1000000, 500, 1200, 0, 0));
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 1);
        assertEq(s.totalVolumeUsdc, 1000000);
        assertEq(s.totalInputTokens, 500);
        assertEq(s.totalOutputTokens, 1200);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_updateStats_ghost() public {
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 1);
    }

    function test_updateStats_revert_notChannels() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedStats.NotAuthorized.selector);
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 1000000, 500, 1200, 0, 0));
    }

    function test_getStats_allFields() public {
        // 3 settlements with different volumes
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 5000, 500, 800, 100, 5));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 3000, 300, 600, 200, 3));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 2000, 200, 400, 150, 2));
        // 4 ghosts
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 3);
        assertEq(s.ghostCount, 4);
        assertEq(s.totalVolumeUsdc, 10000);
        assertEq(s.totalInputTokens, 1000);
        assertEq(s.totalOutputTokens, 1800);
        assertEq(s.totalLatencyMs, 450);
        assertEq(s.totalRequestCount, 10);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_getStats_empty() public view {
        IAntseedStats.AgentStats memory s = stats.getStats(999);
        assertEq(s.channelCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalInputTokens, 0);
        assertEq(s.totalOutputTokens, 0);
        assertEq(s.totalLatencyMs, 0);
        assertEq(s.totalRequestCount, 0);
        assertEq(s.lastSettledAt, 0);
    }

    function test_updateStats_multipleSettlements_accumulate() public {
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 1000, 100, 200, 50, 1));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(0, 2000, 200, 300, 60, 2));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 2);
        assertEq(s.totalVolumeUsdc, 3000);
        assertEq(s.totalInputTokens, 300);
        assertEq(s.totalOutputTokens, 500);
        assertEq(s.totalLatencyMs, 110);
        assertEq(s.totalRequestCount, 3);
    }

    function test_updateStats_multipleGhosts_accumulate() public {
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));
        stats.updateStats(agentId, IAntseedStats.StatsUpdate(1, 0, 0, 0, 0, 0));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 3);
        assertEq(s.channelCount, 0);
    }
}
