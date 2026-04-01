// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared admin wiring interface used by Deploy.s.sol
interface ISetRegistry {
    function setRegistry(address) external;
}
