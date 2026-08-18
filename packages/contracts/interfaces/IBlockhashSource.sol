// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Source of canonical block hashes. Returns bytes32(0) when the
///         hash for `number` is unknown.
interface IBlockhashSource {
    function blockHash(uint256 number) external view returns (bytes32);
}
