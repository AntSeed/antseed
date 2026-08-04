// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { AntseedVerifierPointsPolicy } from "../verification/AntseedVerifierPointsPolicy.sol";
import { AntseedVerifierRegistry } from "../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../verification/AntseedVerifierRewards.sol";

contract DeployVerifierNetwork is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address usageAccountingAddress = registry.emissions();
        require(registryAddress.code.length != 0, "registry has no code");
        require(
            usageAccountingAddress != address(0) && usageAccountingAddress.code.length != 0,
            "registry emissions not set"
        );
        require(
            registry.identityRegistry() != address(0) && registry.identityRegistry().code.length != 0,
            "identity registry not set"
        );

        AntseedEmissionsGate gate =
            AntseedEmissionsGate(address(IAntseedUsageAccounting(usageAccountingAddress).emissionsGate()));
        require(address(gate.registry()) == registryAddress, "gate registry mismatch");
        (address existingController, uint32 verificationShareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        require(existingController != address(0), "verification emissions bucket not configured");
        require(verificationShareBps != 0, "verification emissions bucket not configured");

        vm.startBroadcast(deployerPrivateKey);

        AntseedVerifierRegistry verifierRegistry = new AntseedVerifierRegistry(registryAddress, address(gate));
        AntseedVerifierRewards verifierRewards = new AntseedVerifierRewards(address(gate), address(verifierRegistry));
        AntseedVerifierPointsPolicy verifierPointsPolicy =
            new AntseedVerifierPointsPolicy(registryAddress, address(verifierRegistry));

        gate.setMinterController(VERIFICATION_MINTER_ID, address(verifierRewards));
        IAntseedUsageAccounting(usageAccountingAddress).setPointsPolicy(address(verifierPointsPolicy));

        vm.stopBroadcast();

        (address currentController, uint32 currentShareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        require(currentController == address(verifierRewards), "verifier rewards controller mismatch");
        require(currentShareBps == verificationShareBps, "verification share changed");

        console.log("=== AntSeed Direct Verifier Deployment ===");
        console.log("Registry:               ", registryAddress);
        console.log("UsageAccounting:        ", usageAccountingAddress);
        console.log("EmissionsGate:          ", address(gate));
        console.log("Previous controller:    ", existingController);
        console.log("Verification share bps: ", verificationShareBps);
        console.log("VerifierRegistry:       ", address(verifierRegistry));
        console.log("VerifierRewards:        ", address(verifierRewards));
        console.log("VerifierPointsPolicy:   ", address(verifierPointsPolicy));
        console.log("Whitelist verifiers with verifierRegistry.setVerifier(address, true).");
    }
}
