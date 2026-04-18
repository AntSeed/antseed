// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal mock implementing `claimSellerEmissions(uint256[])`.
contract MockAntseedEmissions {
    using SafeERC20 for IERC20;
    IERC20 public immutable ants;
    uint256 public configuredPayout;

    constructor(address _ants) {
        ants = IERC20(_ants);
    }

    function setPayout(uint256 amount) external { configuredPayout = amount; }

    function claimSellerEmissions(uint256[] calldata) external {
        if (configuredPayout > 0) ants.safeTransfer(msg.sender, configuredPayout);
    }
}
