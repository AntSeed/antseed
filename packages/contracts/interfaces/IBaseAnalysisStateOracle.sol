// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Authenticates historical Base block hashes from finalized commitments.
interface IBaseAnalysisStateOracle {
    function isCanonicalBlock(uint64 blockNumber, bytes32 blockHash) external view returns (bool);

    function historicalCoverageComplete() external view returns (bool);
}
