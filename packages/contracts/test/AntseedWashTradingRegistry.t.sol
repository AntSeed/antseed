// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

contract MockSellerPenaltyVerifier is IRiscZeroVerifier {
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

contract MockBaseAnalysisStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 => bytes32) public canonicalHash;

    function setCanonical(uint64 number, bytes32 blockHash) external {
        canonicalHash[number] = blockHash;
    }

    function isCanonicalBlock(uint64 number, bytes32 blockHash) external view returns (bool) {
        return canonicalHash[number] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant COHORT_IMAGE_ID = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_IMAGE_ID = bytes32(uint256(2));
    bytes32 internal constant REPORT_ROOT = bytes32(uint256(3));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);
    MockSellerPenaltyVerifier internal verifier;
    MockBaseAnalysisStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        verifier = new MockSellerPenaltyVerifier();
        oracle = new MockBaseAnalysisStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(oracle), COHORT_IMAGE_ID, RECIPROCAL_IMAGE_ID, REPORT_ROOT
        );
    }

    function test_cohortP1AppliesNineThousandBpsAndNeverPenalizesBuyer() public {
        AntseedWashTradingRegistry.CohortJournal memory journal = _cohort(bytes32(uint256(10)), 2, SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(COHORT_IMAGE_ID, sha256(data));
        assertTrue(registry.submitCohortPenalty(hex"", data));
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        AntseedWashTradingPointsPolicy policy = new AntseedWashTradingPointsPolicy(address(registry));
        (uint16 sellerPenalty, uint16 buyerPenalty) = policy.penaltyBps(bytes32(0), SELLER_B, SELLER_A, 0);
        assertEq(sellerPenalty, 9_000);
        assertEq(buyerPenalty, 0);
    }

    function test_reciprocalUpdatesBothSellers() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal(bytes32(uint256(11)));
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));
        (bool appliedA, bool appliedB) = registry.submitReciprocalPenalty(hex"", data);
        assertTrue(appliedA);
        assertTrue(appliedB);
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        assertEq(registry.sellerPenaltyBps(SELLER_B), 9_000);
    }

    function test_reciprocalRejectsZeroAuthenticatedVolume() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal(bytes32(uint256(16)));
        journal.qualifiedVolumeRaw = 0;
        bytes memory data = abi.encode(journal);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitReciprocalPenalty(hex"", data);
    }

    function test_claimReplayIsIdempotent() public {
        AntseedWashTradingRegistry.CohortJournal memory journal = _cohort(bytes32(uint256(12)), 1, SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(COHORT_IMAGE_ID, sha256(data));
        assertTrue(registry.submitCohortPenalty(hex"", data));
        assertFalse(registry.submitCohortPenalty(hex"", data));
        assertTrue(registry.consumedClaimIds(journal.claimId));
    }

    function test_secondClaimUsesMaximumNotAddition() public {
        AntseedWashTradingRegistry.CohortJournal memory first = _cohort(bytes32(uint256(13)), 1, SELLER_A);
        bytes memory firstData = abi.encode(first);
        _allow(first.blockRefs);
        verifier.expect(COHORT_IMAGE_ID, sha256(firstData));
        assertTrue(registry.submitCohortPenalty(hex"", firstData));
        AntseedWashTradingRegistry.CohortJournal memory second = _cohort(bytes32(uint256(14)), 2, SELLER_A);
        bytes memory secondData = abi.encode(second);
        verifier.expect(COHORT_IMAGE_ID, sha256(secondData));
        assertFalse(registry.submitCohortPenalty(hex"", secondData));
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        assertTrue(registry.consumedClaimIds(second.claimId));
    }

    function test_rejectsWrongRootAndNonCanonicalBlock() public {
        AntseedWashTradingRegistry.CohortJournal memory journal = _cohort(bytes32(uint256(15)), 1, SELLER_A);
        journal.reportRoot = bytes32(uint256(99));
        bytes memory data = abi.encode(journal);
        verifier.expect(COHORT_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitCohortPenalty(hex"", data);

        journal.reportRoot = REPORT_ROOT;
        data = abi.encode(journal);
        verifier.expect(COHORT_IMAGE_ID, sha256(data));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.NonCanonicalBlock.selector, uint64(100), bytes32(uint256(100))
            )
        );
        registry.submitCohortPenalty(hex"", data);
    }

    function _cohort(bytes32 claimId, uint8 claimType, address seller)
        internal
        pure
        returns (AntseedWashTradingRegistry.CohortJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.CohortJournal({
            predicateVersion: 1,
            claimType: claimType,
            claimId: claimId,
            reportRoot: REPORT_ROOT,
            seller: seller,
            penaltyBps: 9_000,
            linkedBuyerCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            blockRefs: _blocks()
        });
    }

    function _reciprocal(bytes32 claimId)
        internal
        pure
        returns (AntseedWashTradingRegistry.ReciprocalJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.ReciprocalJournal({
            predicateVersion: 1,
            claimId: claimId,
            reportRoot: REPORT_ROOT,
            sellerA: SELLER_A,
            sellerB: SELLER_B,
            penaltyBps: 9_000,
            settlementCount: 100,
            qualifiedVolumeRaw: 1_000_000,
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
