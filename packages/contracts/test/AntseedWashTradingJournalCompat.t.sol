// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract AntseedWashTradingJournalCompatTest is Test {
    function test_journalsAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });

        AntseedWashTradingRegistry.ClosedCycleJournal memory closed = AntseedWashTradingRegistry.ClosedCycleJournal({
            predicateVersion: 3,
            claimId: bytes32(uint256(1)),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            seller: address(3),
            funder: address(4),
            cohortHash: bytes32(uint256(5)),
            cohortCount: 3,
            qualifiedVolumeRaw: 1_000_000_000,
            closureKind: 1,
            closurePathCount: 1,
            blockRefs: refs
        });
        AntseedWashTradingRegistry.ClosedCycleJournal memory decodedClosed =
            abi.decode(abi.encode(closed), (AntseedWashTradingRegistry.ClosedCycleJournal));
        assertEq(decodedClosed.cohortHash, closed.cohortHash);

        AntseedWashTradingRegistry.ReciprocalJournal memory reciprocal = AntseedWashTradingRegistry.ReciprocalJournal({
            predicateVersion: 3,
            claimId: bytes32(uint256(1)),
            periodStartBlock: 44_471_575,
            periodEndBlockExclusive: 49_936_173,
            addressA: address(3),
            addressB: address(4),
            settlementCountAToB: 90,
            settlementCountBToA: 10,
            volumeAToBRaw: 10_000_000,
            volumeBToARaw: 10_000_000,
            blockRefs: refs
        });
        AntseedWashTradingRegistry.ReciprocalJournal memory decodedReciprocal =
            abi.decode(abi.encode(reciprocal), (AntseedWashTradingRegistry.ReciprocalJournal));
        assertEq(decodedReciprocal.volumeBToARaw, reciprocal.volumeBToARaw);
    }
}
