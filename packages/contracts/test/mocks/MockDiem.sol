// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Minimal replica of Venice's DIEM contract for Foundry tests.
 *      Matches the staking ABI the proxy relies on: stake / initiateUnstake /
 *      unstake / cooldownDuration. Cooldown is per msg.sender (the proxy).
 */
contract MockDiem is ERC20 {
    uint256 public cooldownDuration;

    struct StakedInfo {
        uint256 amountStaked;
        uint256 coolDownEnd;
        uint256 coolDownAmount;
    }
    mapping(address => StakedInfo) public stakedInfos;
    uint256 public totalStaked;

    constructor(uint256 _cooldownDuration) ERC20("Diem", "DIEM") {
        cooldownDuration = _cooldownDuration;
    }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function setCooldownDuration(uint256 _cd) external { cooldownDuration = _cd; }

    function stake(uint256 amount) external {
        require(amount > 0, "STAKE_ZERO");
        require(balanceOf(msg.sender) >= amount, "INSUFFICIENT_BALANCE");
        totalStaked += amount;
        stakedInfos[msg.sender].amountStaked += amount;
        _update(msg.sender, address(this), amount);
    }

    function initiateUnstake(uint256 amount) external {
        require(amount > 0, "UNSTAKE_ZERO");
        StakedInfo storage info = stakedInfos[msg.sender];
        require(info.amountStaked >= amount, "INSUFFICIENT_STAKED");
        info.coolDownEnd = block.timestamp + cooldownDuration;
        info.coolDownAmount += amount;
        info.amountStaked -= amount;
    }

    function unstake() external {
        StakedInfo storage info = stakedInfos[msg.sender];
        require(info.coolDownAmount > 0, "NO_COOLDOWN");
        require(block.timestamp >= info.coolDownEnd, "COOLDOWN_NOT_OVER");
        uint256 amount = info.coolDownAmount;
        totalStaked -= amount;
        info.coolDownAmount = 0;
        info.coolDownEnd = 0;
        _update(address(this), msg.sender, amount);
    }
}
