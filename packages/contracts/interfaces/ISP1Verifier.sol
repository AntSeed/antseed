// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SP1 verifier gateway interface used by the wash-trading registry.
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
