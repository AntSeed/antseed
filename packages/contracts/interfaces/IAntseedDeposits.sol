// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedDeposits {
    function lockForChannel(address buyer, uint256 amount) external;
    function chargeAndCreditPayouts(
        address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
        uint256 platformFee, address protocolReserve
    ) external;
    function releaseLock(address buyer, uint256 amount) external;
    function setOperatorFor(address buyer, address operator) external;
    function getOperator(address buyer) external view returns (address);
    function getOperatorNonce(address buyer) external view returns (uint256);
    function uniqueSellersCharged(address buyer) external view returns (uint256);
    function withdraw(address buyer, uint256 amount) external;
}
