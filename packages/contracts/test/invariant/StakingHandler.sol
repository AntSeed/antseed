// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AntseedStaking} from "../../staking/AntseedStaking.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockChannelsCounter} from "../mocks/MockChannelsCounter.sol";

/**
 * @title StakingHandler
 * @notice Stateful fuzzing handler for AntseedStaking. Drives stake/stakeFor/unstake plus an
 *         adjustable active-channel count (via MockChannelsCounter) to exercise the unstake
 *         guard. Three sellers, each owning a distinct ERC-8004 agentId registered at
 *         construction so ownership checks pass.
 */
contract StakingHandler is Test {
    AntseedStaking public staking;
    MockUSDC public usdc;
    MockERC8004Registry public identity;
    MockChannelsCounter public mockChannels;

    address[3] public sellers = [address(0xA01), address(0xA02), address(0xA03)];
    uint256[3] public agentIds;
    address public payer = address(0xBEEF);

    constructor(AntseedStaking _staking, MockUSDC _usdc, MockERC8004Registry _identity, MockChannelsCounter _mock) {
        staking = _staking;
        usdc = _usdc;
        identity = _identity;
        mockChannels = _mock;
        for (uint256 i = 0; i < sellers.length; i++) {
            vm.prank(sellers[i]);
            agentIds[i] = identity.register();
        }
    }

    function sellerCount() external pure returns (uint256) {
        return 3;
    }

    function sellerAt(uint256 i) external view returns (address) {
        return sellers[i % sellers.length];
    }

    function agentIdAt(uint256 i) external view returns (uint256) {
        return agentIds[i % agentIds.length];
    }

    // ── actions ──────────────────────────────────────────────────────────────
    function stakeSelf(uint256 sellerSeed, uint256 amount) external {
        uint256 i = sellerSeed % sellers.length;
        address s = sellers[i];
        amount = bound(amount, 1, 1e15);
        usdc.mint(s, amount);
        vm.startPrank(s);
        usdc.approve(address(staking), amount);
        try staking.stake(agentIds[i], amount) {} catch {}
        vm.stopPrank();
    }

    function stakeForOther(uint256 sellerSeed, uint256 amount) external {
        uint256 i = sellerSeed % sellers.length;
        amount = bound(amount, 1, 1e15);
        usdc.mint(address(this), amount);
        usdc.approve(address(staking), amount);
        try staking.stakeFor(sellers[i], agentIds[i], amount) {} catch {}
    }

    function unstake(uint256 sellerSeed) external {
        address s = sellers[sellerSeed % sellers.length];
        vm.prank(s);
        try staking.unstake() {} catch {}
    }

    function setActiveCount(uint256 sellerSeed, uint256 count) external {
        address s = sellers[sellerSeed % sellers.length];
        mockChannels.setActiveCount(s, bound(count, 0, 5));
    }
}
