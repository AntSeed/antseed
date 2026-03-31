// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedChannels.sol";
import "../AntseedStaking.sol";
import "../AntseedRegistry.sol";
import "../AntseedDeposits.sol";
import "../MockERC8004Registry.sol";
import "../MockUSDC.sol";

/// @dev Tests for AgentStats tracking within AntseedChannels.
///      Uses the Channels contract directly (stats are now inline).
contract AntseedStatsReputationTest is Test {
    AntseedChannels public channelsContract;
    AntseedStaking public staking;
    AntseedRegistry public antseedRegistry;
    AntseedDeposits public deposits;
    MockERC8004Registry public identityRegistry;
    MockUSDC public usdc;

    address public seller = address(0x1);
    address public buyer = address(0x2);
    address public reserve = address(0x4);
    uint256 public sellerAgentId;

    uint256 public constant STAKE_AMT = 10_000_000;
    uint128 public constant USDC_100 = 100_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        identityRegistry = new MockERC8004Registry();

        antseedRegistry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        channelsContract = new AntseedChannels(address(antseedRegistry));
        staking = new AntseedStaking(address(usdc), address(antseedRegistry));

        antseedRegistry.setChannels(address(channelsContract));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setStaking(address(staking));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(reserve);

        // Register seller
        vm.prank(seller);
        sellerAgentId = identityRegistry.register();

        // Stake seller
        usdc.mint(seller, STAKE_AMT);
        vm.startPrank(seller);
        usdc.approve(address(staking), STAKE_AMT);
        staking.stake(sellerAgentId, STAKE_AMT);
        vm.stopPrank();
    }

    // ── getAgentStats ──

    function test_getAgentStats_empty() public view {
        AntseedChannels.AgentStats memory s = channelsContract.getAgentStats(999);
        assertEq(s.channelCount, 0);
        assertEq(s.ghostCount, 0);
        assertEq(s.totalVolumeUsdc, 0);
        assertEq(s.totalRequestCount, 0);
        assertEq(s.lastSettledAt, 0);
    }
}
