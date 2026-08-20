// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { IRiscZeroVerifier } from "../interfaces/IRiscZeroVerifier.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

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
    bytes32 internal constant COORDINATED_IMAGE_ID = bytes32(uint256(3));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);
    address internal constant FUNDER = address(0xF00D);
    address internal constant BUYER_A = address(0x1001);
    address internal constant BUYER_B = address(0x1002);
    bytes32 internal constant FUNDER_COHORT_HASH = keccak256("funder-cohort");

    MockWashTradingVerifier internal verifier;
    MockWashTradingStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;
    AntseedWashTradingPointsPolicy internal policy;

    function setUp() public {
        verifier = new MockWashTradingVerifier();
        oracle = new MockWashTradingStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID, COORDINATED_IMAGE_ID
        );
        policy = new AntseedWashTradingPointsPolicy(address(registry));
    }

    function test_closedCycleAppliesSellerAndCaptiveBuyerPenalties() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        assertEq(registry.buyerPenaltyBps(BUYER_A), 9_000);
        assertTrue(registry.isSellerPenalized(SELLER_A));
        assertTrue(registry.isBuyerPenalized(BUYER_A));

        (uint16 sellerPenalty, uint16 buyerPenalty) = policy.penaltyBps(bytes32(0), BUYER_A, SELLER_A, 123);
        assertEq(sellerPenalty, 9_000);
        assertEq(buyerPenalty, 9_000);
    }

    function test_reciprocalUpdatesBothSellersAndOnlyProvenBuyer() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));
        (bool appliedA, bool appliedB) = registry.submitReciprocalProof(hex"", data);
        assertTrue(appliedA);
        assertTrue(appliedB);
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        assertEq(registry.sellerPenaltyBps(SELLER_B), 9_000);
        assertEq(registry.buyerPenaltyBps(journal.addressA), 9_000);
        assertEq(registry.buyerPenaltyBps(journal.addressB), 0);
    }

    function test_coordinatedControlAcceptsExactlyFiftyPercent() public {
        AntseedWashTradingRegistry.CoordinatedControlJournal memory journal = _coordinated();
        journal.qualifiedCohortVolumeRaw = 1_000_000_000;
        journal.sellerPeriodVolumeRaw = 2_000_000_000;
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(COORDINATED_IMAGE_ID, sha256(data));
        assertTrue(registry.submitCoordinatedControlProof(hex"", data));
    }

    function test_closedCycleAllowsSelfFundedSeller() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed();
        journal.funder = journal.seller;
        journal.claimId =
            _cohortClaimId(1, journal.seller, journal.funder, journal.cohortHash, journal.periodEndBlockExclusive);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        assertTrue(registry.submitClosedCycleProof(hex"", data));
    }

    function test_coordinatedControlRejectsOneUnitBelowFiftyPercent() public {
        AntseedWashTradingRegistry.CoordinatedControlJournal memory journal = _coordinated();
        journal.qualifiedCohortVolumeRaw = 999_999_999;
        journal.sellerPeriodVolumeRaw = 2_000_000_000;
        bytes memory data = abi.encode(journal);
        verifier.expect(COORDINATED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitCoordinatedControlProof(hex"", data);
    }

    function test_claimReplayIsIdempotentAndPenaltiesDoNotStack() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertFalse(registry.submitClosedCycleProof(hex"", data));

        AntseedWashTradingRegistry.CoordinatedControlJournal memory second = _coordinated();
        bytes memory secondData = abi.encode(second);
        verifier.expect(COORDINATED_IMAGE_ID, sha256(secondData));
        assertFalse(registry.submitCoordinatedControlProof(hex"", secondData));
        assertEq(registry.sellerPenaltyBps(SELLER_A), 9_000);
        assertEq(registry.buyerPenaltyBps(BUYER_A), 9_000);
    }

    function test_rejectsWrongClaimIdPeriodDuplicateBuyersAndWrongImage() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed();
        bytes memory data = abi.encode(journal);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));
        vm.expectRevert(bytes("wrong image"));
        registry.submitClosedCycleProof(hex"", data);

        journal.claimId = bytes32(uint256(99));
        data = abi.encode(journal);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);

        journal = _closed();
        journal.periodEndBlockExclusive -= 1;
        journal.claimId =
            _cohortClaimId(1, journal.seller, journal.funder, journal.cohortHash, journal.periodEndBlockExclusive);
        data = abi.encode(journal);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);

        journal = _closed();
        journal.penalizedBuyers = new address[](2);
        journal.penalizedBuyers[0] = BUYER_A;
        journal.penalizedBuyers[1] = BUYER_A;
        data = abi.encode(journal);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitClosedCycleProof(hex"", data);
    }

    function test_rejectsNonCanonicalAndUnsortedBlocks() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed();
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

    function _closed() internal view returns (AntseedWashTradingRegistry.ClosedCycleJournal memory journal) {
        address[] memory buyers = new address[](1);
        buyers[0] = BUYER_A;
        bytes32 cohortHash = keccak256(abi.encode(_cohortBuyers()));
        journal = AntseedWashTradingRegistry.ClosedCycleJournal({
            predicateVersion: 2,
            claimId: _cohortClaimId(1, SELLER_A, FUNDER, cohortHash, 49_936_173),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            seller: SELLER_A,
            funder: FUNDER,
            cohortHash: cohortHash,
            cohortCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            closureKind: 1,
            closurePathCount: 1,
            penaltyBps: 9_000,
            penalizedBuyers: buyers,
            blockRefs: _blocks()
        });
    }

    function _reciprocal() internal view returns (AntseedWashTradingRegistry.ReciprocalJournal memory journal) {
        address addressA = SELLER_A < SELLER_B ? SELLER_A : SELLER_B;
        address addressB = SELLER_A < SELLER_B ? SELLER_B : SELLER_A;
        address[] memory buyers = new address[](1);
        buyers[0] = addressA;
        journal = AntseedWashTradingRegistry.ReciprocalJournal({
            predicateVersion: 2,
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
            penaltyBps: 9_000,
            penalizedBuyers: buyers,
            blockRefs: _blocks()
        });
    }

    function _coordinated()
        internal
        view
        returns (AntseedWashTradingRegistry.CoordinatedControlJournal memory journal)
    {
        address[] memory buyers = new address[](1);
        buyers[0] = BUYER_A;
        bytes32 cohortHash = keccak256(abi.encode(_cohortBuyers()));
        journal = AntseedWashTradingRegistry.CoordinatedControlJournal({
            predicateVersion: 2,
            claimId: _coordinatedClaimId(SELLER_A, FUNDER_COHORT_HASH, cohortHash, 49_936_173),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            seller: SELLER_A,
            funderCohortHash: FUNDER_COHORT_HASH,
            funderCount: 2,
            cohortHash: cohortHash,
            cohortCount: 3,
            qualifiedCohortVolumeRaw: 1_000_000_000,
            sellerPeriodVolumeRaw: 2_000_000_000,
            penaltyBps: 9_000,
            penalizedBuyers: buyers,
            blockRefs: _blocks()
        });
    }

    function _coordinatedClaimId(address seller, bytes32 funderCohortHash, bytes32 cohortHash, uint64 endBlock)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(block.chainid, uint8(3), uint64(44_471_575), endBlock, seller, funderCohortHash, cohortHash)
        );
    }

    function _cohortClaimId(uint8 proofType, address seller, address funder, bytes32 cohortHash, uint64 endBlock)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, proofType, uint64(44_471_575), endBlock, seller, funder, cohortHash));
    }

    function _cohortBuyers() internal pure returns (address[] memory buyers) {
        buyers = new address[](3);
        buyers[0] = address(0x2001);
        buyers[1] = address(0x2002);
        buyers[2] = address(0x2003);
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
