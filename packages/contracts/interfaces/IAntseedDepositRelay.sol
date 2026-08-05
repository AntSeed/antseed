// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedDepositRelay {
    function sweepDeposit(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig3009
    ) external;

    function usdc() external view returns (address);
    function deposits() external view returns (address);
    function FEE() external view returns (uint256);
}
