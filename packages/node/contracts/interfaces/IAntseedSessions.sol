// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSessions {
    function reserve(
        address buyer,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function settle(
        bytes32 sessionId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens,
        uint256 nonce,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function settleTimeout(bytes32 sessionId) external;
}
