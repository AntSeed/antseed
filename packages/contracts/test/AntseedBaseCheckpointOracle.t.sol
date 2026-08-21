// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedBaseCheckpointOracle } from "../integrity/AntseedBaseCheckpointOracle.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

contract MockCheckpointVerifier is IRiscZeroVerifier {
    bytes32 public expectedImageId;
    bytes32 public expectedJournalDigest;
    bytes32 public expectedSealHash;

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

contract MockBeaconRoots {
    mapping(uint256 timestamp => bytes32 root) public roots;

    function setRoot(uint256 timestamp, bytes32 root) external {
        roots[timestamp] = root;
    }

    fallback(bytes calldata input) external returns (bytes memory output) {
        uint256 timestamp = abi.decode(input, (uint256));
        bytes32 root = roots[timestamp];
        require(root != bytes32(0), "unknown timestamp");
        return abi.encode(root);
    }
}

contract AntseedBaseCheckpointOracleTest is Test {
    bytes32 internal constant IMAGE_ID = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant HISTORICAL_IMAGE_ID = bytes32(uint256(0xBACCF111));
    bytes internal constant SEAL = hex"1234";
    uint256 internal constant ETHEREUM_TIMESTAMP = 1_787_000_000;
    bytes32 internal constant BEACON_ROOT = keccak256("beacon-root");

    MockCheckpointVerifier internal verifier;
    AntseedBaseCheckpointOracle internal oracle;
    MockBeaconRoots internal beaconRoots;

    function setUp() public {
        vm.chainId(8_453);
        verifier = new MockCheckpointVerifier();
        oracle = new AntseedBaseCheckpointOracle(address(verifier), IMAGE_ID, HISTORICAL_IMAGE_ID);

        MockBeaconRoots implementation = new MockBeaconRoots();
        vm.etch(oracle.BEACON_ROOTS(), address(implementation).code);
        beaconRoots = MockBeaconRoots(payable(oracle.BEACON_ROOTS()));
        beaconRoots.setRoot(ETHEREUM_TIMESTAMP, BEACON_ROOT);
    }

    function test_rejectsDeploymentOffBaseMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(AntseedBaseCheckpointOracle.WrongChain.selector, 1));
        new AntseedBaseCheckpointOracle(address(verifier), IMAGE_ID, HISTORICAL_IMAGE_ID);
    }

    function test_rejectsCodeLessVerifier() public {
        vm.expectRevert(abi.encodeWithSelector(AntseedBaseCheckpointOracle.NoCode.selector, address(1)));
        new AntseedBaseCheckpointOracle(address(1), IMAGE_ID, HISTORICAL_IMAGE_ID);
    }

    function test_acceptsCheckpointAndStoresCanonicalBlocks() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);

        uint256 gasBefore = gasleft();
        assertTrue(oracle.submitCheckpoint(SEAL, journalData));
        emit log_named_uint("2-block checkpoint submit execution gas", gasBefore - gasleft());
        assertTrue(oracle.isCanonicalBlock(journal.canonicalBlocks[0].number, journal.canonicalBlocks[0].blockHash));
        assertTrue(oracle.isCanonicalBlock(journal.checkpointBlockNumber, journal.checkpointBlockHash));
        assertFalse(oracle.isCanonicalBlock(journal.checkpointBlockNumber, keccak256("wrong")));
        assertTrue(oracle.consumedJournalDigests(sha256(journalData)));
    }

    function test_liveRustJournalDecodesAndAuthorizesSellerProof() public {
        bytes memory checkpointData = vm.parseBytes(vm.readFile("test/fixtures/checkpoint-journal.hex"));
        AntseedBaseCheckpointOracle.CheckpointJournal memory checkpoint =
            abi.decode(checkpointData, (AntseedBaseCheckpointOracle.CheckpointJournal));
        uint256 ethereumTimestamp = uint256(uint240(checkpoint.ethereumCommitment.id));
        beaconRoots.setRoot(ethereumTimestamp, checkpoint.ethereumCommitment.digest);
        verifier.expect(IMAGE_ID, sha256(checkpointData), SEAL);
        assertTrue(oracle.submitCheckpoint(SEAL, checkpointData));

        bytes32 sellerImageId = bytes32(uint256(0x5E11E2));
        bytes32 reciprocalImageId = bytes32(uint256(0x5E11E3));
        AntseedWashTradingRegistry registry =
            new AntseedWashTradingRegistry(address(verifier), address(oracle), sellerImageId, reciprocalImageId);
        AntseedWashTradingRegistry.BlockRef[] memory blockRefs = new AntseedWashTradingRegistry.BlockRef[](1);
        blockRefs[0] = AntseedWashTradingRegistry.BlockRef({
            number: checkpoint.canonicalBlocks[0].number,
            blockHash: checkpoint.canonicalBlocks[0].blockHash
        });
        AntseedWashTradingRegistry.ClosedCycleJournal memory sellerJournal =
            AntseedWashTradingRegistry.ClosedCycleJournal({ seller: address(0x515E12), blockRefs: blockRefs });
        bytes memory sellerJournalData = abi.encode(sellerJournal);
        verifier.expect(sellerImageId, sha256(sellerJournalData), SEAL);

        assertTrue(registry.submitClosedCycleProof(SEAL, sellerJournalData));
        assertTrue(registry.isSellerP0(address(0x515E12)));
    }

    function test_exactReplayIsIdempotent() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);

        assertTrue(oracle.submitCheckpoint(SEAL, journalData));
        assertFalse(oracle.submitCheckpoint(hex"", journalData));
    }

    function test_archivedBeaconRootSurvivesLiveExpiry() public {
        assertEq(oracle.archiveBeaconRoot(ETHEREUM_TIMESTAMP), BEACON_ROOT);
        beaconRoots.setRoot(ETHEREUM_TIMESTAMP, bytes32(0));

        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);

        assertTrue(oracle.submitCheckpoint(SEAL, journalData));
    }

    function test_rejectsUnavailableBeaconRoot() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.ethereumCommitment.id = _beaconCommitmentId(ETHEREUM_TIMESTAMP + 1);
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);

        vm.expectRevert(
            abi.encodeWithSelector(AntseedBaseCheckpointOracle.BeaconRootUnavailable.selector, ETHEREUM_TIMESTAMP + 1)
        );
        oracle.submitCheckpoint(SEAL, journalData);
    }

    function test_rejectsWrongSteelConfig() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.ethereumCommitment.configID = keccak256("wrong-config");
        _expectInvalidSteel(journal);
    }

    function test_rejectsNonBeaconSteelCommitment() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.ethereumCommitment.id = ETHEREUM_TIMESTAMP;
        _expectInvalidSteel(journal);
    }

    function test_rejectsWrongBeaconRoot() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.ethereumCommitment.digest = keccak256("wrong-beacon-root");
        _expectInvalidSteel(journal);
    }

    function test_rejectsConflictingCanonicalBlock() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory first = _journal();
        bytes memory firstData = abi.encode(first);
        verifier.expect(IMAGE_ID, sha256(firstData), SEAL);
        assertTrue(oracle.submitCheckpoint(SEAL, firstData));

        AntseedBaseCheckpointOracle.CheckpointJournal memory second = _journal();
        second.canonicalBlocks[0].blockHash = keccak256("conflict");
        bytes memory secondData = abi.encode(second);
        verifier.expect(IMAGE_ID, sha256(secondData), SEAL);
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedBaseCheckpointOracle.ConflictingBlockHash.selector,
                second.canonicalBlocks[0].number,
                first.canonicalBlocks[0].blockHash,
                second.canonicalBlocks[0].blockHash
            )
        );
        oracle.submitCheckpoint(SEAL, secondData);
    }

    function test_rejectsUnsortedCanonicalBlocks() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.canonicalBlocks[1].number = journal.canonicalBlocks[0].number;
        _expectInvalidJournal(journal);
    }

    function test_rejectsBlockOutsideCheckpointWindow() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.canonicalBlocks[0].number = journal.checkpointBlockNumber - 30;
        _expectInvalidJournal(journal);
    }

    function test_rejectsMissingCheckpointAsLastBlock() public {
        AntseedBaseCheckpointOracle.CheckpointJournal memory journal = _journal();
        journal.canonicalBlocks[1].blockHash = keccak256("not-checkpoint");
        _expectInvalidJournal(journal);
    }

    function _expectInvalidSteel(AntseedBaseCheckpointOracle.CheckpointJournal memory journal) internal {
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);
        vm.expectRevert(AntseedBaseCheckpointOracle.InvalidSteelCommitment.selector);
        oracle.submitCheckpoint(SEAL, journalData);
    }

    function _expectInvalidJournal(AntseedBaseCheckpointOracle.CheckpointJournal memory journal) internal {
        bytes memory journalData = abi.encode(journal);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);
        vm.expectRevert(AntseedBaseCheckpointOracle.InvalidCheckpointJournal.selector);
        oracle.submitCheckpoint(SEAL, journalData);
    }

    function _journal() internal pure returns (AntseedBaseCheckpointOracle.CheckpointJournal memory journal) {
        uint64 checkpointBlock = 49_934_760;
        bytes32 checkpointHash = 0xe48cfd964bca19ba9b265a328b6557dad192a3950c69003dc8fa422da4f7c8d0;
        AntseedBaseCheckpointOracle.CanonicalBlockRef[] memory blocks =
            new AntseedBaseCheckpointOracle.CanonicalBlockRef[](2);
        blocks[0] = AntseedBaseCheckpointOracle.CanonicalBlockRef({
            number: checkpointBlock - 28,
            blockHash: keccak256("target-block")
        });
        blocks[1] =
            AntseedBaseCheckpointOracle.CanonicalBlockRef({ number: checkpointBlock, blockHash: checkpointHash });

        journal = AntseedBaseCheckpointOracle.CheckpointJournal({
            ethereumCommitment: AntseedBaseCheckpointOracle.SteelCommitment({
                id: _beaconCommitmentId(ETHEREUM_TIMESTAMP),
                digest: BEACON_ROOT,
                configID: 0x47dc59f84afd2e9e7a48c4012004ab7c77fbd9acf822bf1143b8442c6c8851d4
            }),
            chainId: 8_453,
            anchorStateRegistry: 0x909f6cf47ed12f010A796527f562bFc26C7F4E72,
            game: 0xb7f2F804592cbF215112619a0ea6E4dE1280Bd75,
            intermediateRootIndex: 19,
            checkpointBlockNumber: checkpointBlock,
            checkpointBlockHash: checkpointHash,
            outputRoot: 0x8f641efa6c3c2b91d6d543af527c0a24176d32abb03f3f42b498d0165627c5ff,
            canonicalBlocks: blocks
        });
    }

    function _beaconCommitmentId(uint256 timestamp) internal pure returns (uint256) {
        return (uint256(1) << 240) | timestamp;
    }
}
