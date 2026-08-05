// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierPointsPolicy } from "../../verification/AntseedVerifierPointsPolicy.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../../verification/AntseedVerifierRewards.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract VerifierDeploymentIntegrationTest is Test {
    uint256 private constant GENESIS = 1_775_728_461;
    address private constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function test_directVerifierTopologyUsesRewardControllerWithoutTreasury() public {
        vm.warp(GENESIS + 8 days);
        AntseedRegistry registry = new AntseedRegistry();
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setIdentityRegistry(address(new MockERC8004Registry()));
        registry.setTeamWallet(address(0xA11CE));
        registry.setProtocolReserve(address(0xB0B));
        AntseedEmissionsGate gate =
            new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        AntseedVerifierRegistry verifierRegistry = new AntseedVerifierRegistry(address(registry), address(gate));
        AntseedVerifierRewards verifierRewards = new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        AntseedVerifierPointsPolicy pointsPolicy =
            new AntseedVerifierPointsPolicy(address(registry), address(verifierRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, address(verifierRewards), 10_000, true);

        assertEq(address(verifierRegistry.registry()), address(registry));
        assertEq(address(verifierRegistry.emissionsGate()), address(gate));
        assertEq(address(verifierRewards.verifierRegistry()), address(verifierRegistry));
        assertEq(address(verifierRewards.gate()), address(gate));
        assertEq(address(pointsPolicy.verifierRegistry()), address(verifierRegistry));
        (address controller, uint32 shareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, address(verifierRewards));
        assertEq(shareBps, 10_000);
    }
}
