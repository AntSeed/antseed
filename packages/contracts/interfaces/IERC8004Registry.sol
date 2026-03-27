// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC8004Registry
 * @notice Minimal interface for the deployed ERC-8004 IdentityRegistry.
 *         Only the functions AntSeed contracts need to call.
 */
interface IERC8004Registry {
    function ownerOf(uint256 agentId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);
}
