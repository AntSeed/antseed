// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissions {
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
}
