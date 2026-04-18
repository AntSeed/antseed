// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVeniceStaking {
    function stake(uint256 amount) external;
    function unstake(uint256 amount) external;
}
