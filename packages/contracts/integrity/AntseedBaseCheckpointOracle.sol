// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

/**
 * @title AntseedBaseCheckpointOracle
 * @notice Stores Base block hashes proven to descend from an AggregateVerifier
 *         output root accepted by Base's Ethereum AnchorStateRegistry.
 *
 * The RISC Zero guest authenticates Ethereum state with Steel and proves the
 * short Base header chain. This contract authenticates Steel's beacon-root
 * commitment through Base's EIP-4788 predeploy before storing exact hashes.
 */
contract AntseedBaseCheckpointOracle is IBaseAnalysisStateOracle {
    uint64 public constant BASE_CHAIN_ID = 8_453;
    uint64 public constant INTERMEDIATE_BLOCK_INTERVAL = 30;
    uint64 public constant AGGREGATE_VERIFIER_START_BLOCK = 46_302_960;
    uint64 public constant HISTORICAL_START_BLOCK = 44_469_557;
    uint64 public constant HISTORICAL_ANCHOR_BLOCK = 46_302_990;
    uint32 public constant HISTORICAL_CHUNK_SIZE = 16_384;
    uint16 public constant HISTORICAL_CHUNK_COUNT = 112;
    uint8 public constant HISTORICAL_TREE_DEPTH = 14;
    uint32 public constant HISTORICAL_JOURNAL_VERSION = 1;
    uint16 public constant BEACON_COMMITMENT_VERSION = 1;
    bytes32 public constant ETHEREUM_MAINNET_CONFIG_ID =
        0x47dc59f84afd2e9e7a48c4012004ab7c77fbd9acf822bf1143b8442c6c8851d4;
    address public constant ANCHOR_STATE_REGISTRY = 0x909f6cf47ed12f010A796527f562bFc26C7F4E72;
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    struct SteelCommitment {
        uint256 id;
        bytes32 digest;
        bytes32 configID;
    }

    struct CanonicalBlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    struct CheckpointJournal {
        SteelCommitment ethereumCommitment;
        uint64 chainId;
        address anchorStateRegistry;
        address game;
        uint8 intermediateRootIndex;
        uint64 checkpointBlockNumber;
        bytes32 checkpointBlockHash;
        bytes32 outputRoot;
        CanonicalBlockRef[] canonicalBlocks;
    }

    struct HistoricalChunkJournal {
        uint32 version;
        uint64 chainId;
        uint64 startBlockNumber;
        uint64 endBlockNumber;
        uint64 successorBlockNumber;
        bytes32 startBlockHash;
        bytes32 endBlockHash;
        bytes32 successorBlockHash;
        uint32 blockCount;
        bytes32 blockRoot;
    }

    struct HistoricalBlockProof {
        uint64 blockNumber;
        bytes32 blockHash;
        bytes32[HISTORICAL_TREE_DEPTH] siblings;
    }

    IRiscZeroVerifier public immutable verifier;
    bytes32 public immutable checkpointImageId;
    bytes32 public immutable historicalChunkImageId;

    mapping(uint64 blockNumber => bytes32 blockHash) public canonicalBlockHashes;
    mapping(uint256 ethereumTimestamp => bytes32 beaconRoot) public archivedBeaconRoots;
    mapping(bytes32 journalDigest => bool consumed) public consumedJournalDigests;
    mapping(uint16 chunkIndex => bytes32 blockRoot) public historicalChunkRoots;

    bool public historicalBackfillStarted;
    bool public historicalCoverageComplete;
    uint16 public acceptedHistoricalChunkCount;
    uint64 public historicalFrontierBlockNumber;
    bytes32 public historicalFrontierBlockHash;

    error ZeroAddress();
    error NoCode(address target);
    error ZeroImageId();
    error WrongChain(uint256 chainId);
    error InvalidCheckpointJournal();
    error InvalidSteelCommitment();
    error HistoricalBackfillAlreadyStarted();
    error HistoricalBackfillNotStarted();
    error HistoricalBackfillComplete();
    error HistoricalAnchorUnavailable();
    error InvalidHistoricalChunkJournal();
    error HistoricalJournalAlreadyConsumed(bytes32 journalDigest);
    error InvalidHistoricalBlockProof(uint64 blockNumber);
    error BeaconRootUnavailable(uint256 timestamp);
    error ConflictingBeaconRoot(uint256 timestamp, bytes32 existingRoot, bytes32 newRoot);
    error ConflictingBlockHash(uint64 blockNumber, bytes32 existingHash, bytes32 newHash);

    event BeaconRootArchived(uint256 indexed ethereumTimestamp, bytes32 indexed beaconRoot);
    event CheckpointAccepted(
        bytes32 indexed journalDigest,
        address indexed game,
        uint64 indexed checkpointBlockNumber,
        bytes32 checkpointBlockHash,
        uint256 canonicalBlockCount
    );
    event HistoricalBackfillStarted(uint64 indexed anchorBlockNumber, bytes32 indexed anchorBlockHash);
    event HistoricalChunkAccepted(
        bytes32 indexed journalDigest,
        uint16 indexed chunkIndex,
        uint64 indexed startBlockNumber,
        uint64 endBlockNumber,
        bytes32 blockRoot
    );
    event HistoricalBlockMaterialized(uint64 indexed blockNumber, bytes32 indexed blockHash, uint16 indexed chunkIndex);

    constructor(address verifier_, bytes32 checkpointImageId_, bytes32 historicalChunkImageId_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (verifier_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NoCode(verifier_);
        if (checkpointImageId_ == bytes32(0) || historicalChunkImageId_ == bytes32(0)) revert ZeroImageId();
        verifier = IRiscZeroVerifier(verifier_);
        checkpointImageId = checkpointImageId_;
        historicalChunkImageId = historicalChunkImageId_;
    }

    /**
     * @notice Archives a recent Ethereum beacon root exposed on Base.
     * @dev Permissionless and trustless. Call within Base's EIP-4788 retention
     *      window so later checkpoint proofs can reference the same root.
     */
    function archiveBeaconRoot(uint256 ethereumTimestamp) external returns (bytes32 beaconRoot) {
        beaconRoot = _liveBeaconRoot(ethereumTimestamp);
        bytes32 existing = archivedBeaconRoots[ethereumTimestamp];
        if (existing != bytes32(0) && existing != beaconRoot) {
            revert ConflictingBeaconRoot(ethereumTimestamp, existing, beaconRoot);
        }
        if (existing == bytes32(0)) {
            archivedBeaconRoots[ethereumTimestamp] = beaconRoot;
            emit BeaconRootArchived(ethereumTimestamp, beaconRoot);
        }
    }

    function submitCheckpoint(bytes calldata seal, bytes calldata journalData) external returns (bool stored) {
        bytes32 journalDigest = sha256(journalData);
        if (consumedJournalDigests[journalDigest]) return false;

        verifier.verify(seal, checkpointImageId, journalDigest);
        CheckpointJournal memory journal = abi.decode(journalData, (CheckpointJournal));
        _validateJournal(journal);
        _validateSteelCommitment(journal.ethereumCommitment);

        consumedJournalDigests[journalDigest] = true;
        for (uint256 i = 0; i < journal.canonicalBlocks.length; ++i) {
            CanonicalBlockRef memory blockRef = journal.canonicalBlocks[i];
            bytes32 existing = canonicalBlockHashes[blockRef.number];
            if (existing != bytes32(0) && existing != blockRef.blockHash) {
                revert ConflictingBlockHash(blockRef.number, existing, blockRef.blockHash);
            }
            if (existing == bytes32(0)) {
                canonicalBlockHashes[blockRef.number] = blockRef.blockHash;
                stored = true;
            }
        }

        emit CheckpointAccepted(
            journalDigest,
            journal.game,
            journal.checkpointBlockNumber,
            journal.checkpointBlockHash,
            journal.canonicalBlocks.length
        );
    }

    function beginHistoricalBackfill() external {
        if (historicalBackfillStarted) revert HistoricalBackfillAlreadyStarted();
        bytes32 anchorHash = canonicalBlockHashes[HISTORICAL_ANCHOR_BLOCK];
        if (anchorHash == bytes32(0)) revert HistoricalAnchorUnavailable();

        historicalBackfillStarted = true;
        historicalFrontierBlockNumber = HISTORICAL_ANCHOR_BLOCK;
        historicalFrontierBlockHash = anchorHash;
        emit HistoricalBackfillStarted(HISTORICAL_ANCHOR_BLOCK, anchorHash);
    }

    function submitHistoricalChunk(bytes calldata seal, bytes calldata journalData) external {
        if (!historicalBackfillStarted) revert HistoricalBackfillNotStarted();
        if (historicalCoverageComplete) revert HistoricalBackfillComplete();

        bytes32 journalDigest = sha256(journalData);
        if (consumedJournalDigests[journalDigest]) revert HistoricalJournalAlreadyConsumed(journalDigest);
        verifier.verify(seal, historicalChunkImageId, journalDigest);

        HistoricalChunkJournal memory journal = abi.decode(journalData, (HistoricalChunkJournal));
        _validateHistoricalChunkJournal(journal);

        uint16 chunkIndex = acceptedHistoricalChunkCount;
        consumedJournalDigests[journalDigest] = true;
        historicalChunkRoots[chunkIndex] = journal.blockRoot;
        acceptedHistoricalChunkCount = chunkIndex + 1;
        historicalFrontierBlockNumber = journal.startBlockNumber;
        historicalFrontierBlockHash = journal.startBlockHash;
        emit HistoricalChunkAccepted(
            journalDigest, chunkIndex, journal.startBlockNumber, journal.endBlockNumber, journal.blockRoot
        );

        if (journal.startBlockNumber == HISTORICAL_START_BLOCK) {
            if (acceptedHistoricalChunkCount != HISTORICAL_CHUNK_COUNT) revert InvalidHistoricalChunkJournal();
            historicalCoverageComplete = true;
        }
    }

    function materializeHistoricalBlocks(HistoricalBlockProof[] calldata proofs) external returns (uint256 stored) {
        for (uint256 proofIndex = 0; proofIndex < proofs.length; ++proofIndex) {
            HistoricalBlockProof calldata proof = proofs[proofIndex];
            uint16 chunkIndex = _historicalChunkIndex(proof.blockNumber);
            bytes32 root = historicalChunkRoots[chunkIndex];
            if (root == bytes32(0) || proof.blockHash == bytes32(0)) {
                revert InvalidHistoricalBlockProof(proof.blockNumber);
            }

            uint64 chunkStart = _historicalChunkStart(chunkIndex);
            bytes32 current = keccak256(abi.encodePacked(bytes1(0x00), proof.blockNumber, proof.blockHash));
            uint256 position = proof.blockNumber - chunkStart;
            for (uint256 level = 0; level < HISTORICAL_TREE_DEPTH; ++level) {
                bytes32 sibling = proof.siblings[level];
                current = position & 1 == 0
                    ? keccak256(abi.encodePacked(bytes1(0x02), current, sibling))
                    : keccak256(abi.encodePacked(bytes1(0x02), sibling, current));
                position >>= 1;
            }
            if (current != root) revert InvalidHistoricalBlockProof(proof.blockNumber);

            bytes32 existing = canonicalBlockHashes[proof.blockNumber];
            if (existing != bytes32(0) && existing != proof.blockHash) {
                revert ConflictingBlockHash(proof.blockNumber, existing, proof.blockHash);
            }
            if (existing == bytes32(0)) {
                canonicalBlockHashes[proof.blockNumber] = proof.blockHash;
                ++stored;
                emit HistoricalBlockMaterialized(proof.blockNumber, proof.blockHash, chunkIndex);
            }
        }
    }

    /// @inheritdoc IBaseAnalysisStateOracle
    function isCanonicalBlock(uint64 blockNumber, bytes32 blockHash) external view returns (bool) {
        return blockHash != bytes32(0) && canonicalBlockHashes[blockNumber] == blockHash;
    }

    function _validateJournal(CheckpointJournal memory journal) private pure {
        uint256 blockCount = journal.canonicalBlocks.length;
        if (
            journal.chainId != BASE_CHAIN_ID || journal.anchorStateRegistry != ANCHOR_STATE_REGISTRY
                || journal.game == address(0) || journal.intermediateRootIndex >= 20
                || journal.checkpointBlockNumber < AGGREGATE_VERIFIER_START_BLOCK
                || journal.checkpointBlockHash == bytes32(0) || journal.outputRoot == bytes32(0) || blockCount == 0
                || blockCount > INTERMEDIATE_BLOCK_INTERVAL
        ) revert InvalidCheckpointJournal();

        uint64 oldestAllowed = journal.checkpointBlockNumber - (INTERMEDIATE_BLOCK_INTERVAL - 1);
        uint64 previousBlock;
        for (uint256 i = 0; i < blockCount; ++i) {
            CanonicalBlockRef memory blockRef = journal.canonicalBlocks[i];
            if (
                blockRef.number < oldestAllowed || blockRef.number > journal.checkpointBlockNumber
                    || blockRef.blockHash == bytes32(0) || (i != 0 && blockRef.number <= previousBlock)
            ) revert InvalidCheckpointJournal();
            previousBlock = blockRef.number;
        }

        CanonicalBlockRef memory checkpoint = journal.canonicalBlocks[blockCount - 1];
        if (checkpoint.number != journal.checkpointBlockNumber || checkpoint.blockHash != journal.checkpointBlockHash) {
            revert InvalidCheckpointJournal();
        }
    }

    function _validateSteelCommitment(SteelCommitment memory commitment) private view {
        if (commitment.configID != ETHEREUM_MAINNET_CONFIG_ID) revert InvalidSteelCommitment();
        uint16 version = uint16(commitment.id >> 240);
        if (version != BEACON_COMMITMENT_VERSION || commitment.digest == bytes32(0)) {
            revert InvalidSteelCommitment();
        }

        uint256 ethereumTimestamp = uint256(uint240(commitment.id));
        bytes32 beaconRoot = archivedBeaconRoots[ethereumTimestamp];
        if (beaconRoot == bytes32(0)) {
            beaconRoot = _liveBeaconRoot(ethereumTimestamp);
        }
        if (beaconRoot != commitment.digest) revert InvalidSteelCommitment();
    }

    function _validateHistoricalChunkJournal(HistoricalChunkJournal memory journal) private view {
        uint64 frontier = historicalFrontierBlockNumber;
        uint64 expectedEnd = frontier - 1;
        uint64 expectedStart = frontier > HISTORICAL_START_BLOCK + HISTORICAL_CHUNK_SIZE
            ? frontier - HISTORICAL_CHUNK_SIZE
            : HISTORICAL_START_BLOCK;
        uint64 expectedBlockCount = expectedEnd - expectedStart + 1;

        if (
            journal.version != HISTORICAL_JOURNAL_VERSION || journal.chainId != BASE_CHAIN_ID
                || journal.startBlockNumber != expectedStart || journal.endBlockNumber != expectedEnd
                || journal.successorBlockNumber != frontier || journal.successorBlockHash != historicalFrontierBlockHash
                || journal.blockCount != expectedBlockCount || journal.startBlockHash == bytes32(0)
                || journal.endBlockHash == bytes32(0) || journal.blockRoot == bytes32(0)
        ) revert InvalidHistoricalChunkJournal();
    }

    function _historicalChunkIndex(uint64 blockNumber) private pure returns (uint16 chunkIndex) {
        if (blockNumber < HISTORICAL_START_BLOCK || blockNumber >= HISTORICAL_ANCHOR_BLOCK) {
            revert InvalidHistoricalBlockProof(blockNumber);
        }
        chunkIndex = uint16((HISTORICAL_ANCHOR_BLOCK - 1 - blockNumber) / HISTORICAL_CHUNK_SIZE);
    }

    function _historicalChunkStart(uint16 chunkIndex) private pure returns (uint64) {
        uint64 successor = HISTORICAL_ANCHOR_BLOCK - uint64(chunkIndex) * HISTORICAL_CHUNK_SIZE;
        return successor > HISTORICAL_START_BLOCK + HISTORICAL_CHUNK_SIZE
            ? successor - HISTORICAL_CHUNK_SIZE
            : HISTORICAL_START_BLOCK;
    }

    function _liveBeaconRoot(uint256 ethereumTimestamp) private view returns (bytes32 beaconRoot) {
        (bool success, bytes memory result) = BEACON_ROOTS.staticcall(abi.encode(ethereumTimestamp));
        if (!success || result.length != 32) revert BeaconRootUnavailable(ethereumTimestamp);
        beaconRoot = abi.decode(result, (bytes32));
        if (beaconRoot == bytes32(0)) revert BeaconRootUnavailable(ethereumTimestamp);
    }
}
