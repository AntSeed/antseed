// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockChannelsCounter
 * @notice Minimal stand-in for AntseedChannels that exposes only the one method
 *         AntseedStaking reads — `activeChannelCount(address)` — with a settable value.
 *         Lets the staking suite drive the unstake guard against arbitrary counts
 *         without spinning up the full payment stack.
 */
contract MockChannelsCounter {
    mapping(address => uint256) public activeChannelCount;

    function setActiveCount(address seller, uint256 n) external {
        activeChannelCount[seller] = n;
    }
}
