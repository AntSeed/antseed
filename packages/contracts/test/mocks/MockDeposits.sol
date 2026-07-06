// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal AntseedDeposits stand-in: just the buyer → operator
///         binding consumed by delegate voucher claims.
contract MockDeposits {
    mapping(address buyer => address operator) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}
