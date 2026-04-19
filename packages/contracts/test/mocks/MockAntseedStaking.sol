// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal seller-unstake mock for AntseedStaking. Pays a configured
///      payout to msg.sender on unstake(). Tests seed the mock's USDC balance.
contract MockAntseedStaking {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdc;
    uint256 public configuredPayout;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function setPayout(uint256 amount) external { configuredPayout = amount; }

    function unstake() external {
        if (configuredPayout > 0) usdc.safeTransfer(msg.sender, configuredPayout);
    }
}
