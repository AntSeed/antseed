// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";

contract AntseedBlockhashStoreBatcher {
    IBlockhashStore public immutable blockhashStore;

    error ZeroAddress();
    error LengthMismatch();
    error EmptyBatch();
    error BlockNumbersNotStrictlyDescending();

    constructor(address blockhashStore_) {
        if (blockhashStore_ == address(0)) revert ZeroAddress();
        blockhashStore = IBlockhashStore(blockhashStore_);
    }

    function storeVerifyHeaders(uint256[] calldata blockNumbers, bytes[] calldata headers) external {
        if (blockNumbers.length == 0) revert EmptyBatch();
        if (blockNumbers.length != headers.length) revert LengthMismatch();

        uint256 previous = type(uint256).max;
        for (uint256 index; index < blockNumbers.length; ++index) {
            uint256 blockNumber = blockNumbers[index];
            if (blockNumber >= previous) revert BlockNumbersNotStrictlyDescending();
            blockhashStore.storeVerifyHeader(blockNumber, headers[index]);
            previous = blockNumber;
        }
    }
}
