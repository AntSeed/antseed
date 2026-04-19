// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal external surface consumed by off-chain buyers resolving
///         the peer→seller binding and surfacing reward balances.
interface IDiemStakingProxy {
    /// @notice Mapping getter from AntseedSellerDelegation. Returns true if
    ///         `account` is an authorized operator for this seller facade.
    function isOperator(address account) external view returns (bool);

    /// @notice Accrued (unclaimed) USDC and ANTS rewards for `account`.
    function earned(address account) external view returns (uint256 usdcEarned, uint256 antsEarned);
}
