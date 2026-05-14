// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSellerClaimPolicy {
    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount);
}
