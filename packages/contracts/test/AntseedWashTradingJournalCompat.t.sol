// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract AntseedWashTradingJournalCompatTest is Test {
    function test_cohortJournalAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });
        AntseedWashTradingRegistry.CohortJournal memory expected = AntseedWashTradingRegistry.CohortJournal({
            predicateVersion: 1,
            claimType: 2,
            claimId: bytes32(uint256(1)),
            reportRoot: bytes32(uint256(2)),
            seller: address(3),
            penaltyBps: 9_000,
            linkedBuyerCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            blockRefs: refs
        });
        AntseedWashTradingRegistry.CohortJournal memory decoded =
            abi.decode(abi.encode(expected), (AntseedWashTradingRegistry.CohortJournal));
        assertEq(decoded.claimId, expected.claimId);
        assertEq(decoded.reportRoot, expected.reportRoot);
        assertEq(decoded.qualifiedVolumeRaw, expected.qualifiedVolumeRaw);
        assertEq(decoded.blockRefs[0].blockHash, expected.blockRefs[0].blockHash);
    }

    function test_reciprocalJournalAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });
        AntseedWashTradingRegistry.ReciprocalJournal memory expected = AntseedWashTradingRegistry.ReciprocalJournal({
            predicateVersion: 1,
            claimId: bytes32(uint256(1)),
            reportRoot: bytes32(uint256(2)),
            sellerA: address(3),
            sellerB: address(4),
            penaltyBps: 9_000,
            settlementCount: 100,
            qualifiedVolumeRaw: 1_000_000,
            blockRefs: refs
        });
        AntseedWashTradingRegistry.ReciprocalJournal memory decoded =
            abi.decode(abi.encode(expected), (AntseedWashTradingRegistry.ReciprocalJournal));
        assertEq(decoded.sellerA, expected.sellerA);
        assertEq(decoded.sellerB, expected.sellerB);
        assertEq(decoded.settlementCount, expected.settlementCount);
    }
}
