// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal external surface consumed by off-chain buyers resolving
///         the peer→seller binding and surfacing reward balances.
interface IDiemStakingProxy {
    /// @notice Mapping getter from AntseedSellerDelegation. Returns true if
    ///         `account` is an authorized operator for this seller facade.
    function isOperator(address account) external view returns (bool);

    /// @notice Accrued (unclaimed) USDC rewards for `account`, callable by
    ///         external tools without needing to loop over reward epochs.
    ///         ANTS is intentionally excluded here: the proxy tracks it
    ///         per-reward-epoch via `pendingAntsForEpoch(address, uint32)`,
    ///         which doesn't fit a single scalar return.
    function earnedUsdc(address account) external view returns (uint256);
}
