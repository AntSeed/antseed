// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBlockhashStore } from "../interfaces/IBlockhashStore.sol";

contract AntseedSparseBlockhashStore {
    struct Frontier {
        uint64 anchorBlock;
        uint64 nextHeaderBlock;
        bytes32 expectedHeaderHash;
    }

    struct CompleteHeaderBatch {
        uint64 anchorBlock;
        bytes[] descendingHeaders;
        bytes storeBitmap;
    }

    IBlockhashStore public immutable CHAINLINK_BLOCKHASH_STORE;

    mapping(uint256 blockNumber => bytes32 blockHash) public localBlockhash;
    mapping(bytes32 sessionId => Frontier frontier) public frontiers;

    error ZeroAddress();
    error ZeroSessionId();
    error EmptyBatch();
    error MissingAnchor(uint64 anchorBlock);
    error AnchorMismatch(uint64 expected, uint64 actual);
    error HeaderRangeUnderflow();
    error HeaderHashMismatch(uint64 blockNumber);
    error InvalidHeader();
    error InvalidStoreBitmap();
    error BlockhashConflict(uint64 blockNumber);

    event HeaderBatchVerified(
        bytes32 indexed sessionId,
        uint64 indexed anchorBlock,
        uint64 firstHeaderBlock,
        uint64 nextHeaderBlock,
        uint256 headerCount,
        uint256 storedBlockCount
    );
    event CompleteHeaderBatchVerified(
        uint64 indexed anchorBlock,
        uint64 firstHeaderBlock,
        uint64 nextHeaderBlock,
        uint256 headerCount,
        uint256 storedBlockCount
    );

    constructor(address chainlinkBlockhashStore_) {
        if (chainlinkBlockhashStore_ == address(0)) revert ZeroAddress();
        CHAINLINK_BLOCKHASH_STORE = IBlockhashStore(chainlinkBlockhashStore_);
    }

    function getBlockhash(uint256 blockNumber) external view returns (bytes32 blockHash) {
        blockHash = localBlockhash[blockNumber];
        if (blockHash == bytes32(0)) blockHash = CHAINLINK_BLOCKHASH_STORE.getBlockhash(blockNumber);
    }

    function verifyHeaderBatch(
        bytes32 sessionId,
        uint64 anchorBlock,
        bytes[] calldata descendingHeaders,
        bytes calldata storeBitmap
    ) external {
        if (sessionId == bytes32(0)) revert ZeroSessionId();
        uint256 headerCount = descendingHeaders.length;
        if (headerCount == 0) revert EmptyBatch();
        if (headerCount > anchorBlock) revert HeaderRangeUnderflow();
        _validateBitmap(storeBitmap, headerCount);

        Frontier memory frontier = frontiers[sessionId];
        if (frontier.expectedHeaderHash == bytes32(0)) {
            bytes32 anchorHash = CHAINLINK_BLOCKHASH_STORE.getBlockhash(anchorBlock);
            if (anchorHash == bytes32(0)) revert MissingAnchor(anchorBlock);
            frontier = Frontier(anchorBlock, anchorBlock, anchorHash);
        } else if (frontier.anchorBlock != anchorBlock) {
            revert AnchorMismatch(frontier.anchorBlock, anchorBlock);
        }
        if (headerCount > frontier.nextHeaderBlock) revert HeaderRangeUnderflow();

        uint64 firstHeaderBlock = frontier.nextHeaderBlock;
        (uint64 currentHeaderBlock, bytes32 expectedHeaderHash, uint256 storedBlockCount) =
            _verifyHeaders(firstHeaderBlock, frontier.expectedHeaderHash, descendingHeaders, storeBitmap);

        frontiers[sessionId] = Frontier(anchorBlock, currentHeaderBlock, expectedHeaderHash);
        emit HeaderBatchVerified(
            sessionId, anchorBlock, firstHeaderBlock, currentHeaderBlock, headerCount, storedBlockCount
        );
    }

    function verifyCompleteHeaderBatches(CompleteHeaderBatch[] calldata batches) external {
        if (batches.length == 0) revert EmptyBatch();
        for (uint256 batchIndex; batchIndex < batches.length; ++batchIndex) {
            CompleteHeaderBatch calldata batch = batches[batchIndex];
            uint256 headerCount = batch.descendingHeaders.length;
            if (headerCount == 0) revert EmptyBatch();
            if (headerCount > batch.anchorBlock) revert HeaderRangeUnderflow();
            _validateBitmap(batch.storeBitmap, headerCount);

            bytes32 anchorHash = CHAINLINK_BLOCKHASH_STORE.getBlockhash(batch.anchorBlock);
            if (anchorHash == bytes32(0)) revert MissingAnchor(batch.anchorBlock);
            (uint64 nextHeaderBlock,, uint256 storedBlockCount) =
                _verifyHeaders(batch.anchorBlock, anchorHash, batch.descendingHeaders, batch.storeBitmap);
            emit CompleteHeaderBatchVerified(
                batch.anchorBlock, batch.anchorBlock, nextHeaderBlock, headerCount, storedBlockCount
            );
        }
    }

    function _verifyHeaders(
        uint64 firstHeaderBlock,
        bytes32 firstExpectedHeaderHash,
        bytes[] calldata descendingHeaders,
        bytes calldata storeBitmap
    ) internal returns (uint64 currentHeaderBlock, bytes32 expectedHeaderHash, uint256 storedBlockCount) {
        currentHeaderBlock = firstHeaderBlock;
        expectedHeaderHash = firstExpectedHeaderHash;
        for (uint256 index; index < descendingHeaders.length; ++index) {
            bytes calldata header = descendingHeaders[index];
            if (keccak256(header) != expectedHeaderHash) revert HeaderHashMismatch(currentHeaderBlock);
            bytes32 parentHash = _parentHash(header);
            uint64 parentBlock = currentHeaderBlock - 1;
            if (_bitmapSet(storeBitmap, index)) {
                bytes32 existing = localBlockhash[parentBlock];
                if (existing != bytes32(0) && existing != parentHash) revert BlockhashConflict(parentBlock);
                if (existing == bytes32(0)) {
                    localBlockhash[parentBlock] = parentHash;
                    storedBlockCount += 1;
                }
            }
            currentHeaderBlock = parentBlock;
            expectedHeaderHash = parentHash;
        }
    }

    function _parentHash(bytes calldata header) internal pure returns (bytes32 parentHash) {
        if (header.length < 35) revert InvalidHeader();
        uint8 prefix = uint8(header[0]);
        uint256 payloadOffset;
        uint256 payloadLength;
        if (prefix >= 0xc0 && prefix <= 0xf7) {
            payloadOffset = 1;
            payloadLength = prefix - 0xc0;
        } else if (prefix >= 0xf8) {
            uint256 lengthOfLength = prefix - 0xf7;
            if (lengthOfLength > 4 || header.length <= lengthOfLength) revert InvalidHeader();
            payloadOffset = 1 + lengthOfLength;
            for (uint256 index; index < lengthOfLength; ++index) {
                payloadLength = (payloadLength << 8) | uint8(header[1 + index]);
            }
        } else {
            revert InvalidHeader();
        }
        if (payloadOffset + payloadLength != header.length || uint8(header[payloadOffset]) != 0xa0) {
            revert InvalidHeader();
        }
        assembly ("memory-safe") {
            parentHash := calldataload(add(header.offset, add(payloadOffset, 1)))
        }
    }

    function _validateBitmap(bytes calldata bitmap, uint256 headerCount) internal pure {
        uint256 expectedLength = (headerCount + 7) / 8;
        if (bitmap.length != expectedLength) revert InvalidStoreBitmap();
        uint256 remainder = headerCount % 8;
        if (remainder != 0 && uint8(bitmap[bitmap.length - 1]) >> remainder != 0) revert InvalidStoreBitmap();
    }

    function _bitmapSet(bytes calldata bitmap, uint256 index) internal pure returns (bool) {
        return uint8(bitmap[index >> 3]) & (uint8(1) << uint8(index & 7)) != 0;
    }
}
