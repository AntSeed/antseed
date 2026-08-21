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
        return blockHash != bytes32(0) && canonicalHash[number] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant CLOSED_IMAGE_ID = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_IMAGE_ID = bytes32(uint256(2));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);

    MockWashTradingVerifier internal verifier;
    MockWashTradingStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        vm.chainId(8_453);
        verifier = new MockWashTradingVerifier();
        oracle = new MockWashTradingStateOracle();
        registry =
            new AntseedWashTradingRegistry(address(verifier), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID);
    }

    function test_closedCycleFlagsSellerFromMinimalJournal() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertTrue(registry.isSellerWashTradingFlagged(SELLER_A));
    }

    function test_reciprocalFlagsBothSellersFromMinimalJournal() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));

        (bool recordedA, bool recordedB) = registry.submitReciprocalProof(hex"", data);
        assertTrue(recordedA);
        assertTrue(recordedB);
        assertTrue(registry.isSellerWashTradingFlagged(journal.addressA));
        assertTrue(registry.isSellerWashTradingFlagged(journal.addressB));
    }

    function test_replaysAndOverlappingProofsAreIdempotent() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory closed = _closed(SELLER_A);
        bytes memory closedData = abi.encode(closed);
        _allow(closed.blockRefs);
        verifier.expect(CLOSED_IMAGE_ID, sha256(closedData));
        assertTrue(registry.submitClosedCycleProof(hex"", closedData));
        assertFalse(registry.submitClosedCycleProof(hex"", closedData));

        AntseedWashTradingRegistry.ReciprocalJournal memory reciprocal = _reciprocal();
        bytes memory reciprocalData = abi.encode(reciprocal);
        _allow(reciprocal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(reciprocalData));
        (bool recordedA, bool recordedB) = registry.submitReciprocalProof(hex"", reciprocalData);

        if (reciprocal.addressA == SELLER_A) {
            assertFalse(recordedA);
            assertTrue(recordedB);
        } else {
            assertTrue(recordedA);
            assertFalse(recordedB);
        }
        assertTrue(registry.isSellerWashTradingFlagged(SELLER_A));
        assertTrue(registry.isSellerWashTradingFlagged(SELLER_B));
    }

    function test_rejectsNonCanonicalBlockReference() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A);
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
    }

    function test_rejectsReceiptForWrongPinnedImage() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_IMAGE_ID, sha256(data));

        vm.expectRevert("wrong image");
        registry.submitClosedCycleProof(hex"", data);
        assertFalse(registry.isSellerWashTradingFlagged(SELLER_A));
    }

    function test_constructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.WrongChain.selector, uint256(1)));
        new AntseedWashTradingRegistry(address(verifier), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID);
    }

    function test_constructorRejectsZeroConfiguration() public {
        vm.expectRevert(AntseedWashTradingRegistry.ZeroAddress.selector);
        new AntseedWashTradingRegistry(address(0), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID);

        vm.expectRevert(AntseedWashTradingRegistry.ZeroConfiguration.selector);
        new AntseedWashTradingRegistry(address(verifier), address(oracle), bytes32(0), RECIPROCAL_IMAGE_ID);
    }

    function test_constructorRejectsCodeLessDependencies() public {
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NoCode.selector, address(1)));
        new AntseedWashTradingRegistry(address(1), address(oracle), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID);

        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NoCode.selector, address(2)));
        new AntseedWashTradingRegistry(address(verifier), address(2), CLOSED_IMAGE_ID, RECIPROCAL_IMAGE_ID);
    }

    function _closed(address seller)
        internal
        pure
        returns (AntseedWashTradingRegistry.ClosedCycleJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.ClosedCycleJournal({ seller: seller, blockRefs: _blocks() });
    }

    function _reciprocal() internal pure returns (AntseedWashTradingRegistry.ReciprocalJournal memory journal) {
        address addressA = SELLER_A < SELLER_B ? SELLER_A : SELLER_B;
        address addressB = SELLER_A < SELLER_B ? SELLER_B : SELLER_A;
        journal = AntseedWashTradingRegistry.ReciprocalJournal({
            addressA: addressA,
            addressB: addressB,
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
