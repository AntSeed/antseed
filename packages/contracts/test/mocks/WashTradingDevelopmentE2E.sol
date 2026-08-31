// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISP1Verifier } from "../../interfaces/ISP1Verifier.sol";

contract WashTradingDevelopmentVerifier is ISP1Verifier {
    bytes32 public immutable expectedDigest;

    constructor(bytes32 programVKey, bytes32 publicValuesDigest, bytes32 proofDigest) {
        expectedDigest = keccak256(abi.encode(programVKey, publicValuesDigest, proofDigest));
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        require(
            keccak256(abi.encode(programVKey, keccak256(publicValues), keccak256(proofBytes))) == expectedDigest,
            "unexpected development proof"
        );
    }
}
