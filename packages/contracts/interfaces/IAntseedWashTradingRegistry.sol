// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    /// @notice Future seller-reward reduction proven for `seller`, in BPS.
    function sellerPenaltyBps(address seller) external view returns (uint16);

    /// @notice True after one valid seller-penalty proof has been accepted.
    function isSellerPenalized(address seller) external view returns (bool);
}
