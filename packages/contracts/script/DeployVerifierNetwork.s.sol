// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedVerifierRegistry } from "../verification/AntseedVerifierRegistry.sol";
import { AntseedVerifierRewards } from "../verification/AntseedVerifierRewards.sol";
import { IAntseedRegistryV2 } from "../interfaces/IAntseedRegistryV2.sol";

/**
 * @title DeployVerifierNetwork
 * @notice Deploys the verifier network (AntseedVerifierRegistry +
 *         AntseedVerifierRewards) against an ALREADY-deployed emissions gate
 *         and v2 registry, replacing the current verification bucket
 *         controller.
 *
 *         The controller flip (`gate.setMinterController`) belongs to the
 *         gate owner and only runs when SET_MINTER_CONTROLLER=true; otherwise
 *         the exact call for the gate owner is printed.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Broadcaster key (becomes VerifierRegistry owner).
 *   ANTSEED_REGISTRY_V2    Deployed AntseedRegistryV2 address.
 *   EMISSIONS_GATE         Deployed AntseedEmissionsGate address.
 *
 * Optional env:
 *   SET_MINTER_CONTROLLER  true = the broadcaster is the gate owner and the
 *                          verification bucket controller is flipped in this
 *                          broadcast. Default false: print the call instead.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployVerifierNetwork.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployVerifierNetwork is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryV2Address = vm.envAddress("ANTSEED_REGISTRY_V2");
        address gateAddress = vm.envAddress("EMISSIONS_GATE");
        bool setMinterController = vm.envOr("SET_MINTER_CONTROLLER", false);

        IAntseedRegistryV2 registryV2 = IAntseedRegistryV2(registryV2Address);
        AntseedEmissionsGate gate = AntseedEmissionsGate(gateAddress);
        require(registryV2.identityRegistry() != address(0), "identity registry not set");
        require(registryV2.emissions() != address(0), "registry emissions not set");
        // claimDelegateCredits staticcalls registry.deposits() for the buyer's
        // operator; an unset deposits address makes every claim revert on a
        // codeless call.
        require(registryV2.deposits() != address(0), "registry deposits not set");
        // The gate and the verifier registry MUST share one registry —
        // mismatched registries silently cross ownership, operator, and
        // reserve boundaries between two protocol deployments.
        require(address(gate.registry()) == registryV2Address, "gate registry mismatch");
        (address currentController, uint32 shareBps,) = gate.minters(VERIFICATION_MINTER_ID);
        require(currentController != address(0), "verification bucket not configured");

        console.log("=== AntSeed Verifier Network Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("RegistryV2:             ", registryV2Address);
        console.log("EmissionsGate:          ", gateAddress);
        console.log("Current bucket minter:  ", currentController);
        console.log("Bucket share (bps/1e5): ", shareBps);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        AntseedVerifierRegistry verifierRegistry = new AntseedVerifierRegistry(registryV2Address);
        console.log("VerifierRegistry:       ", address(verifierRegistry));

        AntseedVerifierRewards verifierRewards = new AntseedVerifierRewards(gateAddress, address(verifierRegistry));
        console.log("VerifierRewards:        ", address(verifierRewards));

        if (currentController != address(verifierRewards)) {
            console.log("");
            console.log("!!! WARNING: the verification bucket is currently controlled by");
            console.log("!!!   ", currentController);
            console.log("!!! Flipping the controller DELETES that controller's minter binding");
            console.log("!!! in the gate: every reward not yet claimed through it is STRANDED");
            console.log("!!! (its gate.claim reverts NotEmissionMinter; untouched epochs freeze");
            console.log("!!! a zero budget). Settle ALL pending claims and epoch remainders on");
            console.log("!!! the old controller BEFORE the flip.");
            console.log("");
        }

        if (setMinterController) {
            gate.setMinterController(VERIFICATION_MINTER_ID, address(verifierRewards));
            console.log("Verification bucket controller flipped to VerifierRewards");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== Verifier network deployment complete ===");
        if (!setMinterController) {
            console.log("GATE OWNER ACTION REQUIRED - flip the bucket controller:");
            console.log("  gate.setMinterController(");
            console.log("    keccak256(\"antseed.emissions.verification.v1\"),");
            console.log("    ", address(verifierRewards));
            console.log("  )");
            console.log("  cast calldata example:");
            console.log(
                "  cast send %s \"setMinterController(bytes32,address)\" %s %s",
                gateAddress,
                vm.toString(VERIFICATION_MINTER_ID),
                address(verifierRewards)
            );
        }
        console.log("");
        console.log("POST-DEPLOY CHECKLIST (manual):");
        console.log("- The deployer EOA owns AntseedVerifierRegistry. Transfer ownership");
        console.log("  to the ops multisig (Ownable2Step: transferOwnership + accept).");
        console.log("- Whitelist each approved verifier peer:");
        console.log("  verifierRegistry.setVerifier(<verifier>, true)");
        console.log("- Verifier rewards only accrue from the NEXT finalized epoch after");
        console.log("  the controller flip. The flip does NOT preserve the previous");
        console.log("  controller's claims: the gate deletes its minter binding, so any");
        console.log("  rewards still unclaimed through it become unmintable. Drain the old");
        console.log("  controller (claims + settleEpochRemainder) before flipping.");
        console.log("- Zero-credit finalized epochs should be settled via");
        console.log("  verifierRewards.settleEpochRemainder(epoch) to route the bucket");
        console.log("  through burn/reserve.");
        // NOTE: To shape recognized-usage points by verification standing,
        // the UsageAccounting owner may deploy AntseedVerifierPointsPolicy
        // (constructor: registryV2 + verifierRegistry) and wire it via
        // `UsageAccounting.setPointsPolicy(address)`. Like the
        // SET_MINTER_CONTROLLER pattern above, that wiring is an owner
        // action behind its own env flag in a follow-up script — it is
        // deliberately NOT force-set in this broadcast.
        console.log("- Optional: deploy AntseedVerifierPointsPolicy and have the");
        console.log("  UsageAccounting owner wire it via setPointsPolicy(address) to");
        console.log("  cut seller emissions for DIFF-flagged sellers.");
    }
}
