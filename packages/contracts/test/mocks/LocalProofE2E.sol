// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISP1Verifier } from "../../interfaces/ISP1Verifier.sol";

contract LocalProofE2EVerifier is ISP1Verifier {
    mapping(bytes32 expectation => bool allowed) public expected;

    function expect(bytes32 programVKey, bytes32 publicValuesDigest) external {
        expected[keccak256(abi.encode(programVKey, publicValuesDigest))] = true;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata) external view {
        require(expected[keccak256(abi.encode(programVKey, sha256(publicValues)))], "unexpected proof");
    }
}

contract LocalProofE2EBlockhashStore {
    mapping(uint256 blockNumber => bytes32 blockHash) public getBlockhash;

    function setCanonical(uint64 blockNumber, bytes32 blockHash) external {
        getBlockhash[blockNumber] = blockHash;
    }

    function store(uint256) external { }
    function storeVerifyHeader(uint256, bytes calldata) external { }
}
