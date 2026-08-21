// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedWashTradingStatus } from "./IAntseedWashTradingStatus.sol";

interface IAntseedWashTradingRegistry is IAntseedWashTradingStatus {
    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData) external returns (bool recorded);
    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recordedA, bool recordedB);
}
