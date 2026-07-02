// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedRegistry } from "./IAntseedRegistry.sol";

/// @notice Registry v2: adds a dedicated destination for ANTS emission
///         reserve flows, separate from `protocolReserve` (USDC transaction
///         fees and slash proceeds).
interface IAntseedRegistryV2 is IAntseedRegistry {
    function emissionsReserve() external view returns (address);
}
