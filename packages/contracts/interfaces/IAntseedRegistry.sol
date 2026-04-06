// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Central registry for all AntSeed protocol contract addresses.
interface IAntseedRegistry {
    function channels() external view returns (address);
    function stats() external view returns (address);
    function deposits() external view returns (address);
    function staking() external view returns (address);
    function emissions() external view returns (address);
    function antsToken() external view returns (address);
    function identityRegistry() external view returns (address);
    function protocolReserve() external view returns (address);
    function teamWallet() external view returns (address);
}
