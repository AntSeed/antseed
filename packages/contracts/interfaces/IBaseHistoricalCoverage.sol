// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBaseHistoricalCoverage {
    function historicalCoverageComplete() external view returns (bool);
}
