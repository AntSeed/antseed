// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { LocalProofE2EStateOracle } from "./mocks/LocalProofE2E.sol";

contract PassthroughVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure { }
}

contract LocalSP1ProofSubmissionE2ETest is Test {
    bytes32 internal constant CLOSED_LOOP_VKEY = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_VKEY = bytes32(uint256(2));
    address internal constant ADDRESS_A = address(0xB0B);
    address internal constant ADDRESS_B = address(0xA11CE);

    AntseedWashTradingRegistry internal registry;
    LocalProofE2EStateOracle internal stateOracle;

    function setUp() public {
        stateOracle = new LocalProofE2EStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(new PassthroughVerifier()), address(stateOracle), CLOSED_LOOP_VKEY, RECIPROCAL_VKEY
        );
    }

    function test_developmentManifestSubmissionUsesSP1PublicValues() public {
        uint64 blockNumber = 44_469_557;
        bytes32 blockHash = keccak256("local canonical Base block");
        stateOracle.setCanonical(blockNumber, blockHash);

        AntseedWashTradingRegistry.BlockRef[] memory blockRefs = new AntseedWashTradingRegistry.BlockRef[](1);
        blockRefs[0] = AntseedWashTradingRegistry.BlockRef({ number: blockNumber, blockHash: blockHash });

        AntseedWashTradingRegistry.SubjectRecord[] memory subjects =
            new AntseedWashTradingRegistry.SubjectRecord[](2);
        subjects[0] = AntseedWashTradingRegistry.SubjectRecord(ADDRESS_A, 5000e6, 10000e6);
        subjects[1] = AntseedWashTradingRegistry.SubjectRecord(ADDRESS_B, 3000e6, 8000e6);

        bytes memory publicValues = abi.encode(AntseedWashTradingRegistry.WashJournal({
            predicateId: 2,
            chainId: 8_453,
            periodStartBlock: 44_471_575,
            periodEndBlock: 49_936_172,
            claimId: keccak256("reciprocal-test"),
            subjects: subjects,
            blockRefs: blockRefs
        }));

        registry.submit(publicValues, hex"01");

        assertTrue(registry.isSellerWashTradingFlagged(ADDRESS_A));
        assertTrue(registry.isSellerWashTradingFlagged(ADDRESS_B));
        assertEq(registry.washRatioBps(ADDRESS_A), 5000);
        assertEq(registry.washRatioBps(ADDRESS_B), 3750);
    }
}
