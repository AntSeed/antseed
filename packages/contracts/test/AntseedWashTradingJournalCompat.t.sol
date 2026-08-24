// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract AntseedWashTradingJournalCompatTest is Test {
    function test_journalAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory refs = new AntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });

        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](1);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(address(3), 1000e6, 2000e6);

        AntseedWashTradingRegistry.WashJournal memory journal = AntseedWashTradingRegistry.WashJournal({
            predicateId: 1,
            chainId: 8_453,
            periodStartBlock: 44_471_575,
            periodEndBlock: 49_936_172,
            claimId: keccak256("test"),
            subjects: subjects,
            blockRefs: refs
        });

        AntseedWashTradingRegistry.WashJournal memory decoded =
            abi.decode(abi.encode(journal), (AntseedWashTradingRegistry.WashJournal));

        assertEq(decoded.predicateId, journal.predicateId);
        assertEq(decoded.chainId, journal.chainId);
        assertEq(decoded.claimId, journal.claimId);
        assertEq(decoded.subjects[0].subject, journal.subjects[0].subject);
        assertEq(decoded.subjects[0].washVolume, journal.subjects[0].washVolume);
        assertEq(decoded.subjects[0].settledVolume, journal.subjects[0].settledVolume);
        assertEq(decoded.blockRefs[0].number, journal.blockRefs[0].number);
        assertEq(decoded.blockRefs[0].blockHash, journal.blockRefs[0].blockHash);
    }
}
