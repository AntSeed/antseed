// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AntseedBaseCheckpointOracle is IBaseAnalysisStateOracle {
    uint64 public constant BASE_CHAIN_ID = 8_453;
    uint64 public constant HISTORICAL_START_BLOCK = 44_469_557;
    uint64 public constant REQUIRED_COVERAGE_END_BLOCK = 49_936_172;
    uint32 public constant EPOCH_SIZE = 16_384;
    uint8 public constant EPOCH_TREE_DEPTH = 14;
    uint64 public constant EIP2935_WINDOW = 8_191;
    uint32 public constant JOURNAL_VERSION = 3;
    address public constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;

    struct AccumulatorJournal {
        uint32 version;
        uint64 chainId;
        bytes32 epochRecursionVKey;
        uint64 startBlockNumber;
        uint64 endBlockNumber;
        uint64 anchorBlockNumber;
        bytes32 anchorBlockHash;
        uint64 blockCount;
        uint32 epochSize;
        uint32 epochCount;
        bytes32 mmrRoot;
    }

    struct HistoricalBlockProof {
        uint64 blockNumber;
        bytes32 blockHash;
        bytes32[EPOCH_TREE_DEPTH] blockSiblings;
        bytes32 epochFirstParentHash;
        bytes32 epochEndBlockHash;
        bytes32[] mountainSiblings;
        bytes32[] peaks;
        uint32 targetPeakIndex;
    }

    ISP1Verifier public immutable verifier;
    bytes32 public immutable epochRecursionVKey;
    bytes32 public immutable accumulatorProgramVKey;

    mapping(uint64 blockNumber => bytes32 blockHash) public canonicalBlockHashes;
    bool public override historicalCoverageComplete;
    uint64 public historicalEndBlock;
    uint32 public historicalEpochCount;
    bytes32 public historicalMmrRoot;
    bytes32 public historicalJournalDigest;

    error ZeroAddress();
    error NoCode(address target);
    error ZeroProgramVKey();
    error WrongChain(uint256 chainId);
    error HistoricalAccumulatorAlreadySubmitted();
    error InvalidAccumulatorJournal();
    error InvalidAnchor(uint64 blockNumber, bytes32 expected, bytes32 actual);
    error InvalidHistoricalBlockProof(uint64 blockNumber);
    error ConflictingBlockHash(uint64 blockNumber, bytes32 existingHash, bytes32 newHash);

    event HistoricalAccumulatorAccepted(
        bytes32 indexed journalDigest,
        uint64 indexed anchorBlockNumber,
        bytes32 indexed anchorBlockHash,
        uint32 epochCount,
        bytes32 mmrRoot
    );
    event HistoricalBlockMaterialized(uint64 indexed blockNumber, bytes32 indexed blockHash, uint32 indexed epochIndex);

    constructor(address verifier_, bytes32 epochRecursionVKey_, bytes32 accumulatorProgramVKey_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (verifier_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NoCode(verifier_);
        if (epochRecursionVKey_ == bytes32(0) || accumulatorProgramVKey_ == bytes32(0)) {
            revert ZeroProgramVKey();
        }
        verifier = ISP1Verifier(verifier_);
        epochRecursionVKey = epochRecursionVKey_;
        accumulatorProgramVKey = accumulatorProgramVKey_;
    }

    function submitHistoricalAccumulator(bytes calldata proofBytes, bytes calldata publicValues) external {
        if (historicalCoverageComplete) revert HistoricalAccumulatorAlreadySubmitted();
        bytes32 journalDigest = sha256(publicValues);
        verifier.verifyProof(accumulatorProgramVKey, publicValues, proofBytes);
        AccumulatorJournal memory journal = abi.decode(publicValues, (AccumulatorJournal));
        _validateJournal(journal);
        bytes32 canonicalAnchor = _historyStorageHash(journal.anchorBlockNumber);
        if (canonicalAnchor != journal.anchorBlockHash) {
            revert InvalidAnchor(journal.anchorBlockNumber, journal.anchorBlockHash, canonicalAnchor);
        }

        historicalEndBlock = journal.endBlockNumber;
        historicalEpochCount = journal.epochCount;
        historicalMmrRoot = journal.mmrRoot;
        historicalJournalDigest = journalDigest;
        historicalCoverageComplete = true;
        canonicalBlockHashes[journal.anchorBlockNumber] = journal.anchorBlockHash;
        emit HistoricalAccumulatorAccepted(
            journalDigest, journal.anchorBlockNumber, journal.anchorBlockHash, journal.epochCount, journal.mmrRoot
        );
    }

    function materializeHistoricalBlocks(HistoricalBlockProof[] calldata proofs) external returns (uint256 stored) {
        if (!historicalCoverageComplete) revert InvalidAccumulatorJournal();
        for (uint256 proofIndex = 0; proofIndex < proofs.length; ++proofIndex) {
            HistoricalBlockProof calldata proof = proofs[proofIndex];
            if (
                proof.blockNumber < HISTORICAL_START_BLOCK || proof.blockNumber > historicalEndBlock
                    || proof.blockHash == bytes32(0) || proof.epochFirstParentHash == bytes32(0)
                    || proof.epochEndBlockHash == bytes32(0)
            ) revert InvalidHistoricalBlockProof(proof.blockNumber);

            uint32 epochIndex = uint32((proof.blockNumber - HISTORICAL_START_BLOCK) / EPOCH_SIZE);
            uint64 epochStart = HISTORICAL_START_BLOCK + uint64(epochIndex) * EPOCH_SIZE;
            uint64 epochEnd = epochStart + EPOCH_SIZE - 1;
            bytes32 blockRoot = _blockRoot(proof, epochStart);
            bytes32 epochLeaf = keccak256(
                abi.encodePacked(
                    bytes1(0x10),
                    BASE_CHAIN_ID,
                    epochIndex,
                    epochStart,
                    epochEnd,
                    proof.epochFirstParentHash,
                    proof.epochEndBlockHash,
                    blockRoot
                )
            );
            if (!_verifyMmr(epochIndex, epochLeaf, proof)) revert InvalidHistoricalBlockProof(proof.blockNumber);

            bytes32 existing = canonicalBlockHashes[proof.blockNumber];
            if (existing != bytes32(0) && existing != proof.blockHash) {
                revert ConflictingBlockHash(proof.blockNumber, existing, proof.blockHash);
            }
            if (existing == bytes32(0)) {
                canonicalBlockHashes[proof.blockNumber] = proof.blockHash;
                ++stored;
                emit HistoricalBlockMaterialized(proof.blockNumber, proof.blockHash, epochIndex);
            }
        }
    }

    function isCanonicalBlock(uint64 blockNumber, bytes32 blockHash) external view returns (bool) {
        return blockHash != bytes32(0) && canonicalBlockHashes[blockNumber] == blockHash;
    }

    function _validateJournal(AccumulatorJournal memory journal) private view {
        uint256 expectedBlocks = uint256(journal.epochCount) * EPOCH_SIZE;
        if (
            journal.version != JOURNAL_VERSION || journal.chainId != BASE_CHAIN_ID
                || journal.epochRecursionVKey != epochRecursionVKey || journal.startBlockNumber != HISTORICAL_START_BLOCK
                || journal.epochSize != EPOCH_SIZE || journal.epochCount == 0 || journal.blockCount != expectedBlocks
                || journal.endBlockNumber != HISTORICAL_START_BLOCK + expectedBlocks - 1
                || journal.endBlockNumber < REQUIRED_COVERAGE_END_BLOCK
                || journal.anchorBlockNumber != journal.endBlockNumber || journal.anchorBlockHash == bytes32(0)
                || journal.mmrRoot == bytes32(0) || journal.anchorBlockNumber >= block.number
                || block.number - journal.anchorBlockNumber > EIP2935_WINDOW
        ) revert InvalidAccumulatorJournal();
    }

    function _historyStorageHash(uint64 blockNumber) private view returns (bytes32 blockHash) {
        (bool success, bytes memory result) = HISTORY_STORAGE.staticcall(abi.encode(uint256(blockNumber)));
        if (!success || result.length != 32) return bytes32(0);
        blockHash = abi.decode(result, (bytes32));
    }

    function _blockRoot(HistoricalBlockProof calldata proof, uint64 epochStart)
        private
        pure
        returns (bytes32 current)
    {
        current = keccak256(abi.encodePacked(bytes1(0x00), proof.blockNumber, proof.blockHash));
        uint256 position = proof.blockNumber - epochStart;
        for (uint256 level = 0; level < EPOCH_TREE_DEPTH; ++level) {
            bytes32 sibling = proof.blockSiblings[level];
            current = position & 1 == 0
                ? keccak256(abi.encodePacked(bytes1(0x02), current, sibling))
                : keccak256(abi.encodePacked(bytes1(0x02), sibling, current));
            position >>= 1;
        }
    }

    function _verifyMmr(uint32 epochIndex, bytes32 leaf, HistoricalBlockProof calldata proof)
        private
        view
        returns (bool)
    {
        (uint32 peakIndex, uint32 mountainStart, uint32 mountainSize, uint32 peakCount) =
            _mountainFor(historicalEpochCount, epochIndex);
        if (
            proof.targetPeakIndex != peakIndex || proof.peaks.length != peakCount
                || proof.mountainSiblings.length != _log2(mountainSize)
        ) return false;

        uint256 position = epochIndex - mountainStart;
        bytes32 current = leaf;
        for (uint256 level = 0; level < proof.mountainSiblings.length; ++level) {
            bytes32 sibling = proof.mountainSiblings[level];
            current = position & 1 == 0
                ? keccak256(abi.encodePacked(bytes1(0x11), uint8(level + 1), current, sibling))
                : keccak256(abi.encodePacked(bytes1(0x11), uint8(level + 1), sibling, current));
            position >>= 1;
        }
        if (proof.peaks[peakIndex] != current) return false;
        return keccak256(abi.encodePacked(bytes1(0x12), historicalEpochCount, proof.peaks)) == historicalMmrRoot;
    }

    function _mountainFor(uint32 count, uint32 target)
        private
        pure
        returns (uint32 peakIndex, uint32 mountainStart, uint32 mountainSize, uint32 peakCount)
    {
        uint32 remaining = count;
        while (remaining != 0) {
            uint32 size = _highestPowerOfTwo(remaining);
            if (target >= mountainStart && target < mountainStart + size && mountainSize == 0) {
                mountainSize = size;
                peakIndex = peakCount;
            }
            mountainStart += size;
            remaining -= size;
            ++peakCount;
        }
        if (mountainSize == 0) return (type(uint32).max, 0, 0, peakCount);
        mountainStart -= mountainSize;
        uint32 priorSize;
        for (uint32 index = 0; index < peakIndex; ++index) {
            uint32 size = _highestPowerOfTwo(count - priorSize);
            priorSize += size;
        }
        mountainStart = priorSize;
    }

    function _highestPowerOfTwo(uint32 value) private pure returns (uint32 result) {
        result = 1;
        while (result <= value / 2) result <<= 1;
    }

    function _log2(uint32 value) private pure returns (uint256 result) {
        while (value > 1) {
            value >>= 1;
            ++result;
        }
    }
}
