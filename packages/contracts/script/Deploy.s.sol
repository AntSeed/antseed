// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedChannels } from "../payments/AntseedChannels.sol";
import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { AntseedStats } from "../stats/AntseedStats.sol";
import { MockERC8004Registry } from "../test/mocks/MockERC8004Registry.sol";
import { MockUSDC } from "../test/mocks/MockUSDC.sol";
import { AntseedRelayTreasury } from "../verification/AntseedRelayTreasury.sol";
import { AntseedVerifierPointsPolicy } from "../verification/AntseedVerifierPointsPolicy.sol";
import { AntseedVerifierRegistry } from "../verification/AntseedVerifierRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys the current complete AntSeed topology to a fresh local chain.
 *         Existing-chain recognized-usage cutovers use DeployRecognizedUsage.s.sol.
 *
 * Usage:
 *   anvil &
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Deploy is Script {
    bytes32 public constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 public constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");

    struct Deployment {
        MockUSDC usdc;
        MockERC8004Registry identityRegistry;
        ANTSToken antsToken;
        AntseedRegistry registry;
        AntseedStaking legacyStaking;
        AntseedDeposits deposits;
        AntseedChannels channels;
        AntseedStats stats;
        AntseedSellerPools sellerPools;
        AntseedSellerRegistry sellerRegistry;
        AntseedEmissionsGate emissionsGate;
        AntseedVerifierRegistry verifierRegistry;
        AntseedRelayTreasury relayTreasury;
        AntseedUsageAccounting usageAccounting;
        AntseedVerifierPointsPolicy verifierPointsPolicy;
        AntseedSellerPoolsRewards sellerPoolsRewards;
        AntseedUsageRewards usageRewards;
    }

    function run() external returns (Deployment memory deployment) {
        uint256 deployerPrivateKey = vm.envOr(
            "DEPLOYER_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(deployerPrivateKey);
        address protocolReserve = vm.envOr("PROTOCOL_RESERVE", deployer);
        address teamWallet = vm.envOr("TEAM_WALLET", address(0xA11CE));
        require(teamWallet != protocolReserve, "team and reserve controllers must differ");
        uint256 maxRelayPayoutPerJob = vm.envOr("RELAY_MAX_PAYOUT_PER_JOB_USDC", uint256(1e6));
        uint256 maxRelayPayoutPerAudit = vm.envOr("RELAY_MAX_PAYOUT_PER_AUDIT_USDC", uint256(50e6));
        uint256 maxCommittedBudgetPerEpoch = vm.envOr("RELAY_MAX_COMMITTED_BUDGET_PER_EPOCH_USDC", uint256(500e6));
        require(maxRelayPayoutPerJob <= type(uint96).max, "relay job cap too large");
        require(maxRelayPayoutPerAudit <= type(uint96).max, "relay audit cap too large");
        require(maxCommittedBudgetPerEpoch <= type(uint96).max, "relay epoch cap too large");

        vm.startBroadcast(deployerPrivateKey);

        deployment.usdc = new MockUSDC();
        deployment.identityRegistry = new MockERC8004Registry();
        deployment.antsToken = new ANTSToken();
        deployment.registry = new AntseedRegistry();

        deployment.registry.setAntsToken(address(deployment.antsToken));
        deployment.registry.setIdentityRegistry(address(deployment.identityRegistry));
        deployment.registry.setProtocolReserve(protocolReserve);
        deployment.registry.setTeamWallet(teamWallet);

        deployment.legacyStaking = new AntseedStaking(address(deployment.usdc), address(deployment.registry));
        deployment.deposits = new AntseedDeposits(address(deployment.usdc));
        deployment.channels = new AntseedChannels(address(deployment.registry));
        deployment.stats = new AntseedStats();

        deployment.registry.setDeposits(address(deployment.deposits));
        deployment.registry.setChannels(address(deployment.channels));
        deployment.registry.setStats(address(deployment.stats));
        deployment.registry.setStaking(address(deployment.legacyStaking));
        deployment.deposits.setRegistry(address(deployment.registry));
        deployment.stats.setWriter(address(deployment.channels), true);

        deployment.sellerPools = new AntseedSellerPools(address(deployment.registry));
        deployment.sellerRegistry = new AntseedSellerRegistry(
            address(deployment.registry), address(deployment.sellerPools), address(deployment.legacyStaking)
        );
        deployment.emissionsGate = new AntseedEmissionsGate(address(deployment.registry), 15_000, 25_000);

        deployment.verifierRegistry =
            new AntseedVerifierRegistry(address(deployment.registry), address(deployment.emissionsGate));
        deployment.relayTreasury = new AntseedRelayTreasury(
            address(deployment.usdc),
            address(deployment.verifierRegistry),
            uint96(maxRelayPayoutPerJob),
            uint96(maxRelayPayoutPerAudit),
            uint96(maxCommittedBudgetPerEpoch)
        );
        deployment.verifierRegistry.setRelayTreasury(address(deployment.relayTreasury));

        deployment.usageAccounting = new AntseedUsageAccounting(
            address(deployment.sellerPools), address(deployment.channels), address(deployment.emissionsGate)
        );
        deployment.verifierPointsPolicy =
            new AntseedVerifierPointsPolicy(address(deployment.registry), address(deployment.verifierRegistry));
        deployment.usageAccounting.setPointsPolicy(address(deployment.verifierPointsPolicy));

        deployment.sellerPoolsRewards = new AntseedSellerPoolsRewards(
            address(deployment.emissionsGate), address(deployment.sellerPools), address(deployment.usageAccounting)
        );
        deployment.usageRewards = new AntseedUsageRewards(
            address(deployment.emissionsGate), address(deployment.registry), address(deployment.usageAccounting)
        );
        deployment.usageRewards.setSellerPools(address(deployment.sellerPools));
        deployment.usageAccounting.setUsageRewards(address(deployment.usageRewards));
        deployment.usageRewards.setClaimForwarder(address(deployment.usageAccounting));

        deployment.antsToken.setTransferWhitelist(address(deployment.sellerPools), true);
        deployment.antsToken.setTransferWhitelist(address(deployment.usageRewards), true);
        deployment.antsToken.setTransferWhitelist(address(deployment.sellerPoolsRewards), true);
        deployment.sellerPools.setRewardStaker(address(deployment.sellerPoolsRewards), true);
        deployment.emissionsGate.setMinter(SELLER_POOLS_MINTER_ID, address(deployment.sellerPoolsRewards), 40_000, true);
        deployment.emissionsGate.setMinter(USAGE_MINTER_ID, address(deployment.usageRewards), 20_000, true);

        deployment.antsToken.setRegistry(address(deployment.emissionsGate));
        deployment.registry.setEmissions(address(deployment.usageAccounting));
        deployment.registry.setStaking(address(deployment.sellerRegistry));

        vm.stopBroadcast();

        _assertWiring(deployment, protocolReserve, teamWallet);
        _logDeployment(deployment, deployer);
    }

    function _assertWiring(Deployment memory deployment, address protocolReserve, address teamWallet) internal view {
        require(deployment.registry.antsToken() == address(deployment.antsToken), "ANTS registry mismatch");
        require(
            deployment.registry.identityRegistry() == address(deployment.identityRegistry), "identity registry mismatch"
        );
        require(deployment.registry.protocolReserve() == protocolReserve, "protocol reserve mismatch");
        require(deployment.registry.teamWallet() == teamWallet, "team wallet mismatch");
        require(deployment.registry.deposits() == address(deployment.deposits), "deposits mismatch");
        require(deployment.registry.channels() == address(deployment.channels), "channels mismatch");
        require(deployment.registry.stats() == address(deployment.stats), "stats mismatch");
        require(deployment.registry.staking() == address(deployment.sellerRegistry), "seller registry mismatch");
        require(deployment.registry.emissions() == address(deployment.usageAccounting), "usage accounting mismatch");
        require(address(deployment.deposits.registry()) == address(deployment.registry), "deposits registry mismatch");
        require(deployment.stats.writers(address(deployment.channels)), "channels not stats writer");
        require(
            address(deployment.sellerRegistry.legacyStaking()) == address(deployment.legacyStaking),
            "legacy staking mismatch"
        );
        require(
            address(deployment.verifierRegistry.emissionsGate()) == address(deployment.emissionsGate),
            "verifier gate mismatch"
        );
        require(
            deployment.verifierRegistry.relayTreasury() == address(deployment.relayTreasury), "relay treasury mismatch"
        );
        require(
            address(deployment.usageAccounting.pointsPolicy()) == address(deployment.verifierPointsPolicy),
            "points policy mismatch"
        );
        require(
            address(deployment.usageAccounting.usageRewards()) == address(deployment.usageRewards),
            "usage rewards mismatch"
        );
        require(
            address(deployment.usageRewards.sellerPools()) == address(deployment.sellerPools),
            "usage seller pools mismatch"
        );
        require(
            deployment.usageRewards.claimForwarder() == address(deployment.usageAccounting), "claim forwarder mismatch"
        );
        require(deployment.antsToken.transferWhitelist(address(deployment.sellerPools)), "seller pools not whitelisted");
        require(
            deployment.antsToken.transferWhitelist(address(deployment.usageRewards)), "usage rewards not whitelisted"
        );
        require(
            deployment.antsToken.transferWhitelist(address(deployment.sellerPoolsRewards)),
            "seller rewards not whitelisted"
        );
        require(
            deployment.sellerPools.rewardStakers(address(deployment.sellerPoolsRewards)), "reward staker not approved"
        );
        require(address(deployment.emissionsGate.registry()) == address(deployment.registry), "gate registry mismatch");
    }

    function _logDeployment(Deployment memory deployment, address deployer) internal pure {
        console.log("=== AntSeed Fresh Deployment ===");
        console.log("Deployer:                 ", deployer);
        console.log("MockUSDC:                 ", address(deployment.usdc));
        console.log("MockERC8004Registry:      ", address(deployment.identityRegistry));
        console.log("ANTSToken:                ", address(deployment.antsToken));
        console.log("AntseedRegistry:          ", address(deployment.registry));
        console.log("LegacyStaking:            ", address(deployment.legacyStaking));
        console.log("Deposits:                 ", address(deployment.deposits));
        console.log("Channels:                 ", address(deployment.channels));
        console.log("Stats:                    ", address(deployment.stats));
        console.log("SellerPools:              ", address(deployment.sellerPools));
        console.log("SellerRegistry:           ", address(deployment.sellerRegistry));
        console.log("EmissionsGate:            ", address(deployment.emissionsGate));
        console.log("UsageAccounting:          ", address(deployment.usageAccounting));
        console.log("VerifierRegistry:         ", address(deployment.verifierRegistry));
        console.log("RelayTreasury:            ", address(deployment.relayTreasury));
        console.log("VerifierPointsPolicy:     ", address(deployment.verifierPointsPolicy));
        console.log("SellerPoolsRewards:       ", address(deployment.sellerPoolsRewards));
        console.log("UsageRewards:             ", address(deployment.usageRewards));
        console.log("Fresh-chain wiring assertions passed.");
    }
}
