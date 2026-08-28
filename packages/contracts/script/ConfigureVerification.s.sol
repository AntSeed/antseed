// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedVerification } from "../verification/AntseedVerification.sol";

/**
 * @notice Deploys or reuses the verification rewards contract and its points
 *         policy, transfers the existing verification emission bucket to the
 *         rewards contract, and optionally registers the points policy.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY
 *   EMISSIONS_GATE
 *   POINTS_POLICY_REGISTRY
 *
 * Optional env:
 *   VERIFICATION                    Existing verification contract to reuse.
 *   VERIFICATION_POINTS_POLICY      Existing verification policy to reuse.
 *   REGISTER_VERIFICATION_POLICY    Defaults to false (shadow mode).
 */
contract ConfigureVerification is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    uint32 public constant VERIFICATION_SHARE_BPS = 10_000;

    function run()
        external
        returns (AntseedVerification verification, AntseedVerificationPointsPolicy verificationPointsPolicy)
    {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");
        address emissionsGateAddress = vm.envAddress("EMISSIONS_GATE");
        address pointsPolicyRegistryAddress = vm.envAddress("POINTS_POLICY_REGISTRY");
        address verificationAddress = vm.envOr("VERIFICATION", address(0));
        address verificationPolicyAddress = vm.envOr("VERIFICATION_POINTS_POLICY", address(0));
        bool registerVerificationPolicy = vm.envOr("REGISTER_VERIFICATION_POLICY", false);

        require(registryAddress.code.length != 0, "registry has no code");
        require(emissionsGateAddress.code.length != 0, "emissions gate has no code");
        require(pointsPolicyRegistryAddress.code.length != 0, "points registry has no code");

        AntseedEmissionsGate emissionsGate = AntseedEmissionsGate(emissionsGateAddress);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = AntseedPointsPolicyRegistry(pointsPolicyRegistryAddress);

        (address currentController, uint32 shareBps, bool editable) = emissionsGate.minters(VERIFICATION_MINTER_ID);
        require(currentController != address(0), "verification minter missing");
        require(shareBps == VERIFICATION_SHARE_BPS, "verification share mismatch");
        require(editable, "verification minter locked");

        if (verificationAddress != address(0)) {
            require(verificationAddress.code.length != 0, "verification has no code");
            verification = AntseedVerification(verificationAddress);
            _validateVerification(verification, registryAddress, emissionsGateAddress);
        }
        if (verificationPolicyAddress != address(0)) {
            require(verificationPolicyAddress.code.length != 0, "verification policy has no code");
            verificationPointsPolicy = AntseedVerificationPointsPolicy(verificationPolicyAddress);
            _validateVerificationPolicy(verificationPointsPolicy, registryAddress, verificationAddress);
        }

        bool needsControllerTransfer = verificationAddress == address(0) || currentController != verificationAddress;
        bool needsPolicyRegistration = registerVerificationPolicy
            && (
                verificationPolicyAddress == address(0)
                    || !pointsPolicyRegistry.isPolicyRegistered(verificationPolicyAddress)
            );
        if (needsControllerTransfer) require(emissionsGate.owner() == deployer, "deployer must own emissions gate");
        if (needsPolicyRegistration) {
            require(pointsPolicyRegistry.owner() == deployer, "deployer must own points registry");
        }

        vm.startBroadcast(deployerPrivateKey);
        if (address(verification) == address(0)) {
            verification = new AntseedVerification(registryAddress, emissionsGateAddress);
        }
        _validateVerification(verification, registryAddress, emissionsGateAddress);

        if (currentController != address(verification)) {
            emissionsGate.setMinterController(VERIFICATION_MINTER_ID, address(verification));
        }

        if (address(verificationPointsPolicy) == address(0)) {
            verificationPointsPolicy =
                new AntseedVerificationPointsPolicy(deployer, registryAddress, address(verification));
        }
        _validateVerificationPolicy(verificationPointsPolicy, registryAddress, address(verification));

        if (registerVerificationPolicy && !pointsPolicyRegistry.isPolicyRegistered(address(verificationPointsPolicy))) {
            pointsPolicyRegistry.registerPolicy(address(verificationPointsPolicy));
        }
        vm.stopBroadcast();

        (address finalController, uint32 finalShareBps,) = emissionsGate.minters(VERIFICATION_MINTER_ID);
        bool verificationRegistered = pointsPolicyRegistry.isPolicyRegistered(address(verificationPointsPolicy));
        require(finalController == address(verification), "verification controller not installed");
        require(finalShareBps == VERIFICATION_SHARE_BPS, "verification share changed");
        if (registerVerificationPolicy) require(verificationRegistered, "verification policy not registered");

        console.log("AntseedRegistry:          ", registryAddress);
        console.log("EmissionsGate:            ", emissionsGateAddress);
        console.log("PointsPolicyRegistry:     ", pointsPolicyRegistryAddress);
        console.log("Verification:             ", address(verification));
        console.log("VerificationPointsPolicy: ", address(verificationPointsPolicy));
        console.log("Verification registered:  ", verificationRegistered);
        console.log("Verification threshold:   ", verificationPointsPolicy.minDistinctDiffVerifiers());
        console.log("Verification penalty BPS: ", verificationPointsPolicy.diffPenaltyBps());
    }

    function _validateVerification(
        AntseedVerification verification,
        address registryAddress,
        address emissionsGateAddress
    ) private view {
        require(address(verification.registry()) == registryAddress, "verification registry mismatch");
        require(address(verification.emissionsGate()) == emissionsGateAddress, "verification gate mismatch");
    }

    function _validateVerificationPolicy(
        AntseedVerificationPointsPolicy policy,
        address registryAddress,
        address verificationAddress
    ) private view {
        require(address(policy.registry()) == registryAddress, "policy registry mismatch");
        require(address(policy.verificationStatus()) == verificationAddress, "verification policy mismatch");
    }
}
