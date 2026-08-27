// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedVerificationStatus {
    function agentPointsPenaltyBps(uint256 agentId) external view returns (uint16);
}
