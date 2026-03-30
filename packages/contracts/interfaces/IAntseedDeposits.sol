// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedDeposits {
    function lockForSession(address buyer, uint256 amount) external;
    function chargeAndCreditEarnings(
        address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
        uint256 platformFee, address protocolReserve
    ) external;
    function releaseLock(address buyer, uint256 amount) external;
    function transferToSessions(address buyer, address to, uint256 amount) external;
    function creditEarnings(address seller, uint256 amount) external;
    function creditBuyerRefund(address buyer, uint256 creditBack) external;
    function uniqueSellersCharged(address buyer) external view returns (uint256);
    function requestWithdrawal(address buyer, uint256 amount) external;
    function executeWithdrawal(address buyer) external;
    function cancelWithdrawal(address buyer) external;
}
