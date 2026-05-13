// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSellerUnlockPolicy {
    function canClaimSellerUnlocked(address seller) external view returns (bool);
}
