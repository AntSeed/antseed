// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissionsGate {
    function currentEpoch() external view returns (uint256);
    function effectiveEpoch() external view returns (uint256);
    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256);
    function emissionsReserve() external view returns (address);
    function claim(uint256 epoch, address recipient, uint256 amount) external;
    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        returns (uint256 burnedAmount, uint256 reserveAmount);
}
