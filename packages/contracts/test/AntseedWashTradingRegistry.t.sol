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

contract MockBaseAnalysisStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 blockNumber => bytes32 blockHash) public canonicalHash;

    function setCanonical(uint64 blockNumber, bytes32 blockHash) external {
        canonicalHash[blockNumber] = blockHash;
    }

    function isCanonicalBlock(uint64 blockNumber, bytes32 blockHash) external view returns (bool) {
        return canonicalHash[blockNumber] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant IMAGE_ID = bytes32(uint256(0xA11CE));
    bytes internal constant SEAL = hex"1234";
    address internal constant SELLER = address(0x515E12);
    address internal constant FUNDER = address(0xF00D);
    address internal constant BUYER = address(0xB0B);

    MockSellerPenaltyVerifier internal verifier;
    MockBaseAnalysisStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;
    AntseedWashTradingPointsPolicy internal policy;

    function setUp() public {
        verifier = new MockSellerPenaltyVerifier();
        oracle = new MockBaseAnalysisStateOracle();
        registry = new AntseedWashTradingRegistry(address(verifier), address(oracle), IMAGE_ID);
        policy = new AntseedWashTradingPointsPolicy(address(registry));
    }

    function test_acceptsAuthenticatedSellerPenalty() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);

        assertTrue(registry.submitSellerPenalty(SEAL, journalData));
        assertTrue(registry.isSellerPenalized(SELLER));
        assertEq(registry.sellerPenaltyBps(SELLER), 9_000);
        assertTrue(registry.consumedJournalDigests(sha256(journalData)));

        (uint16 sellerPenalty, uint16 buyerPenalty) = policy.penaltyBps(bytes32(0), BUYER, SELLER, 1 ether);
        assertEq(sellerPenalty, 9_000);
        assertEq(buyerPenalty, 0);
    }

    function test_exactReplayIsIdempotent() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);

        assertTrue(registry.submitSellerPenalty(SEAL, journalData));
        assertFalse(registry.submitSellerPenalty(hex"", journalData));
        assertEq(registry.sellerPenaltyBps(SELLER), 9_000);
    }

    function test_secondValidProofCannotIncreasePenalty() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory first = _journal();
        bytes memory firstData = abi.encode(first);
        _allow(first, firstData);
        assertTrue(registry.submitSellerPenalty(SEAL, firstData));

        AntseedWashTradingRegistry.SellerPenaltyJournal memory second = _journal();
        second.suspiciousVolumeRaw = 2_000_000_000;
        bytes memory secondData = abi.encode(second);
        _allow(second, secondData);
        assertFalse(registry.submitSellerPenalty(SEAL, secondData));
        assertTrue(registry.consumedJournalDigests(sha256(secondData)));
        assertEq(registry.sellerPenaltyBps(SELLER), 9_000);
    }

    function test_rejectsTooFewBuyers() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.linkedBuyerCount = 2;
        _expectInvalidJournal(journal);
    }

    function test_rejectsVolumeBelowThreshold() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.suspiciousVolumeRaw = 999_999_999;
        _expectInvalidJournal(journal);
    }

    function test_acceptsExactVolumeThreshold() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.suspiciousVolumeRaw = 1_000_000_000;
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);
        assertTrue(registry.submitSellerPenalty(SEAL, journalData));
    }

    function test_rejectsWrongPinnedConfiguration() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.chainId = 1;
        _expectInvalidJournal(journal);
    }

    function test_rejectsNonCanonicalBlock() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        bytes memory journalData = abi.encode(journal);
        oracle.setCanonical(journal.blockRefs[0].number, journal.blockRefs[0].blockHash);
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.NonCanonicalBlock.selector,
                journal.blockRefs[1].number,
                journal.blockRefs[1].blockHash
            )
        );
        registry.submitSellerPenalty(SEAL, journalData);
    }

    function test_rejectsDuplicateOrUnsortedBlockReferences() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.blockRefs[1].number = journal.blockRefs[0].number - 1;
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);

        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitSellerPenalty(SEAL, journalData);
    }

    function test_policyNeverPenalizesBuyer() public view {
        (uint16 sellerPenalty, uint16 buyerPenalty) = policy.penaltyBps(bytes32(0), BUYER, address(0xBAD), 1);
        assertEq(sellerPenalty, 0);
        assertEq(buyerPenalty, 0);
    }

    function test_acceptsRepresentativeBlockReferenceCount() public {
        AntseedWashTradingRegistry.SellerPenaltyJournal memory journal = _journal();
        journal.blockRefs = new AntseedWashTradingRegistry.BlockRef[](1_008);
        for (uint256 i = 0; i < journal.blockRefs.length; ++i) {
            journal.blockRefs[i] = AntseedWashTradingRegistry.BlockRef({
                number: uint64(1_000 + i),
                blockHash: keccak256(abi.encode("representative-block", i))
            });
        }
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);

        uint256 gasBefore = gasleft();
        assertTrue(registry.submitSellerPenalty(SEAL, journalData));
        emit log_named_uint("1,008-block submit execution gas", gasBefore - gasleft());
    }

    function _expectInvalidJournal(AntseedWashTradingRegistry.SellerPenaltyJournal memory journal) internal {
        bytes memory journalData = abi.encode(journal);
        _allow(journal, journalData);
        vm.expectRevert(AntseedWashTradingRegistry.InvalidProofJournal.selector);
        registry.submitSellerPenalty(SEAL, journalData);
    }

    function _allow(AntseedWashTradingRegistry.SellerPenaltyJournal memory journal, bytes memory journalData)
        internal
    {
        for (uint256 i = 0; i < journal.blockRefs.length; ++i) {
            oracle.setCanonical(journal.blockRefs[i].number, journal.blockRefs[i].blockHash);
        }
        verifier.expect(IMAGE_ID, sha256(journalData), SEAL);
    }

    function _journal() internal pure returns (AntseedWashTradingRegistry.SellerPenaltyJournal memory journal) {
        AntseedWashTradingRegistry.BlockRef[] memory blockRefs = new AntseedWashTradingRegistry.BlockRef[](2);
        blockRefs[0] = AntseedWashTradingRegistry.BlockRef({ number: 100, blockHash: keccak256("block-100") });
        blockRefs[1] = AntseedWashTradingRegistry.BlockRef({ number: 200, blockHash: keccak256("block-200") });
        journal = AntseedWashTradingRegistry.SellerPenaltyJournal({
            predicateVersion: 2,
            chainId: 8_453,
            usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            channels: 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d,
            deposits: 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2,
            seller: SELLER,
            funder: FUNDER,
            linkedBuyerCount: 3,
            hopCount: 2,
            penaltyBps: 9_000,
            sellerOutflowRaw: 1_100_000_000,
            totalFundedRaw: 1_050_000_000,
            suspiciousVolumeRaw: 1_000_000_000,
            earliestFundingBlock: 120,
            latestSettlementBlock: 190,
            blockRefs: blockRefs
        });
    }
}
