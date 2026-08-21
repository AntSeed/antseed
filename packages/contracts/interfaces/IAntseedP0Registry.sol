// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedP0Registry {
    function isSellerP0(address seller) external view returns (bool);
}
