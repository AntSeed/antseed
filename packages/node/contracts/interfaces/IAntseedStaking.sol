// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedStaking {
    function validateSeller(address seller) external view returns (uint256 tokenRate);
    function getStake(address seller) external view returns (uint256);
    function getTokenRate(address seller) external view returns (uint256);
    function isStakedAboveMin(address seller) external view returns (bool);
    function incrementActiveSessions(address seller) external;
    function decrementActiveSessions(address seller) external;
}
