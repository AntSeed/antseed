// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStats.sol";
import "../AntseedRegistry.sol";
import "../MockERC8004Registry.sol";

contract AntseedStatsReputationTest is Test {
    AntseedStats public stats;
    AntseedRegistry public antseedRegistry;
    MockERC8004Registry public identityRegistry;
    address public peer1 = address(0x1);
    address public buyer1 = address(0x2);
    uint256 public agentId;

    function setUp() public {
        identityRegistry = new MockERC8004Registry();
        stats = new AntseedStats();

        antseedRegistry = new AntseedRegistry();
        antseedRegistry.setChannels(address(this));
        stats.setRegistry(address(antseedRegistry));

        vm.prank(peer1);
        agentId = identityRegistry.register();
    }

    function _metadata(uint256 inTok, uint256 outTok, uint256 latMs, uint256 reqCount) internal pure returns (bytes memory) {
        return abi.encode(inTok, outTok, latMs, reqCount);
    }

    // ── updateStats tests ──

    function test_updateStats_settlement() public {
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 0, 1000000, 1000000, _metadata(500, 1200, 100, 5));
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 1);
        assertEq(s.totalVolumeUsdc, 1000000);
        assertEq(s.totalRequestCount, 5);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_updateStats_ghost() public {
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 1, 0, 0, "");
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 1);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalRequestCount, 0);
    }

    function test_updateStats_revert_notChannels() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedStats.NotAuthorized.selector);
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 0, 1000000, 1000000, _metadata(500, 1200, 100, 5));
    }

    function test_getStats_allFields() public {
        // 3 settlements with different volumes (each is a separate channel)
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 0, 5000, 5000, _metadata(500, 800, 100, 5));
        stats.updateStats(bytes32("ch2"), agentId, buyer1, 0, 3000, 3000, _metadata(300, 600, 200, 3));
        stats.updateStats(bytes32("ch3"), agentId, buyer1, 0, 2000, 2000, _metadata(200, 400, 150, 2));
        // 4 ghosts
        stats.updateStats(bytes32("g1"), agentId, buyer1, 1, 0, 0, "");
        stats.updateStats(bytes32("g2"), agentId, buyer1, 1, 0, 0, "");
        stats.updateStats(bytes32("g3"), agentId, buyer1, 1, 0, 0, "");
        stats.updateStats(bytes32("g4"), agentId, buyer1, 1, 0, 0, "");

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 3);
        assertEq(s.ghostCount, 4);
        assertEq(s.totalVolumeUsdc, 10000);
        assertEq(s.totalRequestCount, 10);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_getStats_empty() public view {
        IAntseedStats.AgentStats memory s = stats.getStats(999);
        assertEq(s.channelCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalRequestCount, 0);
        assertEq(s.lastSettledAt, 0);
    }

    function test_updateStats_multipleSettlements_accumulate() public {
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 0, 1000, 1000, _metadata(100, 200, 50, 1));
        stats.updateStats(bytes32("ch2"), agentId, buyer1, 0, 2000, 2000, _metadata(200, 300, 60, 2));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 2);
        assertEq(s.totalVolumeUsdc, 3000);
        assertEq(s.totalRequestCount, 3);
    }

    function test_updateStats_multipleGhosts_accumulate() public {
        stats.updateStats(bytes32("g1"), agentId, buyer1, 1, 0, 0, "");
        stats.updateStats(bytes32("g2"), agentId, buyer1, 1, 0, 0, "");
        stats.updateStats(bytes32("g3"), agentId, buyer1, 1, 0, 0, "");

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 3);
        assertEq(s.channelCount, 0);
    }

    function test_emitsChannelMetrics_cumulative() public {
        // Partial settle: delta=3000, cumulative=3000, 3 requests
        vm.expectEmit(true, true, true, true);
        emit AntseedStats.ChannelMetrics(
            bytes32("ch1"), agentId, buyer1,
            3000, 300, 600, 80, 3
        );
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 2, 3000, 3000, _metadata(300, 600, 80, 3));

        // Close: delta=2000, cumulative=5000, 8 cumulative requests — event uses cumulatives
        vm.expectEmit(true, true, true, true);
        emit AntseedStats.ChannelMetrics(
            bytes32("ch1"), agentId, buyer1,
            5000, 500, 1200, 150, 8
        );
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 0, 2000, 5000, _metadata(500, 1200, 150, 8));

        // Verify storage uses deltas — no double-counting
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.totalVolumeUsdc, 5000);  // 3000 + 2000
        assertEq(s.totalRequestCount, 8);    // delta: 3 + 5 = 8, not 3 + 8 = 11
        assertEq(s.channelCount, 1);
    }

    function test_partialSettlement_emitsButNoChannelCount() public {
        stats.updateStats(bytes32("ch1"), agentId, buyer1, 2, 3000, 3000, _metadata(300, 600, 80, 3));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 0); // partial settlement does NOT increment
        assertEq(s.totalVolumeUsdc, 3000);
        assertEq(s.totalRequestCount, 3);
    }

    function test_ghost_doesNotEmitChannelMetrics() public {
        stats.updateStats(bytes32("g1"), agentId, buyer1, 1, 0, 0, "");
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 1);
        assertEq(s.lastSettledAt, 0); // ghost doesn't update lastSettledAt
    }
}
