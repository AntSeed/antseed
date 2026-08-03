// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { IAntseedLegacyVerifierRewards } from "../../interfaces/IAntseedLegacyVerifierRewards.sol";
import { AntseedVerifierRegistry } from "../../verification/AntseedVerifierRegistry.sol";

contract LegacyVerifierRewardsStub is IAntseedLegacyVerifierRewards {
    uint256 public settleCalls;
    mapping(uint256 epoch => bool settled) public override epochRemainderSettled;

    function claimVerifierReward(uint256) external { }
    function claimDelegateReward(uint256) external { }

    function pendingVerifierReward(uint256, address) external pure returns (uint256) {
        return 1;
    }

    function pendingDelegateReward(uint256, address) external pure returns (uint256) {
        return 1;
    }

    function settleEpochRemainder(uint256 epoch) external returns (uint256, uint256) {
        epochRemainderSettled[epoch] = true;
        settleCalls++;
        return (2, 3);
    }
}

contract VerifierDeploymentIntegrationTest is Test {
    bytes32 private constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function test_realUsageAccountingTopologyPassesExplicitGate() public {
        AntseedRegistry registry = _registry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(registry), 15_000, 25_000);
        AntseedUsageAccounting usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        registry.setEmissions(address(usageAccounting));

        AntseedVerifierRegistry verifierRegistry = new AntseedVerifierRegistry(address(registry), address(gate));
        assertEq(address(verifierRegistry.registry()), address(registry));
        assertEq(address(verifierRegistry.emissionsGate()), address(gate));
        assertEq(address(usageAccounting.emissionsGate()), address(gate));
        assertEq(registry.emissions(), address(usageAccounting));

        (address controller, uint32 shareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, address(0));
        assertEq(shareBps, 0);
    }

    function test_newVerifierDeploymentDoesNotMutateLegacyController() public {
        AntseedRegistry registry = _registry();
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(registry), 15_000, 25_000);
        LegacyVerifierRewardsStub legacyController = new LegacyVerifierRewardsStub();
        gate.setMinter(VERIFICATION_MINTER_ID, address(legacyController), 10_000, true);
        (address controllerBefore, uint32 shareBefore, bool editableBefore) = gate.minters(VERIFICATION_MINTER_ID);

        new AntseedVerifierRegistry(address(registry), address(gate));
        (address controllerAfter, uint32 shareAfter, bool editableAfter) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controllerAfter, controllerBefore);
        assertEq(shareAfter, shareBefore);
        assertEq(editableAfter, editableBefore);

        (uint256 burned, uint256 reserved) = legacyController.settleEpochRemainder(7);
        assertEq(burned, 2);
        assertEq(reserved, 3);
        assertTrue(legacyController.epochRemainderSettled(7));
    }

    function _registry() private returns (AntseedRegistry registry) {
        registry = new AntseedRegistry();
        registry.setAntsToken(address(new ANTSToken()));
        registry.setTeamWallet(address(0xA11CE));
        registry.setProtocolReserve(address(0xB0B));
    }
}
