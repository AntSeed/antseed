// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { AntseedRelayTreasury } from "../verification/AntseedRelayTreasury.sol";
import { AntseedVerifierPointsPolicy } from "../verification/AntseedVerifierPointsPolicy.sol";
import { AntseedVerifierRegistry } from "../verification/AntseedVerifierRegistry.sol";

/**
 * @title DeployVerifierNetwork
 * @notice Deploys reference-audit verification and the shared USDC relay
 *         treasury against an existing recognized-usage deployment.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Owner of the current UsageAccounting contract.
 *   ANTSEED_REGISTRY
 * Optional env:
 *   RELAY_MAX_PAYOUT_PER_JOB_USDC   Default 1 USDC (1e6 units).
 *   RELAY_MAX_PAYOUT_PER_AUDIT_USDC Default 50 USDC (50e6 units).
 *   RELAY_MAX_COMMITTED_BUDGET_PER_EPOCH_USDC Default 500 USDC (500e6 units).
 */
contract DeployVerifierNetwork is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        uint256 maxRelayPayoutPerJob = vm.envOr("RELAY_MAX_PAYOUT_PER_JOB_USDC", uint256(1e6));
        uint256 maxRelayPayoutPerAudit = vm.envOr("RELAY_MAX_PAYOUT_PER_AUDIT_USDC", uint256(50e6));
        uint256 maxCommittedBudgetPerEpoch = vm.envOr("RELAY_MAX_COMMITTED_BUDGET_PER_EPOCH_USDC", uint256(500e6));

        require(maxRelayPayoutPerJob <= type(uint96).max, "relay job cap too large");
        require(maxRelayPayoutPerAudit <= type(uint96).max, "relay audit cap too large");
        require(maxCommittedBudgetPerEpoch <= type(uint96).max, "relay epoch cap too large");

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address depositsAddress = registry.deposits();
        address usageAccountingAddress = registry.emissions();
        require(registryAddress.code.length != 0, "registry has no code");
        require(depositsAddress != address(0) && depositsAddress.code.length != 0, "registry deposits not set");
        require(
            usageAccountingAddress != address(0) && usageAccountingAddress.code.length != 0,
            "registry emissions not set"
        );
        require(
            registry.identityRegistry() != address(0) && registry.identityRegistry().code.length != 0,
            "identity registry not set"
        );

        address emissionsGateAddress = address(IAntseedUsageAccounting(usageAccountingAddress).emissionsGate());
        require(emissionsGateAddress != address(0) && emissionsGateAddress.code.length != 0, "emissions gate not set");
        require(
            address(IAntseedEmissionsGate(emissionsGateAddress).registry()) == registryAddress, "gate registry mismatch"
        );

        address usdc = IAntseedDeposits(depositsAddress).usdc();
        require(usdc != address(0) && usdc.code.length != 0, "USDC not set");

        (address legacyVerificationController, uint32 legacyVerificationShareBps,) =
            IAntseedEmissionsGate(emissionsGateAddress).minters(VERIFICATION_MINTER_ID);

        console.log("=== AntSeed Verifier Network Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("Registry:               ", registryAddress);
        console.log("UsageAccounting:        ", usageAccountingAddress);
        console.log("EmissionsGate:          ", emissionsGateAddress);
        console.log("USDC:                   ", usdc);
        console.log("Legacy verifier controller:", legacyVerificationController);
        console.log("Legacy verifier share bps: ", legacyVerificationShareBps);

        vm.startBroadcast(deployerPrivateKey);

        AntseedVerifierRegistry verifierRegistry = new AntseedVerifierRegistry(registryAddress, emissionsGateAddress);
        AntseedRelayTreasury relayTreasury = new AntseedRelayTreasury(
            usdc,
            address(verifierRegistry),
            uint96(maxRelayPayoutPerJob),
            uint96(maxRelayPayoutPerAudit),
            uint96(maxCommittedBudgetPerEpoch)
        );
        verifierRegistry.setRelayTreasury(address(relayTreasury));

        // Wire the new verifier into the existing usage-points path.
        AntseedVerifierPointsPolicy verifierPointsPolicy =
            new AntseedVerifierPointsPolicy(registryAddress, address(verifierRegistry));
        IAntseedUsageAccounting(usageAccountingAddress).setPointsPolicy(address(verifierPointsPolicy));

        vm.stopBroadcast();

        console.log("VerifierRegistry:       ", address(verifierRegistry));
        console.log("VerifierPointsPolicy:   ", address(verifierPointsPolicy));
        console.log("RelayTreasury:          ", address(relayTreasury));
        console.log("");
        console.log("POST-DEPLOY CHECKLIST (manual):");
        console.log("- Fund RelayTreasury with USDC before committing audits.");
        console.log("- Whitelist each validator with verifierRegistry.setVerifier.");
        console.log("- Transfer both Ownable2Step contracts to the ops multisig.");
        console.log("- Monitor treasury balance and payout-cap utilization.");
        console.log("- Do not rotate the reported legacy verifier controller until all old claims/remainders settle.");
    }
}
