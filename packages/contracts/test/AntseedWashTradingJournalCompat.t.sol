// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract AntseedWashTradingJournalCompatTest is Test {
    function test_journalsAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });

        AntseedWashTradingRegistry.ClosedCycleJournal memory closed =
            AntseedWashTradingRegistry.ClosedCycleJournal({ seller: address(3), blockRefs: refs });
        AntseedWashTradingRegistry.ClosedCycleJournal memory decodedClosed =
            abi.decode(abi.encode(closed), (AntseedWashTradingRegistry.ClosedCycleJournal));
        assertEq(decodedClosed.seller, closed.seller);
        assertEq(decodedClosed.blockRefs[0].blockHash, closed.blockRefs[0].blockHash);

        AntseedWashTradingRegistry.ReciprocalJournal memory reciprocal = AntseedWashTradingRegistry.ReciprocalJournal({
            addressA: address(3),
            addressB: address(4),
            blockRefs: refs
        });
        AntseedWashTradingRegistry.ReciprocalJournal memory decodedReciprocal =
            abi.decode(abi.encode(reciprocal), (AntseedWashTradingRegistry.ReciprocalJournal));
        assertEq(decodedReciprocal.addressA, reciprocal.addressA);
        assertEq(decodedReciprocal.addressB, reciprocal.addressB);
        assertEq(decodedReciprocal.blockRefs[0].number, reciprocal.blockRefs[0].number);
    }
}
