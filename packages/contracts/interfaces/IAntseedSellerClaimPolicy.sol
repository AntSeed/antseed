// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSellerClaimPolicy {
    function retainedSellerRewardsBps(address seller) external view returns (uint16 retainedBps);
}
