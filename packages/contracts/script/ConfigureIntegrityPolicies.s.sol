// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

/**
 * @notice Deploys or reuses the integrity policy leaves and optionally registers
 *         them in the recognized-usage points policy registry.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   POINTS_POLICY_REGISTRY
 *   WASH_TRADING_REGISTRY
 *   VERIFICATION
 *
 * Optional env:
 *   WASH_TRADING_POINTS_POLICY   Existing wash policy to reuse.
 *   VERIFICATION_POINTS_POLICY   Existing verification policy to reuse.
 *   REGISTER_WASH_POLICY         Defaults to true.
 *   REGISTER_VERIFICATION_POLICY Defaults to false (shadow mode).
 */
contract ConfigureIntegrityPolicies is Script {
    function run()
        external
        returns (
            AntseedWashTradingPointsPolicy washTradingPointsPolicy,
            AntseedVerificationPointsPolicy verificationPointsPolicy
        )
    {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address pointsPolicyRegistryAddress = vm.envAddress("POINTS_POLICY_REGISTRY");
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        address verificationAddress = vm.envAddress("VERIFICATION");
        address washPolicyAddress = vm.envOr("WASH_TRADING_POINTS_POLICY", address(0));
        address verificationPolicyAddress = vm.envOr("VERIFICATION_POINTS_POLICY", address(0));
        bool registerWashPolicy = vm.envOr("REGISTER_WASH_POLICY", true);
        bool registerVerificationPolicy = vm.envOr("REGISTER_VERIFICATION_POLICY", false);

        require(pointsPolicyRegistryAddress.code.length != 0, "points registry has no code");
        require(washTradingRegistry.code.length != 0, "wash registry has no code");
        require(verificationAddress.code.length != 0, "verification has no code");

        AntseedPointsPolicyRegistry pointsPolicyRegistry = AntseedPointsPolicyRegistry(pointsPolicyRegistryAddress);
        address protocolRegistryAddress = address(IAntseedVerification(verificationAddress).registry());
        require(protocolRegistryAddress.code.length != 0, "protocol registry has no code");

        if (washPolicyAddress != address(0)) {
            require(washPolicyAddress.code.length != 0, "wash policy has no code");
            washTradingPointsPolicy = AntseedWashTradingPointsPolicy(washPolicyAddress);
            _validateWashPolicy(washTradingPointsPolicy, washTradingRegistry);
        }
        if (verificationPolicyAddress != address(0)) {
            require(verificationPolicyAddress.code.length != 0, "verification policy has no code");
            verificationPointsPolicy = AntseedVerificationPointsPolicy(verificationPolicyAddress);
            _validateVerificationPolicy(
                verificationPointsPolicy, protocolRegistryAddress, verificationAddress
            );
        }

        bool needsWashRegistration = registerWashPolicy
            && (washPolicyAddress == address(0) || !pointsPolicyRegistry.isPolicyRegistered(washPolicyAddress));
        bool needsVerificationRegistration = registerVerificationPolicy
            && (
                verificationPolicyAddress == address(0)
                    || !pointsPolicyRegistry.isPolicyRegistered(verificationPolicyAddress)
            );
        if (needsWashRegistration || needsVerificationRegistration) {
            require(pointsPolicyRegistry.owner() == deployer, "deployer must own points registry");
        }

        vm.startBroadcast(deployerPrivateKey);
        if (address(washTradingPointsPolicy) == address(0)) {
            washTradingPointsPolicy = new AntseedWashTradingPointsPolicy(washTradingRegistry);
        }
        _validateWashPolicy(washTradingPointsPolicy, washTradingRegistry);

        if (address(verificationPointsPolicy) == address(0)) {
            verificationPointsPolicy =
                new AntseedVerificationPointsPolicy(deployer, protocolRegistryAddress, verificationAddress);
        }
        _validateVerificationPolicy(verificationPointsPolicy, protocolRegistryAddress, verificationAddress);

        if (registerWashPolicy && !pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy))) {
            pointsPolicyRegistry.registerPolicy(address(washTradingPointsPolicy));
        }
        if (
            registerVerificationPolicy
                && !pointsPolicyRegistry.isPolicyRegistered(address(verificationPointsPolicy))
        ) {
            pointsPolicyRegistry.registerPolicy(address(verificationPointsPolicy));
        }
        vm.stopBroadcast();

        bool washRegistered = pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy));
        bool verificationRegistered = pointsPolicyRegistry.isPolicyRegistered(address(verificationPointsPolicy));
        if (registerWashPolicy) require(washRegistered, "wash policy not registered");
        if (registerVerificationPolicy) require(verificationRegistered, "verification policy not registered");

        console.log("PointsPolicyRegistry:     ", pointsPolicyRegistryAddress);
        console.log("WashTradingRegistry:     ", washTradingRegistry);
        console.log("WashTradingPointsPolicy: ", address(washTradingPointsPolicy));
        console.log("Wash policy registered:  ", washRegistered);
        console.log("Verification:            ", verificationAddress);
        console.log("VerificationPointsPolicy:", address(verificationPointsPolicy));
        console.log("Verification registered: ", verificationRegistered);
        console.log("Verification threshold:  ", verificationPointsPolicy.minDistinctDiffVerifiers());
        console.log("Verification penalty BPS:", verificationPointsPolicy.diffPenaltyBps());
    }

    function _validateWashPolicy(AntseedWashTradingPointsPolicy policy, address washTradingRegistry) private view {
        require(policy.configurationFinalized(), "wash penalty calibration unfinished");
        require(address(policy.washTradingStatus()) == washTradingRegistry, "wash registry mismatch");
    }

    function _validateVerificationPolicy(
        AntseedVerificationPointsPolicy policy,
        address protocolRegistry,
        address verification
    ) private view {
        require(address(policy.registry()) == protocolRegistry, "protocol registry mismatch");
        require(address(policy.verificationStatus()) == verification, "verification mismatch");
    }
}
