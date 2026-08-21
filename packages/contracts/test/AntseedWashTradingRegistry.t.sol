// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IBaseAnalysisStateOracle } from "../interfaces/IBaseAnalysisStateOracle.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockWashTradingVerifier is ISP1Verifier {
    bytes32 public expectedProgramVKey;
    bytes32 public expectedPublicValuesDigest;

    function expect(bytes32 programVKey, bytes32 publicValuesDigest) external {
        expectedProgramVKey = programVKey;
        expectedPublicValuesDigest = publicValuesDigest;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata) external view {
        require(programVKey == expectedProgramVKey, "wrong program vkey");
        require(sha256(publicValues) == expectedPublicValuesDigest, "wrong public values");
    }
}

contract MockWashTradingStateOracle is IBaseAnalysisStateOracle {
    mapping(uint64 => bytes32) public canonicalHash;
    bool public historicalCoverageComplete;

    function setCanonical(uint64 number, bytes32 blockHash) external {
        canonicalHash[number] = blockHash;
    }

    function isCanonicalBlock(uint64 number, bytes32 blockHash) external view returns (bool) {
        return blockHash != bytes32(0) && canonicalHash[number] == blockHash;
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant CLOSED_PROGRAM_VKEY = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_PROGRAM_VKEY = bytes32(uint256(2));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);

    MockWashTradingVerifier internal verifier;
    MockWashTradingStateOracle internal oracle;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        vm.chainId(8_453);
        verifier = new MockWashTradingVerifier();
        oracle = new MockWashTradingStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(oracle), CLOSED_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY
        );
    }

    function test_closedCycleFlagsSellerFromMinimalJournal() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(CLOSED_PROGRAM_VKEY, sha256(data));

        assertTrue(registry.submitClosedCycleProof(hex"", data));
        assertTrue(registry.isSellerWashTradingFlagged(SELLER_A));
    }

    function test_reciprocalFlagsBothSellersFromMinimalJournal() public {
        AntseedWashTradingRegistry.ReciprocalJournal memory journal = _reciprocal();
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_PROGRAM_VKEY, sha256(data));

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
        verifier.expect(CLOSED_PROGRAM_VKEY, sha256(closedData));
        assertTrue(registry.submitClosedCycleProof(hex"", closedData));
        assertFalse(registry.submitClosedCycleProof(hex"", closedData));

        AntseedWashTradingRegistry.ReciprocalJournal memory reciprocal = _reciprocal();
        bytes memory reciprocalData = abi.encode(reciprocal);
        _allow(reciprocal.blockRefs);
        verifier.expect(RECIPROCAL_PROGRAM_VKEY, sha256(reciprocalData));
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
        verifier.expect(CLOSED_PROGRAM_VKEY, sha256(data));

        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.NonCanonicalBlock.selector,
                journal.blockRefs[0].number,
                journal.blockRefs[0].blockHash
            )
        );
        registry.submitClosedCycleProof(hex"", data);
    }

    function test_rejectsProofForWrongPinnedProgramVKey() public {
        AntseedWashTradingRegistry.ClosedCycleJournal memory journal = _closed(SELLER_A);
        bytes memory data = abi.encode(journal);
        _allow(journal.blockRefs);
        verifier.expect(RECIPROCAL_PROGRAM_VKEY, sha256(data));

        vm.expectRevert("wrong program vkey");
        registry.submitClosedCycleProof(hex"", data);
        assertFalse(registry.isSellerWashTradingFlagged(SELLER_A));
    }

    function test_constructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.WrongChain.selector, uint256(1)));
        new AntseedWashTradingRegistry(address(verifier), address(oracle), CLOSED_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY);
    }

    function test_constructorRejectsZeroConfiguration() public {
        vm.expectRevert(AntseedWashTradingRegistry.ZeroAddress.selector);
        new AntseedWashTradingRegistry(address(0), address(oracle), CLOSED_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY);

        vm.expectRevert(AntseedWashTradingRegistry.ZeroConfiguration.selector);
        new AntseedWashTradingRegistry(address(verifier), address(oracle), bytes32(0), RECIPROCAL_PROGRAM_VKEY);
    }

    function test_constructorRejectsCodeLessDependencies() public {
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NoCode.selector, address(1)));
        new AntseedWashTradingRegistry(address(1), address(oracle), CLOSED_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY);

        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NoCode.selector, address(2)));
        new AntseedWashTradingRegistry(address(verifier), address(2), CLOSED_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY);
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
