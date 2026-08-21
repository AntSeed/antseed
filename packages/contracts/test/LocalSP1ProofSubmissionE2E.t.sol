// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { LocalProofE2EStateOracle, LocalProofE2EVerifier } from "./mocks/LocalProofE2E.sol";

contract LocalSP1ProofSubmissionE2ETest is Test {
    bytes32 internal constant CLOSED_CYCLE_PROGRAM_VKEY = bytes32(uint256(1));
    bytes32 internal constant RECIPROCAL_PROGRAM_VKEY = bytes32(uint256(2));
    address internal constant ADDRESS_A = address(0xB0B);
    address internal constant ADDRESS_B = address(0xA11CE);

    LocalProofE2EVerifier internal verifier;
    LocalProofE2EStateOracle internal stateOracle;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        vm.chainId(8_453);
        verifier = new LocalProofE2EVerifier();
        stateOracle = new LocalProofE2EStateOracle();
        registry = new AntseedWashTradingRegistry(
            address(verifier), address(stateOracle), CLOSED_CYCLE_PROGRAM_VKEY, RECIPROCAL_PROGRAM_VKEY
        );
    }

    function test_developmentManifestSubmissionUsesSP1PublicValues() public {
        uint64 blockNumber = 44_469_557;
        bytes32 blockHash = keccak256("local canonical Base block");
        stateOracle.setCanonical(blockNumber, blockHash);

        AntseedWashTradingRegistry.BlockRef[] memory blockRefs = new AntseedWashTradingRegistry.BlockRef[](1);
        blockRefs[0] = AntseedWashTradingRegistry.BlockRef({ number: blockNumber, blockHash: blockHash });
        bytes memory publicValues = abi.encode(
            AntseedWashTradingRegistry.ReciprocalJournal({
                addressA: ADDRESS_A,
                addressB: ADDRESS_B,
                blockRefs: blockRefs
            })
        );
        verifier.expect(RECIPROCAL_PROGRAM_VKEY, sha256(publicValues));

        (bool recordedA, bool recordedB) = registry.submitReciprocalProof(hex"01", publicValues);

        assertTrue(recordedA);
        assertTrue(recordedB);
        assertTrue(registry.isSellerWashTradingFlagged(ADDRESS_A));
        assertTrue(registry.isSellerWashTradingFlagged(ADDRESS_B));
    }
}
