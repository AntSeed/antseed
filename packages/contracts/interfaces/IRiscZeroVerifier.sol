// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface of the RISC Zero receipt verifier
///         (router or pinned Groth16 verifier). Reverts when the seal does
///         not prove that the program identified by `imageId` committed the
///         journal whose SHA-256 digest is `journalDigest`.
interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}
