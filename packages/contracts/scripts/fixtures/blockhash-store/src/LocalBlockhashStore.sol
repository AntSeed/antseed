pragma solidity ^0.8.24;

contract LocalBlockhashStore {
    mapping(uint256 => bytes32) internal blockhashes;

    function store(uint256 blockNumber) external {
        bytes32 blockHash = blockhash(blockNumber);
        require(blockHash != bytes32(0), "blockhash(n) failed");
        blockhashes[blockNumber] = blockHash;
    }

    function storeVerifyHeader(uint256 blockNumber, bytes memory header) external {
        require(keccak256(header) == blockhashes[blockNumber + 1], "header has unknown blockhash");

        bytes32 parentHash;
        assembly {
            parentHash := mload(add(header, 36))
        }
        blockhashes[blockNumber] = parentHash;
    }

    function getBlockhash(uint256 blockNumber) external view returns (bytes32) {
        bytes32 blockHash = blockhashes[blockNumber];
        require(blockHash != bytes32(0), "blockhash not found in store");
        return blockHash;
    }
}
