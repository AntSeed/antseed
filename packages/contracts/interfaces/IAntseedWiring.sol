// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared admin wiring interfaces used by Deploy.s.sol
interface ISetChannels {
    function setChannelsContract(address) external;
}

interface ISetEmissions {
    function setEmissionsContract(address) external;
}

interface ISetProtocolReserve {
    function setProtocolReserve(address) external;
}

