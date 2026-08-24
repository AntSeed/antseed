// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedWashTradingStatus } from "./IAntseedWashTradingStatus.sol";

interface IAntseedWashTradingRegistry is IAntseedWashTradingStatus {
    function submit(bytes calldata publicValues, bytes calldata proofBytes) external;
}
