// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC3009
 * @notice Minimal EIP-3009 surface used by AntseedDepositRelay.
 *         Circle's FiatToken (USDC) implements this natively; the bytes-signature
 *         overload is present in FiatTokenV2_2 (deployed on Base).
 */
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}
