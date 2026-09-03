// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedLegacySellerClaimPolicy } from "../../../policies/AntseedLegacySellerClaimPolicy.sol";

interface IAntseedRegistryView {
    function emissions() external view returns (address);
}

interface ILegacyEmissionsV2View {
    function legacyEmissions() external view returns (address);
    function sellerRewardsPool() external view returns (address);
    function MIGRATION_EPOCH() external view returns (uint256);
    function currentEpoch() external view returns (uint256);
}

interface ISellerRewardsPoolAdmin {
    function owner() external view returns (address);
    function sellerClaimPolicy() external view returns (address);
    function totalLockedRewards() external view returns (uint256);
    function setSellerClaimPolicy(address policy) external;
}

interface IUsageAccountingView {
    function emissionsGate() external view returns (address);
}

interface IEmissionsGateView {
    function effectiveEpoch() external view returns (uint256);
}

/**
 * @title M002DeployLegacySellerClaims
 * @notice Unfreezes the deployed AntseedSellerRewardsPool by installing
 *         AntseedLegacySellerClaimPolicy as its seller claim policy.
 *
 *         Run only after M001 Cutover has flipped `registry.emissions()`
 *         away from legacy EmissionsV2: from that point on the last epoch
 *         that can still be locked into the pool is fixed
 *         (`gate.effectiveEpoch() - 1`), which the policy needs as an
 *         immutable scan bound.
 *
 *         The policy is stateless. It re-derives every seller's cumulative
 *         locked amount from EmissionsV2/V1 state, releases `RELEASE_BPS`
 *         of it (optionally linearly vested), and returns zero for sellers
 *         flagged by the configured wash-trading source.
 *
 *         Idempotent: exits with nothing to do when the pool already has a
 *         claim policy configured.
 *
 * Required env:
 *   SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY
 *                                Owner of the deployed AntseedSellerRewardsPool.
 *                                Also becomes the policy owner.
 *   ANTSEED_REGISTRY             Legacy AntseedRegistry address.
 *   EXPECTED_LEGACY_EMISSIONS    Deployed legacy AntseedEmissionsV2.
 *   USAGE_ACCOUNTING             AntseedUsageAccounting from M001 (used to
 *                                read the gate's effective epoch).
 *
 * Optional env:
 *   LAST_LOCKED_EPOCH            Overrides `effectiveEpoch - 1`.
 *   RELEASE_BPS                  Share of cumulative locked rewards released.
 *                                Default 1538 (~10/65).
 *   VEST_START_EPOCH             Epoch at which linear vesting begins. Default 0.
 *   VEST_EPOCHS                  Linear vesting length. Default 0 (immediate).
 *   WASH_TRADING_REGISTRY        Deployed AntseedWashTradingRegistry. Unset
 *                                leaves only the owner's manual seller flag
 *                                active; can be wired later via
 *                                `setWashTradingRegistry`.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/migrations/M002LegacySellerClaims/Deploy.s.sol:M002DeployLegacySellerClaims \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --via-ir
 */
contract M002DeployLegacySellerClaims is Script {
    uint256 public constant DEFAULT_RELEASE_BPS = 1538;

    struct Config {
        uint256 poolOwnerPrivateKey;
        address registry;
        address legacyEmissionsV2;
        address usageAccounting;
        uint256 lastEpochOverride; // 0 = derive from gate.effectiveEpoch() - 1
        uint256 releaseBps;
        uint256 vestStart;
        uint256 vestEpochs;
        address washTradingRegistry;
    }

    function run() external returns (address) {
        return runWith(
            Config({
                poolOwnerPrivateKey: vm.envUint("SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                legacyEmissionsV2: vm.envAddress("EXPECTED_LEGACY_EMISSIONS"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                lastEpochOverride: vm.envOr("LAST_LOCKED_EPOCH", uint256(0)),
                releaseBps: vm.envOr("RELEASE_BPS", DEFAULT_RELEASE_BPS),
                vestStart: vm.envOr("VEST_START_EPOCH", uint256(0)),
                vestEpochs: vm.envOr("VEST_EPOCHS", uint256(0)),
                washTradingRegistry: vm.envOr("WASH_TRADING_REGISTRY", address(0))
            })
        );
    }

    function runWith(Config memory cfg) public returns (address) {
        address poolOwner = vm.addr(cfg.poolOwnerPrivateKey);
        IAntseedRegistryView registry = IAntseedRegistryView(cfg.registry);
        ILegacyEmissionsV2View v2 = ILegacyEmissionsV2View(cfg.legacyEmissionsV2);
        IUsageAccountingView usageAccounting = IUsageAccountingView(cfg.usageAccounting);

        require(registry.emissions() != address(v2), "M001 cutover has not flipped registry.emissions() yet");

        address v1 = v2.legacyEmissions();
        ISellerRewardsPoolAdmin pool = ISellerRewardsPoolAdmin(v2.sellerRewardsPool());
        require(address(pool) != address(0), "legacy EmissionsV2 has no seller rewards pool");
        require(pool.owner() == poolOwner, "SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY is not the pool owner");

        uint256 effectiveEpoch = IEmissionsGateView(usageAccounting.emissionsGate()).effectiveEpoch();
        require(effectiveEpoch > 0, "gate effective epoch must be positive");
        uint256 lastEpoch = cfg.lastEpochOverride == 0 ? effectiveEpoch - 1 : cfg.lastEpochOverride;
        require(lastEpoch >= v2.MIGRATION_EPOCH(), "LAST_LOCKED_EPOCH precedes the V2 migration epoch");
        require(lastEpoch < effectiveEpoch, "LAST_LOCKED_EPOCH must precede the gate's effective epoch");
        if (cfg.washTradingRegistry != address(0)) {
            require(cfg.washTradingRegistry.code.length != 0, "WASH_TRADING_REGISTRY has no code");
        }

        console.log("=== AntSeed Legacy Seller Claims (M002) ===");
        console.log("SellerRewardsPool:      ", address(pool));
        console.log("Pool total locked:      ", pool.totalLockedRewards());
        console.log("Legacy EmissionsV2:     ", address(v2));
        console.log("Legacy EmissionsV1:     ", v1);
        console.log("Migration epoch:        ", v2.MIGRATION_EPOCH());
        console.log("Last locked epoch:      ", lastEpoch);
        console.log("Release bps:            ", cfg.releaseBps);
        console.log("Vest start / epochs:    ", cfg.vestStart, cfg.vestEpochs);
        console.log("Wash-trading registry:  ", cfg.washTradingRegistry);

        address existing = pool.sellerClaimPolicy();
        if (existing != address(0)) {
            console.log("");
            console.log("Nothing to do: pool already has a seller claim policy:", existing);
            return existing;
        }

        vm.startBroadcast(cfg.poolOwnerPrivateKey);
        AntseedLegacySellerClaimPolicy policy = new AntseedLegacySellerClaimPolicy(
            address(v2), v1, lastEpoch, cfg.releaseBps, cfg.vestStart, cfg.vestEpochs, cfg.washTradingRegistry
        );
        pool.setSellerClaimPolicy(address(policy));
        vm.stopBroadcast();

        require(pool.sellerClaimPolicy() == address(policy), "post-check failed: claim policy not set");
        require(policy.owner() == poolOwner, "post-check failed: unexpected policy owner");

        console.log("");
        console.log("=== M002 complete ===");
        console.log("LegacySellerClaimPolicy:", address(policy));
        console.log("");
        console.log("Immediately after:");
        console.log("- Record the deployment in deployments/<network>/history and update current.json.");
        if (cfg.washTradingRegistry == address(0)) {
            console.log("- Wire the wash-trading registry once deployed: policy.setWashTradingRegistry(<addr>).");
        }
        return address(policy);
    }
}
