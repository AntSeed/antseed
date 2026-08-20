// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

contract HistoricalMockVerifier is IRiscZeroVerifier {
    bytes32 private expectedImageId;
    bytes32 private expectedJournalDigest;
    bytes32 private expectedSealHash;

    function expect(bytes32 imageId, bytes32 journalDigest, bytes memory seal) external {
        expectedImageId = imageId;
        expectedJournalDigest = journalDigest;
        expectedSealHash = keccak256(seal);
    }

    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view {
        require(imageId == expectedImageId, "wrong image");
        require(journalDigest == expectedJournalDigest, "wrong journal");
        require(keccak256(seal) == expectedSealHash, "wrong seal");
    }
}

contract AntseedBaseHistoricalBackfillTest is Test {
    bytes32 internal constant CHECKPOINT_IMAGE_ID = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant HISTORICAL_IMAGE_ID = bytes32(uint256(0xBACCF111));
    bytes32 internal constant BEACON_ROOT = keccak256("beacon-root");
    bytes internal constant SEAL = hex"1234";
    uint256 internal constant ETHEREUM_TIMESTAMP = 1_787_000_000;

    HistoricalMockVerifier internal verifier;
    AntseedBaseCheckpointOracle internal oracle;

    function setUp() public {
        vm.chainId(8_453);
        verifier = new HistoricalMockVerifier();
        oracle = new AntseedBaseCheckpointOracle(address(verifier), CHECKPOINT_IMAGE_ID, HISTORICAL_IMAGE_ID);
        vm.mockCall(oracle.BEACON_ROOTS(), abi.encode(ETHEREUM_TIMESTAMP), abi.encode(BEACON_ROOT));
    }

    function test_beginRequiresAuthenticatedAnchor() public {
        vm.expectRevert(AntseedBaseCheckpointOracle.HistoricalAnchorUnavailable.selector);
        oracle.beginHistoricalBackfill();

        _seedAnchor();
        oracle.beginHistoricalBackfill();
        assertTrue(oracle.historicalBackfillStarted());
        assertEq(oracle.historicalFrontierBlockNumber(), oracle.HISTORICAL_ANCHOR_BLOCK());
        assertEq(oracle.historicalFrontierBlockHash(), _anchorHash());

        vm.expectRevert(AntseedBaseCheckpointOracle.HistoricalBackfillAlreadyStarted.selector);
        oracle.beginHistoricalBackfill();
    }

    function test_rejectsHistoricalChunkBeforeBackfillStarts() public {
        AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal =
            _chunkJournal(0, _anchorHash(), keccak256("root-0"));
        bytes memory journalData = abi.encode(journal);
        verifier.expect(HISTORICAL_IMAGE_ID, sha256(journalData), SEAL);
        vm.expectRevert(AntseedBaseCheckpointOracle.HistoricalBackfillNotStarted.selector);
        oracle.submitHistoricalChunk(SEAL, journalData);
    }

    function test_acceptsOnlyExactNewestToOldestChunkAndRejectsReplay() public {
        _seedAnchorAndBegin();
        AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal =
            _chunkJournal(0, _anchorHash(), keccak256("root-0"));
        AntseedBaseCheckpointOracle.HistoricalChunkJournal memory wrong = journal;
        wrong.startBlockNumber += 1;
        _expectInvalidChunk(wrong);
        journal.startBlockNumber -= 1;

        bytes memory journalData = _submitChunk(journal);
        assertEq(oracle.acceptedHistoricalChunkCount(), 1);
        assertEq(oracle.historicalFrontierBlockNumber(), journal.startBlockNumber);
        assertEq(oracle.historicalFrontierBlockHash(), journal.startBlockHash);
        assertEq(oracle.historicalChunkRoots(0), journal.blockRoot);

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedBaseCheckpointOracle.HistoricalJournalAlreadyConsumed.selector, sha256(journalData)
            )
        );
        oracle.submitHistoricalChunk(SEAL, journalData);
    }

    function test_materializesValidBlockAndRejectsWrongProof() public {
        _seedAnchorAndBegin();
        AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal = _chunkJournal(0, _anchorHash(), bytes32(0));
        uint64 blockNumber = journal.startBlockNumber + 123;
        bytes32 blockHash = keccak256("historical-block");
        bytes32[14] memory siblings;
        for (uint256 index = 0; index < siblings.length; ++index) {
            siblings[index] = keccak256(abi.encodePacked("sibling", index));
        }
        journal.blockRoot = _blockRoot(journal.startBlockNumber, blockNumber, blockHash, siblings);
        assertEq(journal.blockRoot, 0x7e1834c5af9c8f513d7af729f62ee8719b32a7e7fae4757b5aaf8699eaa54f4f);
        _submitChunk(journal);

        AntseedBaseCheckpointOracle.HistoricalBlockProof[] memory proofs =
            new AntseedBaseCheckpointOracle.HistoricalBlockProof[](1);
        proofs[0] = AntseedBaseCheckpointOracle.HistoricalBlockProof({
            blockNumber: blockNumber,
            blockHash: blockHash,
            siblings: siblings
        });
        assertEq(oracle.materializeHistoricalBlocks(proofs), 1);
        assertEq(oracle.materializeHistoricalBlocks(proofs), 0);
        assertTrue(oracle.isCanonicalBlock(blockNumber, blockHash));

        proofs[0].siblings[0] = keccak256("wrong-sibling");
        vm.expectRevert(
            abi.encodeWithSelector(AntseedBaseCheckpointOracle.InvalidHistoricalBlockProof.selector, blockNumber)
        );
        oracle.materializeHistoricalBlocks(proofs);
    }

    function test_completesAll112ChunksAndFinalizesOrderedRoot() public {
        _seedAnchorAndBegin();
        bytes32 successorHash = _anchorHash();
        bytes32[112] memory roots;
        for (uint16 index = 0; index < 112; ++index) {
            roots[index] = keccak256(abi.encodePacked("root", index));
            AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal =
                _chunkJournal(index, successorHash, roots[index]);
            successorHash = journal.startBlockHash;
            _submitChunk(journal);
        }

        assertTrue(oracle.historicalCoverageComplete());
        assertEq(oracle.acceptedHistoricalChunkCount(), 112);
        assertEq(oracle.historicalFrontierBlockNumber(), oracle.HISTORICAL_START_BLOCK());
        assertEq(oracle.historicalRoot(), _expectedHistoricalRoot(roots));

        vm.expectRevert(AntseedBaseCheckpointOracle.HistoricalBackfillComplete.selector);
        oracle.submitHistoricalChunk(SEAL, hex"");
    }

    function _seedAnchorAndBegin() internal {
        _seedAnchor();
        oracle.beginHistoricalBackfill();
    }

    function _seedAnchor() internal {
        AntseedBaseCheckpointOracle.CanonicalBlockRef[] memory blocks =
            new AntseedBaseCheckpointOracle.CanonicalBlockRef[](1);
        blocks[0] = AntseedBaseCheckpointOracle.CanonicalBlockRef({
            number: oracle.HISTORICAL_ANCHOR_BLOCK(),
            blockHash: _anchorHash()
        });
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = AntseedBaseCheckpointOracle.CheckpointJournal({
            ethereumCommitment: AntseedBaseCheckpointOracle.SteelCommitment({
                id: (uint256(1) << 240) | ETHEREUM_TIMESTAMP,
                digest: BEACON_ROOT,
                configID: oracle.ETHEREUM_MAINNET_CONFIG_ID()
            }),
            chainId: 8_453,
            anchorStateRegistry: oracle.ANCHOR_STATE_REGISTRY(),
            game: address(0x621),
            intermediateRootIndex: 0,
            checkpointBlockNumber: oracle.HISTORICAL_ANCHOR_BLOCK(),
            checkpointBlockHash: _anchorHash(),
            outputRoot: keccak256("output-root"),
            canonicalBlocks: blocks
        });
        bytes memory journalData = abi.encode(journal);
        verifier.expect(CHECKPOINT_IMAGE_ID, sha256(journalData), SEAL);
        assertTrue(oracle.submitCheckpoint(SEAL, journalData));
    }

    function _chunkJournal(uint16 index, bytes32 successorHash, bytes32 blockRoot)
        internal
        view
        returns (AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal)
    {
        uint64 successor = oracle.HISTORICAL_ANCHOR_BLOCK() - uint64(index) * oracle.HISTORICAL_CHUNK_SIZE();
        uint64 start = successor > oracle.HISTORICAL_START_BLOCK() + oracle.HISTORICAL_CHUNK_SIZE()
            ? successor - oracle.HISTORICAL_CHUNK_SIZE()
            : oracle.HISTORICAL_START_BLOCK();
        journal = AntseedBaseCheckpointOracle.HistoricalChunkJournal({
            version: 1,
            chainId: 8_453,
            startBlockNumber: start,
            endBlockNumber: successor - 1,
            successorBlockNumber: successor,
            startBlockHash: keccak256(abi.encodePacked("start", index)),
            endBlockHash: keccak256(abi.encodePacked("end", index)),
            successorBlockHash: successorHash,
            blockCount: uint32(successor - start),
            blockRoot: blockRoot
        });
    }

    function _submitChunk(AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal)
        internal
        returns (bytes memory journalData)
    {
        journalData = abi.encode(journal);
        verifier.expect(HISTORICAL_IMAGE_ID, sha256(journalData), SEAL);
        oracle.submitHistoricalChunk(SEAL, journalData);
    }

    function _expectInvalidChunk(AntseedBaseCheckpointOracle.HistoricalChunkJournal memory journal) internal {
        bytes memory journalData = abi.encode(journal);
        verifier.expect(HISTORICAL_IMAGE_ID, sha256(journalData), SEAL);
        vm.expectRevert(AntseedBaseCheckpointOracle.InvalidHistoricalChunkJournal.selector);
        oracle.submitHistoricalChunk(SEAL, journalData);
    }

    function _blockRoot(uint64 chunkStart, uint64 blockNumber, bytes32 blockHash, bytes32[14] memory siblings)
        internal
        pure
        returns (bytes32 current)
    {
        current = keccak256(abi.encodePacked(bytes1(0x00), blockNumber, blockHash));
        uint256 position = blockNumber - chunkStart;
        for (uint256 level = 0; level < siblings.length; ++level) {
            current = position & 1 == 0
                ? keccak256(abi.encodePacked(bytes1(0x02), current, siblings[level]))
                : keccak256(abi.encodePacked(bytes1(0x02), siblings[level], current));
            position >>= 1;
        }
    }

    function _expectedHistoricalRoot(bytes32[112] memory roots) internal view returns (bytes32) {
        bytes32[128] memory nodes;
        for (uint16 index = 0; index < 112; ++index) {
            uint64 successor = oracle.HISTORICAL_ANCHOR_BLOCK() - uint64(index) * oracle.HISTORICAL_CHUNK_SIZE();
            uint64 start = successor > oracle.HISTORICAL_START_BLOCK() + oracle.HISTORICAL_CHUNK_SIZE()
                ? successor - oracle.HISTORICAL_CHUNK_SIZE()
                : oracle.HISTORICAL_START_BLOCK();
            nodes[index] = keccak256(abi.encodePacked(bytes1(0x10), start, successor - 1, roots[index]));
        }
        for (uint16 index = 112; index < 128; ++index) {
            nodes[index] = keccak256(abi.encodePacked(bytes1(0x11), index));
        }
        uint256 width = 128;
        while (width > 1) {
            for (uint256 index = 0; index < width; index += 2) {
                nodes[index >> 1] = keccak256(abi.encodePacked(bytes1(0x12), nodes[index], nodes[index + 1]));
            }
            width >>= 1;
        }
        return nodes[0];
    }

    function _anchorHash() internal pure returns (bytes32) {
        return keccak256("historical-anchor");
    }
}
