// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../../interfaces/IBaseAnalysisStateOracle.sol";
import { IRiscZeroVerifier } from "../../interfaces/IRiscZeroVerifier.sol";

contract LocalProofE2EVerifier is IRiscZeroVerifier {
    bytes32 public expectedImageId;
    bytes32 public expectedJournalDigest;

    function expect(bytes32 imageId, bytes32 journalDigest) external {
        expectedImageId = imageId;
        expectedJournalDigest = journalDigest;
    }

    function verify(bytes calldata, bytes32 imageId, bytes32 journalDigest) external view {
        require(imageId == expectedImageId, "wrong image");
        require(journalDigest == expectedJournalDigest, "wrong journal");
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
