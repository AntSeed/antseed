// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expectedVKey;
    bytes32 public expectedValuesHash;
    bytes32 public expectedProofHash;

    function expect(bytes32 vKey, bytes memory values, bytes memory proof) external {
        expectedVKey = vKey;
        expectedValuesHash = keccak256(values);
        expectedProofHash = keccak256(proof);
    }

    function verifyProof(bytes32 vKey, bytes calldata values, bytes calldata proof) external view {
        require(
            vKey == expectedVKey && keccak256(values) == expectedValuesHash && keccak256(proof) == expectedProofHash,
            "unexpected proof"
        );
    }
}

contract AntseedWashTradingRegistryTest is Test {
    bytes32 internal constant VKEY = bytes32(uint256(11));
    bytes32 internal constant REPORT_ROOT = bytes32(uint256(22));
    bytes32 internal constant MANIFEST_DIGEST = bytes32(uint256(33));
    address internal constant SELLER_A = address(0xA11CE);
    address internal constant SELLER_B = address(0xB0B);

    MockSP1Verifier internal verifier;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        verifier = new MockSP1Verifier();
        registry =
            new AntseedWashTradingRegistry(address(verifier), VKEY, REPORT_ROOT, MANIFEST_DIGEST, 100, 199, 2, 2, 700);
    }

    function test_acceptsOneCompleteHistoricalSnapshot() public {
        (bytes memory values, bytes memory proof) = _submission(300, 400, 700);
        verifier.expect(VKEY, values, proof);
        registry.submitHistoricalAggregate(values, proof);

        assertTrue(registry.historicalResultSubmitted());
        assertEq(registry.totalProvenWashVolume(), 700);
        assertEq(registry.provenWashVolume(SELLER_A), 300);
        assertEq(registry.provenWashVolume(SELLER_B), 400);
        assertTrue(registry.isProvenWashTrader(SELLER_A));
        assertEq(registry.blockReferenceCount(), 17);
    }

    function test_rejectsReplay() public {
        (bytes memory values, bytes memory proof) = _submission(300, 400, 700);
        verifier.expect(VKEY, values, proof);
        registry.submitHistoricalAggregate(values, proof);
        vm.expectRevert(AntseedWashTradingRegistry.HistoricalResultAlreadySubmitted.selector);
        registry.submitHistoricalAggregate(values, proof);
    }

    function test_rejectsWrongPinnedIdentity() public {
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(300, 400, 700);
        journal.reportRoot = bytes32(uint256(999));
        bytes memory values = abi.encode(journal);
        bytes memory proof = hex"1234";
        verifier.expect(VKEY, values, proof);
        vm.expectRevert(AntseedWashTradingRegistry.HistoricalIdentityMismatch.selector);
        registry.submitHistoricalAggregate(values, proof);
    }

    function test_rejectsWrongTotal() public {
        (bytes memory values, bytes memory proof) = _submission(300, 400, 699);
        verifier.expect(VKEY, values, proof);
        vm.expectRevert(AntseedWashTradingRegistry.HistoricalIdentityMismatch.selector);
        registry.submitHistoricalAggregate(values, proof);
    }

    function test_rejectsUnsortedSellers() public {
        AntseedWashTradingRegistry.AggregateJournal memory journal = _journal(300, 400, 700);
        (journal.sellers[0], journal.sellers[1]) = (journal.sellers[1], journal.sellers[0]);
        bytes memory values = abi.encode(journal);
        bytes memory proof = hex"1234";
        verifier.expect(VKEY, values, proof);
        vm.expectRevert(AntseedWashTradingRegistry.InvalidSellerResults.selector);
        registry.submitHistoricalAggregate(values, proof);
    }

    function test_rejectsTamperedProof() public {
        (bytes memory values, bytes memory proof) = _submission(300, 400, 700);
        verifier.expect(VKEY, values, proof);
        vm.expectRevert();
        registry.submitHistoricalAggregate(values, hex"ffff");
    }

    function _submission(uint128 volumeA, uint128 volumeB, uint128 total)
        internal
        pure
        returns (bytes memory values, bytes memory proof)
    {
        values = abi.encode(_journal(volumeA, volumeB, total));
        proof = hex"1234";
    }

    function _journal(uint128 volumeA, uint128 volumeB, uint128 total)
        internal
        pure
        returns (AntseedWashTradingRegistry.AggregateJournal memory journal)
    {
        AntseedWashTradingRegistry.SellerResult[] memory sellers = new AntseedWashTradingRegistry.SellerResult[](2);
        sellers[0] = AntseedWashTradingRegistry.SellerResult(SELLER_B, volumeB);
        sellers[1] = AntseedWashTradingRegistry.SellerResult(SELLER_A, volumeA);
        if (SELLER_A < SELLER_B) {
            (sellers[0], sellers[1]) = (sellers[1], sellers[0]);
        }
        journal = AntseedWashTradingRegistry.AggregateJournal({
            schemaVersion: 1,
            chainId: 8453,
            reportRoot: REPORT_ROOT,
            manifestDigest: MANIFEST_DIGEST,
            periodStartBlock: 100,
            periodEndBlock: 199,
            sourceClaimCount: 2,
            sellers: sellers,
            totalProvenWashVolume: total,
            blockReferenceCount: 17
        });
    }
}
