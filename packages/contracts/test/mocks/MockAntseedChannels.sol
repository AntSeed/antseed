// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAntseedChannels} from "../../interfaces/IAntseedChannels.sol";

/**
 * @dev Minimal mock that matches the façade-visible surface of AntseedChannels.
 *      `settle` and `close` transfer a configured USDC payout to msg.sender (the façade).
 */
contract MockAntseedChannels is IAntseedChannels {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdc;
    uint128 public configuredPayout;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function setPayout(uint128 amount) external { configuredPayout = amount; }

    function getAgentStats(uint256) external pure returns (AgentStats memory) {
        return AgentStats(0, 0, 0, 0);
    }

    function activeChannelCount(address) external pure returns (uint256) { return 0; }

    function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(buyer, seller, salt));
    }

    function reserve(address, bytes32, uint128, uint256, bytes calldata) external pure {}

    function topUp(bytes32, uint128, bytes calldata, bytes calldata, uint128, uint256, bytes calldata) external {
        if (configuredPayout > 0) usdc.safeTransfer(msg.sender, configuredPayout);
    }

    function settle(bytes32, uint128, bytes calldata, bytes calldata) external {
        if (configuredPayout > 0) usdc.safeTransfer(msg.sender, configuredPayout);
    }

    function close(bytes32, uint128, bytes calldata, bytes calldata) external {
        if (configuredPayout > 0) usdc.safeTransfer(msg.sender, configuredPayout);
    }

    function requestClose(bytes32) external pure {}
    function withdraw(bytes32) external pure {}
}
