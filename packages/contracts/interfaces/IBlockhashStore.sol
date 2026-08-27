// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBlockhashStore {
    function getBlockhash(uint256 blockNumber) external view returns (bytes32);

    function store(uint256 blockNumber) external;

    function storeVerifyHeader(uint256 blockNumber, bytes calldata header) external;
}
