// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistryV2 } from "../../core/AntseedRegistryV2.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

/**
 * @title AntseedVerifierRewardsFuzz
 * @notice Fuzz tests for the verification bucket controller. Invariants:
 *           1. Every claim equals the exact pro-rata share of the frozen
 *              epoch budget.
 *           2. The sum of all claims never exceeds the frozen budget, and the
 *              controller never mints past its gate bucket budget.
 *           3. Double-claim is impossible per (verifier, epoch).
 */
contract AntseedVerifierRewardsFuzzTest is Test {
    ANTSToken token;
    AntseedRegistryV2 registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identity;
    AntseedVerifierRegistry verifierRegistry;
    AntseedVerifierRewards verifierRewards;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address sellerOwner = address(0x51);

    bytes32 constant SERVICE_HASH = keccak256("model:gpt-99");
    bytes32 constant EVIDENCE_HASH = keccak256("evidence");
    uint256 commitSalt;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistryV2();
        identity = new MockERC8004Registry();
        registry.setAntsToken(address(token));
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setIdentityRegistry(address(identity));

        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(address(registry), 15_000, 15_000);
        token.setRegistry(address(gate));
        gate.fundLegacyEscrow(address(0xE5C0));

        verifierRegistry = new AntseedVerifierRegistry(address(registry));
        verifierRewards = new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verifierRewards), VERIFICATION_SHARE_BPS, true);
        registry.setEmissions(address(gate));

        _warpGateEpoch(5);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _credit(address verifier_, uint256 credits) internal {
        for (uint256 i = 0; i < credits; i++) {
            uint256 agentId = identity.register();
            identity.setOwner(agentId, sellerOwner);

            bytes32 commitment = keccak256(abi.encode(verifier_, ++commitSalt));
            vm.prank(verifier_);
            verifierRegistry.commitProbeSet(commitment);
            vm.warp(block.timestamp + 1);
            vm.prank(verifier_);
            verifierRegistry.submitAttestation(agentId, SERVICE_HASH, 1, EVIDENCE_HASH, commitment, 10, 3);
        }
    }

    /// @notice Pro-rata claims for arbitrary credit distributions: each claim
    ///         is exactly `budget * credits / totalCredits`, the sum of all
    ///         claims never exceeds the frozen budget, and the gate bucket is
    ///         never over-minted.
    function testFuzz_claimsNeverExceedFrozenBudget(uint8 countRaw, uint8[6] calldata creditsRaw) public {
        uint256 verifierCount = bound(uint256(countRaw), 1, 6);

        address[] memory verifiers = new address[](verifierCount);
        uint256[] memory credits = new uint256[](verifierCount);
        uint256 totalCredits;
        for (uint256 i = 0; i < verifierCount; i++) {
            verifiers[i] = address(uint160(0xF000 + i));
            credits[i] = bound(uint256(creditsRaw[i]), 0, 7);
            totalCredits += credits[i];
        }
        if (totalCredits == 0) {
            credits[0] = 1;
            totalCredits = 1;
        }

        for (uint256 i = 0; i < verifierCount; i++) {
            if (credits[i] == 0) continue;
            verifierRegistry.setVerifier(verifiers[i], true);
            _credit(verifiers[i], credits[i]);
        }
        assertEq(verifierRegistry.epochTotalCredits(5), totalCredits);

        _warpGateEpoch(6);
        uint256 budget = verifierRewards.verifierEpochBudget(5);
        assertEq(budget, gate.minterEpochBudget(VERIFICATION_MINTER_ID, 5));

        uint256 totalClaimed;
        for (uint256 i = 0; i < verifierCount; i++) {
            if (credits[i] == 0) continue;

            vm.prank(verifiers[i]);
            verifierRewards.claimVerifierReward(5);

            uint256 claimed = token.balanceOf(verifiers[i]);
            assertEq(claimed, (budget * credits[i]) / totalCredits, "claim is not exact pro-rata share");
            totalClaimed += claimed;

            vm.prank(verifiers[i]);
            vm.expectRevert(AntseedVerifierRewards.AlreadyClaimed.selector);
            verifierRewards.claimVerifierReward(5);
        }

        assertLe(totalClaimed, budget, "claims exceed frozen epoch budget");
        assertEq(verifierRewards.verifierEpochBudget(5), budget, "frozen budget drifted");
        assertLe(
            gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5),
            gate.minterEpochBudget(VERIFICATION_MINTER_ID, 5),
            "over minter budget"
        );
        assertEq(gate.minterEpochMinted(VERIFICATION_MINTER_ID, 5), totalClaimed, "gate accounting mismatch");
    }
}
