// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";

contract MockWashTradingVerifier is IRiscZeroVerifier {
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

contract MockWashTradingStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 => bytes32) public canonicalHash;

    function setCanonical(uint64 number, bytes32 blockHash) external {
        canonicalHash[number] = blockHash;
    }

    function isCanonicalBlock(uint64 number, bytes32 blockHash) external view returns (bool) {
        return canonicalHash[number] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant CLOSED_IMAGE_ID = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_IMAGE_ID = bytes32(uint256(2));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);
    address internal constant FUNDER = address(0xF00D);

    MockWashTradingVerifier internal verifier;
    MockWashTradingStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        verifier = new MockWashTradingVerifier();
        oracle = new MockWashTradingStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID
        );
    }

    function test_closedCycleRecordsSellerP0() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A, FUNDER, bytes32("cohort-a"));
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertTrue(registry.isSellerP0(SELLER_A));
        assertEq(registry.sellerProofTypeMask(SELLER_A), 1);
    }

    function test_closedCycleAcceptsMeasuredFlashBlockCount() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A, FUNDER, bytes32("flash"));
        journal.blockRefs = new AntseedWashTradingRegistry.BlockRef[](990);
        for (uint256 index = 0; index < journal.blockRefs.length; ++index) {
            uint64 number = uint64(44_500_000 + index);
            journal.blockRefs[index] = AntseedWashTradingRegistry.BlockRef({
                number: number,
                blockHash: bytes32(uint256(number))
            });
        }
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertTrue(registry.isSellerP0(SELLER_A));
    }

    function test_reciprocalRecordsBothSellersP0() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));

        (bool recordedA, bool recordedB) = registry.submitReciprocalProof(hex"", data);
        assertTrue(recordedA);
        assertTrue(recordedB);
        assertTrue(registry.isSellerP0(journal.addressA));
        assertTrue(registry.isSellerP0(journal.addressB));
        assertEq(registry.sellerProofTypeMask(journal.addressA), 2);
        assertEq(registry.sellerProofTypeMask(journal.addressB), 2);
    }

    function test_duplicateAndDifferentlyOrderedSubmissionsKeepP0Flags() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory first = _closed(SELLER_A, FUNDER, bytes32("cohort-a"));
        bytes memory firstData = abi.encode(first);
        _allow(first.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(firstData));
        assertTrue(registry.submitClosedCycleProof(hex"", firstData));
        assertFalse(registry.submitClosedCycleProof(hex"", firstData));

        AntseedWashTradingRegistry.ReciprocalJournal memory reciprocal = _reciprocal();
        bytes memory reciprocalData = abi.encode(reciprocal);
        _allow(reciprocal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(reciprocalData));
        (bool recordedA, bool recordedB) = registry.submitReciprocalProof(hex"", reciprocalData);
        assertTrue(recordedA);
        assertTrue(recordedB);
        assertEq(registry.sellerProofTypeMask(SELLER_A), 3);

        AntseedWashTradingRegistry.ClosedCycleJournal memory second = _closed(SELLER_B, FUNDER, bytes32("cohort-b"));
        bytes memory secondData = abi.encode(second);
        _allow(second.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(secondData));
        assertTrue(registry.submitClosedCycleProof(hex"", secondData));
        assertEq(registry.sellerProofTypeMask(SELLER_B), 3);
    }

    function test_reciprocalRequiresEightyPercentVolumeReciprocity() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory boundary = _reciprocal();
        boundary.volumeAToBRaw = 12_500_000;
        boundary.volumeBToARaw = 10_000_000;
        bytes memory boundaryData = abi.encode(boundary);
        _allow(boundary.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(boundaryData));
        registry.submitReciprocalProof(hex"", boundaryData);

        AntseedWashTradingRegistry.ReciprocalJournal memory below = _reciprocal();
        below.volumeAToBRaw = 12_500_001;
        below.volumeBToARaw = 10_000_000;
        bytes memory belowData = abi.encode(below);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(belowData));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitReciprocalProof(hex"", belowData);
    }

    function test_closedCycleSupportsSelfFundedSeller() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A, SELLER_A, bytes32("self"));
        journal.closureKind = 3;
        journal.closurePathCount = 3;
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertTrue(registry.isSellerP0(SELLER_A));
    }

    function test_closedCycleRejectsWrongClosureAndThreshold() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A, FUNDER, bytes32("invalid"));
        journal.closureKind = 3;
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);

        journal = _closed(SELLER_A, FUNDER, bytes32("low-volume"));
        journal.qualifiedVolumeRaw = 999_999_999;
        data = abi.encode(journal);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);
    }

    function test_rejectsNonCanonicalAndUnsortedBlockReferences() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A, FUNDER, bytes32("blocks"));
        bytes memory data = abi.encode(journal);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.NonCanonicalBlock.selector,
                journal.blockRefs[0].number,
                journal.blockRefs[0].blockHash
            )
        );
        registry.submitClosedCycleProof(hex"", data);

        journal.blockRefs = new AntseedWashTradingRegistry.BlockRef[](2);
        journal.blockRefs[0] = AntseedWashTradingRegistry.BlockRef({ number: 101, blockHash: bytes32(uint256(101)) });
        journal.blockRefs[1] = AntseedWashTradingRegistry.BlockRef({ number: 100, blockHash: bytes32(uint256(100)) });
        data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);
    }

    function _closed(address seller, address funder, bytes32 cohortHash)
        internal
        view
        returns (AntseedWashTradingRegistry.ClosedCycleJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.ClosedCycleJournal({
            predicateVersion: 3,
            claimId: keccak256(
                abi.encode(
                    block.chainid,
                    uint8(1),
                    uint64(44_471_575),
                    uint64(49_936_173),
                    seller,
                    funder,
                    cohortHash
                )
            ),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            seller: seller,
            funder: funder,
            cohortHash: cohortHash,
            cohortCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            closureKind: 1,
            closurePathCount: 1,
            blockRefs: _blocks()
        });
    }

    function _reciprocal() internal view returns (AntseedWashTradingRegistry.ReciprocalJournal memory journal) {
        address addressA = SELLER_A < SELLER_B ? SELLER_A : SELLER_B;
        address addressB = SELLER_A < SELLER_B ? SELLER_B : SELLER_A;
        journal = AntseedWashTradingRegistry.ReciprocalJournal({
            predicateVersion: 3,
            claimId: keccak256(
                abi.encode(block.chainid, uint8(2), uint64(44_471_575), uint64(49_936_173), addressA, addressB)
            ),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            addressA: addressA,
            addressB: addressB,
            settlementCountAToB: 90,
            settlementCountBToA: 10,
            volumeAToBRaw: 10_000_000,
            volumeBToARaw: 10_000_000,
            blockRefs: _blocks()
        });
    }

    function _blocks() internal pure returns (AntseedWashTradingRegistry.BlockRef[] memory refs) {
        refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 100, blockHash: bytes32(uint256(100)) });
    }

    function _allow(AntseedWashTradingRegistry.BlockRef[] memory refs) internal {
        for (uint256 index = 0; index < refs.length; ++index) {
            oracle.setCanonical(refs[index].number, refs[index].blockHash);
        }
    }
}
