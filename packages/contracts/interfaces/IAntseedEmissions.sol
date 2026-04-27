// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissions {
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
    function claimSellerEmissions(uint256[] calldata epochs) external;
    function pendingEmissions(address account, uint256[] calldata epochs)
        external
        view
        returns (uint256 totalSeller, uint256 totalBuyer);
    function currentEpoch() external view returns (uint256);
}
