// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    /// @notice True when a proven funding loop links `buyer` to `seller`.
    function isFlagged(address buyer, address seller) external view returns (bool);

    /// @notice True when at least one proven funding loop exists for `seller`.
    ///         Permanent: findings cannot be removed.
    function isSellerFlagged(address seller) external view returns (bool);
}
