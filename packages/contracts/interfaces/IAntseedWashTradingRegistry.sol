// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData) external returns (bool recorded);
    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recordedA, bool recordedB);

    function sellerProofTypeMask(address seller) external view returns (uint8);
    function isSellerP0(address seller) external view returns (bool);
}
