// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    function submitHistoricalAggregate(bytes calldata publicValues, bytes calldata proofBytes) external;

    function historicalResultSubmitted() external view returns (bool);
    function aggregatorProgramVKey() external view returns (bytes32);
    function reportRoot() external view returns (bytes32);
    function manifestDigest() external view returns (bytes32);
    function periodStartBlock() external view returns (uint64);
    function periodEndBlock() external view returns (uint64);
    function expectedSourceClaimCount() external view returns (uint32);
    function expectedSellerCount() external view returns (uint32);
    function expectedTotalProvenWashVolume() external view returns (uint128);
    function totalProvenWashVolume() external view returns (uint128);
    function blockReferenceCount() external view returns (uint32);
    function provenWashVolume(address seller) external view returns (uint128);
    function isProvenWashTrader(address seller) external view returns (bool);
}
