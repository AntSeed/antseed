// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedDeposits {
    function lockForSession(address buyer, uint256 amount) external;
    function chargeAndCreditEarnings(
        address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
        uint256 platformFee, address protocolReserve
    ) external;
    function releaseLock(address buyer, uint256 amount) external;
    function uniqueSellersCharged(address buyer) external view returns (uint256);
}
