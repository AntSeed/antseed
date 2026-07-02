// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedRegistry } from "./AntseedRegistry.sol";
import { IAntseedRegistryV2 } from "../interfaces/IAntseedRegistryV2.sol";

/**
 * @title AntseedRegistryV2
 * @notice Address book for the recognized-usage stack. The originally
 *         deployed AntseedRegistry stays in place as the legacy registry for
 *         already-deployed contracts (Channels, Deposits, Staking, seller
 *         delegation proxies); new contracts point here instead.
 *
 *         v2 adds `emissionsReserve`: the destination for ANTS emission
 *         reserve flows (reserve bucket, reward-cap overflow, epoch
 *         remainders). `protocolReserve` keeps its original meaning — USDC
 *         transaction fees and slash proceeds. While `emissionsReserve` is
 *         unset, emission flows fall back to `protocolReserve`.
 */
contract AntseedRegistryV2 is AntseedRegistry, IAntseedRegistryV2 {
    address public override emissionsReserve;

    /// @dev Zero is allowed: it clears the split and emission reserve flows
    ///      fall back to `protocolReserve`.
    function setEmissionsReserve(address _emissionsReserve) external onlyOwner {
        emissionsReserve = _emissionsReserve;
        emit AddressUpdated("emissionsReserve", _emissionsReserve);
    }
}
