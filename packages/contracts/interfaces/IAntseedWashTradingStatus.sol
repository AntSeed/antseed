// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingStatus {
    function isSellerWashTradingFlagged(address seller) external view returns (bool);
}
