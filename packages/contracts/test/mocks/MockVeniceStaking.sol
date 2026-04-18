// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVeniceStaking} from "../../interfaces/IVeniceStaking.sol";

/// @dev Minimal mock: holds DIEM 1:1, immediate unstake returns DIEM to caller.
contract MockVeniceStaking is IVeniceStaking {
    using SafeERC20 for IERC20;
    IERC20 public immutable diem;
    mapping(address => uint256) public staked;

    constructor(address _diem) {
        diem = IERC20(_diem);
    }

    function stake(uint256 amount) external {
        staked[msg.sender] += amount;
        diem.safeTransferFrom(msg.sender, address(this), amount);
    }

    function unstake(uint256 amount) external {
        staked[msg.sender] -= amount;
        diem.safeTransfer(msg.sender, amount);
    }
}
