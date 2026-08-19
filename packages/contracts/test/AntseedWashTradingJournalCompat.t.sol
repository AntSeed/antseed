// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

/// @notice Guards the Solidity ABI shape mirrored by loop-proof/core.
contract AntseedWashTradingJournalCompatTest is Test {
    function test_sellerPenaltyJournalAbiRoundTrip() public pure {
        AntseedWashTradingRegistry.BlockRef[] memory blockRefs = new AntseedWashTradingRegistry.BlockRef[](1);
        blockRefs[0] = AntseedWashTradingRegistry.BlockRef({ number: 123, blockHash: bytes32(uint256(456)) });
        AntseedWashTradingRegistry.SellerPenaltyJournal memory expected = AntseedWashTradingRegistry
            .SellerPenaltyJournal({
            predicateVersion: 2,
            chainId: 8_453,
            usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            channels: 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d,
            deposits: 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2,
            seller: address(0x515E12),
            funder: address(0xF00D),
            linkedBuyerCount: 3,
            hopCount: 2,
            penaltyBps: 9_000,
            sellerOutflowRaw: 1_100_000_000,
            totalFundedRaw: 1_050_000_000,
            suspiciousVolumeRaw: 1_000_000_000,
            earliestFundingBlock: 100,
            latestSettlementBlock: 200,
            blockRefs: blockRefs
        });

        bytes memory journalData = abi.encode(expected);
        AntseedWashTradingRegistry.SellerPenaltyJournal memory decoded =
            abi.decode(journalData, (AntseedWashTradingRegistry.SellerPenaltyJournal));

        assertEq(decoded.predicateVersion, expected.predicateVersion);
        assertEq(decoded.chainId, expected.chainId);
        assertEq(decoded.seller, expected.seller);
        assertEq(decoded.funder, expected.funder);
        assertEq(decoded.linkedBuyerCount, expected.linkedBuyerCount);
        assertEq(decoded.penaltyBps, expected.penaltyBps);
        assertEq(decoded.suspiciousVolumeRaw, expected.suspiciousVolumeRaw);
        assertEq(decoded.blockRefs.length, 1);
        assertEq(decoded.blockRefs[0].number, 123);
        assertEq(decoded.blockRefs[0].blockHash, bytes32(uint256(456)));
    }
}
