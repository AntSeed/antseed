// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../../interfaces/IBaseAnalysisStateOracle.sol";
import { ISP1Verifier } from "../../interfaces/ISP1Verifier.sol";

contract LocalProofE2EVerifier is ISP1Verifier {
    bytes32 public expectedProgramVKey;
    bytes32 public expectedPublicValuesDigest;

    function expect(bytes32 programVKey, bytes32 publicValuesDigest) external {
        expectedProgramVKey = programVKey;
        expectedPublicValuesDigest = publicValuesDigest;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata) external view {
        require(programVKey == expectedProgramVKey, "wrong program vkey");
        require(sha256(publicValues) == expectedPublicValuesDigest, "wrong public values");
    }
}

contract LocalProofE2EStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 blockNumber => bytes32 blockHash) public canonicalBlockHashes;
    bool public historicalCoverageComplete;

    function setCanonical(uint64 blockNumber, bytes32 blockHash) external {
        canonicalBlockHashes[blockNumber] = blockHash;
    }

    function setHistoricalCoverageComplete() external {
        historicalCoverageComplete = true;
    }

    function isCanonicalBlock(uint64 blockNumber, bytes32 blockHash) external view returns (bool) {
        return canonicalBlockHashes[blockNumber] == blockHash;
    }
}
