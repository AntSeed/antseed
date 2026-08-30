// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingEpochPolicy } from "../policies/AntseedWashTradingEpochPolicy.sol";

interface IPointsPolicyHost {
    function owner() external view returns (address);
    function pointsPolicy() external view returns (address);
    function setPointsPolicy(address policy) external;
}

contract RegisterWashTradingPointsPolicy is Script {
    function run() external returns (AntseedWashTradingEpochPolicy policy) {
        uint256 ownerPrivateKey = vm.envUint("EMISSIONS_OWNER_PRIVATE_KEY");
        address owner = vm.addr(ownerPrivateKey);
        IPointsPolicyHost emissions = IPointsPolicyHost(vm.envAddress("EMISSIONS_V2"));
        address washTradingRegistry = vm.envAddress("WASH_TRADING_REGISTRY");
        address sellerRegistry = vm.envAddress("SELLER_REGISTRY");

        require(emissions.owner() == owner, "private key is not emissions owner");
        require(washTradingRegistry != address(0), "wash trading registry is zero");
        require(sellerRegistry != address(0), "seller registry is zero");

        vm.startBroadcast(ownerPrivateKey);
        policy = new AntseedWashTradingEpochPolicy(owner, washTradingRegistry, sellerRegistry, address(emissions));
        emissions.setPointsPolicy(address(policy));
        vm.stopBroadcast();

        require(address(emissions.pointsPolicy()) == address(policy), "wash policy was not installed");
        require(address(policy.registry()) == washTradingRegistry, "wash registry pointer mismatch");
        require(address(policy.sellerRegistry()) == sellerRegistry, "seller registry pointer mismatch");

        console.log("EmissionsV2:            ", address(emissions));
        console.log("WashTradingRegistry:    ", washTradingRegistry);
        console.log("WashTradingEpochPolicy: ", address(policy));
    }
}
