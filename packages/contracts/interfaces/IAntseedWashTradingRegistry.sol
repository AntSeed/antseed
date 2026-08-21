// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedP0Registry } from "./IAntseedP0Registry.sol";

interface IAntseedWashTradingRegistry is IAntseedP0Registry {
    function submitClosedCycleProof(bytes calldata seal, bytes calldata journalData) external returns (bool recorded);
    function submitReciprocalProof(bytes calldata seal, bytes calldata journalData)
        external
        returns (bool recordedA, bool recordedB);
}
