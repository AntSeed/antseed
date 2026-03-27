// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedStaking {
    function validateSeller(address seller) external view returns (bool);
    function getStake(address seller) external view returns (uint256);
    function isStakedAboveMin(address seller) external view returns (bool);
    function stakeFor(address seller, uint256 agentId, uint256 amount) external;
    function incrementActiveSessions(address seller) external;
    function decrementActiveSessions(address seller) external;
    function getAgentId(address seller) external view returns (uint256);
}
