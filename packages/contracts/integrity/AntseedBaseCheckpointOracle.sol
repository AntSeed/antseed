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

    IRiscZeroVerifier public immutable verifier;
    bytes32 public immutable checkpointImageId;

    mapping(uint64 blockNumber => bytes32 blockHash) public canonicalBlockHashes;
    mapping(uint256 ethereumTimestamp => bytes32 beaconRoot) public archivedBeaconRoots;
    mapping(bytes32 journalDigest => bool consumed) public consumedJournalDigests;

    error ZeroAddress();
    error ZeroImageId();
    error WrongChain(uint256 chainId);
    error InvalidCheckpointJournal();
    error InvalidSteelCommitment();
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

    constructor(address verifier_, bytes32 checkpointImageId_) {
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        if (verifier_ == address(0)) revert ZeroAddress();
        if (checkpointImageId_ == bytes32(0)) revert ZeroImageId();
        verifier = IRiscZeroVerifier(verifier_);
        checkpointImageId = checkpointImageId_;
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

    function _liveBeaconRoot(uint256 ethereumTimestamp) private view returns (bytes32 beaconRoot) {
        (bool success, bytes memory result) = BEACON_ROOTS.staticcall(abi.encode(ethereumTimestamp));
        if (!success || result.length != 32) revert BeaconRootUnavailable(ethereumTimestamp);
        beaconRoot = abi.decode(result, (bytes32));
        if (beaconRoot == bytes32(0)) revert BeaconRootUnavailable(ethereumTimestamp);
    }
}
