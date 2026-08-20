// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData) external returns (bool applied);
    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool appliedA, bool appliedB);
    function submitCoordinatedControlProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool applied);

    function sellerPenaltyBps(address seller) external view returns (uint16);
    function buyerPenaltyBps(address buyer) external view returns (uint16);
    function sellerProofTypeMask(address seller) external view returns (uint8);
    function isSellerP0(address seller) external view returns (bool);
    function isSellerPenalized(address seller) external view returns (bool);
    function isBuyerPenalized(address buyer) external view returns (bool);
}
