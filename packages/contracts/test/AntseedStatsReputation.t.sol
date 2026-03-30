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

    // ── recordClose ──

    function test_recordClose_basic() public {
        stats.recordClose(bytes32("ch1"), agentId, buyer1, 1000000, _metadata(500, 1200, 100, 5));
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 1);
        assertEq(s.totalVolumeUsdc, 1000000);
        assertEq(s.totalRequestCount, 5);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_recordClose_multipleChannels() public {
        stats.recordClose(bytes32("ch1"), agentId, buyer1, 5000, _metadata(500, 800, 100, 5));
        stats.recordClose(bytes32("ch2"), agentId, buyer1, 3000, _metadata(300, 600, 200, 3));
        stats.recordClose(bytes32("ch3"), agentId, buyer1, 2000, _metadata(200, 400, 150, 2));

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 3);
        assertEq(s.totalVolumeUsdc, 10000);
        assertEq(s.totalRequestCount, 10);
        assertEq(s.lastSettledAt, block.timestamp);
    }

    function test_recordClose_emitsChannelMetrics() public {
        vm.expectEmit(true, true, true, true);
        emit AntseedStats.ChannelMetrics(
            bytes32("ch1"), agentId, buyer1,
            5000, 500, 800, 100, 5
        );
        stats.recordClose(bytes32("ch1"), agentId, buyer1, 5000, _metadata(500, 800, 100, 5));
    }

    function test_recordClose_revert_notChannels() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedStats.NotAuthorized.selector);
        stats.recordClose(bytes32("ch1"), agentId, buyer1, 1000000, _metadata(500, 1200, 100, 5));
    }

    // ── recordGhost ──

    function test_recordGhost_basic() public {
        stats.recordGhost(agentId);
        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 1);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalRequestCount, 0);
        assertEq(s.lastSettledAt, 0);
    }

    function test_recordGhost_multiple() public {
        stats.recordGhost(agentId);
        stats.recordGhost(agentId);
        stats.recordGhost(agentId);

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.ghostCount, 3);
        assertEq(s.channelCount, 0);
    }

    function test_recordGhost_revert_notChannels() public {
        vm.prank(peer1);
        vm.expectRevert(AntseedStats.NotAuthorized.selector);
        stats.recordGhost(agentId);
    }

    // ── getStats ──

    function test_getStats_empty() public view {
        IAntseedStats.AgentStats memory s = stats.getStats(999);
        assertEq(s.channelCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalRequestCount, 0);
        assertEq(s.lastSettledAt, 0);
    }

    function test_getStats_mixedCloseAndGhost() public {
        stats.recordClose(bytes32("ch1"), agentId, buyer1, 5000, _metadata(500, 800, 100, 5));
        stats.recordClose(bytes32("ch2"), agentId, buyer1, 3000, _metadata(300, 600, 200, 3));
        stats.recordGhost(agentId);
        stats.recordGhost(agentId);
        stats.recordGhost(agentId);
        stats.recordGhost(agentId);

        IAntseedStats.AgentStats memory s = stats.getStats(agentId);
        assertEq(s.channelCount, 2);
        assertEq(s.ghostCount, 4);
        assertEq(s.totalVolumeUsdc, 8000);
        assertEq(s.totalRequestCount, 8);
    }
}
