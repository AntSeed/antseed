// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedWashTradingStatus } from "./IAntseedWashTradingStatus.sol";

interface IAntseedWashTradingRegistry is IAntseedWashTradingStatus {
    function submit(bytes calldata publicValues, bytes calldata proofBytes) external;

    function submitBatch(bytes[] calldata publicValues, bytes[] calldata proofBytes) external;

    function claimJournalDigest(bytes32 claimId) external view returns (bytes32);
}
