// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSlashing {
    function calculateSlash(address seller, uint256 stakeAmount) external view returns (uint256);
}
