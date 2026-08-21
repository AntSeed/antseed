// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract AccumulatorVerifierMock is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure { }
}

contract AntseedBaseHistoricalAccumulatorTest is Test {
    bytes32 internal constant EPOCH_RECURSION_VKEY = bytes32(uint256(1));
    bytes32 internal constant ACCUMULATOR_PROGRAM_VKEY = bytes32(uint256(2));
    uint32 internal constant EPOCH_COUNT = 334;

    AntseedBaseCheckpointOracle internal oracle;
    bytes32 internal anchorHash = keccak256("anchor");
    bytes32[] internal peaks;
    AntseedBaseCheckpointOracle.HistoricalBlockProof internal proof;

    function setUp() external {
        vm.chainId(8_453);
        oracle = new AntseedBaseCheckpointOracle(
            address(new AccumulatorVerifierMock()), EPOCH_RECURSION_VKEY, ACCUMULATOR_PROGRAM_VKEY
        );
        _buildProof();
        uint64 anchor = _anchor();
        vm.roll(anchor + 100);
        vm.mockCall(oracle.HISTORY_STORAGE(), abi.encode(uint256(anchor)), abi.encode(anchorHash));
    }

    function testAcceptsAccumulatorAndMaterializesBlock() external {
        oracle.submitHistoricalAccumulator(hex"01", abi.encode(_journal()));
        assertTrue(oracle.historicalCoverageComplete());
        assertEq(oracle.historicalMmrRoot(), _mmrRoot());
        assertEq(oracle.materializeHistoricalBlocks(_proofs()), 1);
        assertEq(oracle.materializeHistoricalBlocks(_proofs()), 0);
        assertTrue(oracle.isCanonicalBlock(proof.blockNumber, proof.blockHash));
    }

    function testRejectsWrongAnchor() external {
        vm.clearMockedCalls();
        vm.mockCall(oracle.HISTORY_STORAGE(), abi.encode(uint256(_anchor())), abi.encode(bytes32(uint256(99))));
        bytes memory journalData = abi.encode(_journal());
        vm.expectRevert();
        oracle.submitHistoricalAccumulator(hex"01", journalData);
    }

    function testRejectsSecondAccumulator() external {
        bytes memory journalData = abi.encode(_journal());
        oracle.submitHistoricalAccumulator(hex"01", journalData);
        vm.expectRevert();
        oracle.submitHistoricalAccumulator(hex"01", journalData);
    }

    function testRejectsTamperedMembership() external {
        oracle.submitHistoricalAccumulator(hex"01", abi.encode(_journal()));
        AntseedBaseCheckpointOracle.HistoricalBlockProof[] memory values = _proofs();
        values[0].blockHash = keccak256("wrong");
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedBaseCheckpointOracle.InvalidHistoricalBlockProof.selector, values[0].blockNumber
            )
        );
        oracle.materializeHistoricalBlocks(values);
    }

    function testRejectsInsufficientCoverage() external {
        AntseedBaseCheckpointOracle.AccumulatorJournal memory journal = _journal();
        journal.epochCount = EPOCH_COUNT - 1;
        journal.blockCount = uint64(journal.epochCount) * oracle.EPOCH_SIZE();
        journal.endBlockNumber = oracle.HISTORICAL_START_BLOCK() + journal.blockCount - 1;
        journal.anchorBlockNumber = journal.endBlockNumber;
        vm.expectRevert(AntseedBaseCheckpointOracle.InvalidAccumulatorJournal.selector);
        oracle.submitHistoricalAccumulator(hex"01", abi.encode(journal));
    }

    function testRejectsExpiredAnchor() external {
        vm.roll(uint256(_anchor()) + oracle.EIP2935_WINDOW() + 1);
        AntseedBaseCheckpointOracle.AccumulatorJournal memory journal = _journal();
        vm.expectRevert(AntseedBaseCheckpointOracle.InvalidAccumulatorJournal.selector);
        oracle.submitHistoricalAccumulator(hex"01", abi.encode(journal));
    }

    function testRejectsMalformedPeakAndMountainLengths() external {
        oracle.submitHistoricalAccumulator(hex"01", abi.encode(_journal()));
        AntseedBaseCheckpointOracle.HistoricalBlockProof[] memory values = _proofs();
        values[0].peaks = new bytes32[](4);
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedBaseCheckpointOracle.InvalidHistoricalBlockProof.selector, values[0].blockNumber
            )
        );
        oracle.materializeHistoricalBlocks(values);

        values = _proofs();
        values[0].mountainSiblings = new bytes32[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedBaseCheckpointOracle.InvalidHistoricalBlockProof.selector, values[0].blockNumber
            )
        );
        oracle.materializeHistoricalBlocks(values);
    }

    function testMaterializesEveryProductionMountain() external {
        uint32[] memory targets = new uint32[](10);
        targets[0] = 0;
        targets[1] = 255;
        targets[2] = 256;
        targets[3] = 319;
        targets[4] = 320;
        targets[5] = 327;
        targets[6] = 328;
        targets[7] = 331;
        targets[8] = 332;
        targets[9] = 333;

        bytes32[] memory leaves = new bytes32[](EPOCH_COUNT);
        for (uint32 index = 0; index < EPOCH_COUNT; ++index) {
            leaves[index] = keccak256(abi.encodePacked("unused-epoch", index));
        }
        AntseedBaseCheckpointOracle.HistoricalBlockProof[] memory values =
            new AntseedBaseCheckpointOracle.HistoricalBlockProof[](targets.length);
        for (uint256 index = 0; index < targets.length; ++index) {
            bytes32 leaf;
            (values[index], leaf) = _baseProof(targets[index]);
            leaves[targets[index]] = leaf;
        }

        bytes32[] memory allPeaks = _peaks(leaves);
        for (uint256 index = 0; index < targets.length; ++index) {
            (uint32 peakIndex, uint32 mountainStart, uint32 mountainSize) = _mountain(targets[index]);
            values[index].targetPeakIndex = peakIndex;
            values[index].mountainSiblings = _mountainBranch(leaves, mountainStart, mountainSize, targets[index]);
            values[index].peaks = allPeaks;
        }

        AntseedBaseCheckpointOracle candidate = new AntseedBaseCheckpointOracle(
            address(new AccumulatorVerifierMock()), EPOCH_RECURSION_VKEY, ACCUMULATOR_PROGRAM_VKEY
        );
        AntseedBaseCheckpointOracle.AccumulatorJournal memory journal = _journal();
        journal.mmrRoot = keccak256(abi.encodePacked(bytes1(0x12), EPOCH_COUNT, allPeaks));
        candidate.submitHistoricalAccumulator(hex"01", abi.encode(journal));
        assertEq(candidate.materializeHistoricalBlocks(values), targets.length);
        for (uint256 index = 0; index < values.length; ++index) {
            assertTrue(candidate.isCanonicalBlock(values[index].blockNumber, values[index].blockHash));
        }
    }

    function _buildProof() private {
        uint32 epochIndex = EPOCH_COUNT - 1;
        uint64 epochStart = oracle.HISTORICAL_START_BLOCK() + uint64(epochIndex) * oracle.EPOCH_SIZE();
        bytes32 blockHash = keccak256("target-block");
        bytes32[14] memory blockSiblings;
        bytes32 blockRoot = keccak256(abi.encodePacked(bytes1(0x00), epochStart, blockHash));
        for (uint8 level = 0; level < 14; ++level) {
            blockSiblings[level] = bytes32(uint256(level + 10));
            blockRoot = keccak256(abi.encodePacked(bytes1(0x02), blockRoot, blockSiblings[level]));
        }
        bytes32 firstParentHash = keccak256("first-parent");
        bytes32 epochLeaf = keccak256(
            abi.encodePacked(
                bytes1(0x10),
                uint64(8_453),
                epochIndex,
                epochStart,
                epochStart + oracle.EPOCH_SIZE() - 1,
                firstParentHash,
                anchorHash,
                blockRoot
            )
        );
        bytes32 mountainSibling = keccak256("epoch-332");
        bytes32 targetPeak = keccak256(abi.encodePacked(bytes1(0x11), uint8(1), mountainSibling, epochLeaf));
        peaks.push(keccak256("peak-256"));
        peaks.push(keccak256("peak-64"));
        peaks.push(keccak256("peak-8"));
        peaks.push(keccak256("peak-4"));
        peaks.push(targetPeak);
        bytes32[] memory mountainSiblings = new bytes32[](1);
        mountainSiblings[0] = mountainSibling;
        proof = AntseedBaseCheckpointOracle.HistoricalBlockProof({
            blockNumber: epochStart,
            blockHash: blockHash,
            blockSiblings: blockSiblings,
            epochFirstParentHash: firstParentHash,
            epochEndBlockHash: anchorHash,
            mountainSiblings: mountainSiblings,
            peaks: peaks,
            targetPeakIndex: 4
        });
    }

    function _journal() private view returns (AntseedBaseCheckpointOracle.AccumulatorJournal memory) {
        uint64 blockCount = uint64(EPOCH_COUNT) * oracle.EPOCH_SIZE();
        return AntseedBaseCheckpointOracle.AccumulatorJournal({
            version: oracle.JOURNAL_VERSION(),
            chainId: 8_453,
            epochRecursionVKey: EPOCH_RECURSION_VKEY,
            startBlockNumber: oracle.HISTORICAL_START_BLOCK(),
            endBlockNumber: _anchor(),
            anchorBlockNumber: _anchor(),
            anchorBlockHash: anchorHash,
            blockCount: blockCount,
            epochSize: oracle.EPOCH_SIZE(),
            epochCount: EPOCH_COUNT,
            mmrRoot: _mmrRoot()
        });
    }

    function _anchor() private view returns (uint64) {
        return oracle.HISTORICAL_START_BLOCK() + uint64(EPOCH_COUNT) * oracle.EPOCH_SIZE() - 1;
    }

    function _mmrRoot() private view returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x12), EPOCH_COUNT, peaks));
    }

    function _proofs() private view returns (AntseedBaseCheckpointOracle.HistoricalBlockProof[] memory values) {
        values = new AntseedBaseCheckpointOracle.HistoricalBlockProof[](1);
        values[0] = proof;
    }

    function _baseProof(uint32 epochIndex)
        private
        view
        returns (AntseedBaseCheckpointOracle.HistoricalBlockProof memory value, bytes32 epochLeaf)
    {
        uint64 epochStart = oracle.HISTORICAL_START_BLOCK() + uint64(epochIndex) * oracle.EPOCH_SIZE();
        uint64 blockNumber = epochStart + epochIndex;
        bytes32 blockHash = keccak256(abi.encodePacked("block", epochIndex));
        bytes32[14] memory blockSiblings;
        bytes32 blockRoot = keccak256(abi.encodePacked(bytes1(0x00), blockNumber, blockHash));
        uint256 position = epochIndex;
        for (uint8 level = 0; level < 14; ++level) {
            bytes32 sibling = keccak256(abi.encodePacked("block-sibling", epochIndex, level));
            blockSiblings[level] = sibling;
            blockRoot = position & 1 == 0
                ? keccak256(abi.encodePacked(bytes1(0x02), blockRoot, sibling))
                : keccak256(abi.encodePacked(bytes1(0x02), sibling, blockRoot));
            position >>= 1;
        }
        bytes32 firstParentHash = keccak256(abi.encodePacked("first-parent", epochIndex));
        bytes32 endHash =
            epochIndex == EPOCH_COUNT - 1 ? anchorHash : keccak256(abi.encodePacked("end-block", epochIndex));
        epochLeaf = keccak256(
            abi.encodePacked(
                bytes1(0x10),
                uint64(8_453),
                epochIndex,
                epochStart,
                epochStart + oracle.EPOCH_SIZE() - 1,
                firstParentHash,
                endHash,
                blockRoot
            )
        );
        value = AntseedBaseCheckpointOracle.HistoricalBlockProof({
            blockNumber: blockNumber,
            blockHash: blockHash,
            blockSiblings: blockSiblings,
            epochFirstParentHash: firstParentHash,
            epochEndBlockHash: endHash,
            mountainSiblings: new bytes32[](0),
            peaks: new bytes32[](0),
            targetPeakIndex: 0
        });
    }

    function _peaks(bytes32[] memory leaves) private pure returns (bytes32[] memory result) {
        result = new bytes32[](5);
        uint32 start;
        uint32 remaining = EPOCH_COUNT;
        uint32 peakIndex;
        while (remaining != 0) {
            uint32 size = _highestPowerOfTwo(remaining);
            result[peakIndex++] = _mountainRoot(leaves, start, size);
            start += size;
            remaining -= size;
        }
    }

    function _mountain(uint32 target) private pure returns (uint32 peakIndex, uint32 start, uint32 size) {
        uint32 remaining = EPOCH_COUNT;
        while (remaining != 0) {
            size = _highestPowerOfTwo(remaining);
            if (target >= start && target < start + size) return (peakIndex, start, size);
            start += size;
            remaining -= size;
            ++peakIndex;
        }
        revert("mountain missing");
    }

    function _mountainRoot(bytes32[] memory leaves, uint32 start, uint32 size) private pure returns (bytes32) {
        bytes32[] memory layer = new bytes32[](size);
        for (uint32 index = 0; index < size; ++index) {
            layer[index] = leaves[start + index];
        }
        uint8 height;
        while (layer.length > 1) {
            bytes32[] memory next = new bytes32[](layer.length / 2);
            ++height;
            for (uint256 index = 0; index < next.length; ++index) {
                next[index] = keccak256(abi.encodePacked(bytes1(0x11), height, layer[index * 2], layer[index * 2 + 1]));
            }
            layer = next;
        }
        return layer[0];
    }

    function _mountainBranch(bytes32[] memory leaves, uint32 start, uint32 size, uint32 target)
        private
        pure
        returns (bytes32[] memory siblings)
    {
        uint256 depth;
        for (uint32 value = size; value > 1; value >>= 1) {
            ++depth;
        }
        siblings = new bytes32[](depth);
        bytes32[] memory layer = new bytes32[](size);
        for (uint32 index = 0; index < size; ++index) {
            layer[index] = leaves[start + index];
        }
        uint256 position = target - start;
        for (uint8 height = 1; layer.length > 1; ++height) {
            siblings[height - 1] = layer[position ^ 1];
            bytes32[] memory next = new bytes32[](layer.length / 2);
            for (uint256 index = 0; index < next.length; ++index) {
                next[index] = keccak256(abi.encodePacked(bytes1(0x11), height, layer[index * 2], layer[index * 2 + 1]));
            }
            position >>= 1;
            layer = next;
        }
    }

    function _highestPowerOfTwo(uint32 value) private pure returns (uint32 result) {
        result = 1;
        while (result <= value / 2) result <<= 1;
    }
}
