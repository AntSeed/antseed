// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedLegacyRewardsPoolRegistry } from "../rewards/AntseedLegacyRewardsPoolRegistry.sol";

interface IAntseedRegistryFlipAdmin is IAntseedRegistry {
    function owner() external view returns (address);
    function setEmissions(address emissions) external;
    function setStaking(address staking) external;
}

interface IUsageAccountingLike {
    function emissionsGate() external view returns (address);
}

interface IEmissionsGateClock {
    function currentEpoch() external view returns (uint256);
    function effectiveEpoch() external view returns (uint256);
}

interface ISellerRewardsPoolAdmin {
    function owner() external view returns (address);
    function registry() external view returns (address);
    function setRegistry(address _registry) external;
}

interface IDiemStakingProxyFlip {
    function staked(address account) external view returns (uint256);
    function firstRewardEpoch() external view returns (uint32);
    function syncedRewardEpoch() external view returns (uint32);
    function rewardEpochs(uint32 epoch)
        external
        view
        returns (uint256 revenuePerTokenAtEnd, uint256 totalPoints, uint256 antsPot, bool funded);
    function userEpochClaimed(address account, uint32 epoch) external view returns (bool);
    function syncBacklog() external view returns (uint32 finalized, uint32 synced, uint32 remaining);
    function syncRewardEpochs(uint32 maxEpochs) external;
    function claimAnts(uint32[] calldata rewardEpochIds) external;
}

/**
 * @title CutoverFlip
 * @notice Broadcast #2 of the two-broadcast cutover. Run after
 *         DeployRecognizedUsage, once the epoch that was in flight during that
 *         deploy has finalized (the gate's effectiveEpoch has started).
 *
 *         Two phases, two keys:
 *           1. STAKER key: syncs the DiemStakingProxy's reward epochs and
 *              claims every pre-effective epoch whose pot is not yet funded.
 *              registry.emissions() still resolves to legacy EmissionsV2 at
 *              this point, so each claim funds the proxy's epoch pot with its
 *              REAL ANTS amount, paid from the legacy escrow. Once funded,
 *              the pot is stored forever — the pointer flip below can no
 *              longer affect it, and the zero-pot freeze is impossible.
 *           2. REGISTRY OWNER key: flips registry.setEmissions to
 *              AntseedUsageAccounting and registry.setStaking to
 *              AntseedSellerRegistry.
 *
 *         The whole run simulates before anything broadcasts, so every guard
 *         below aborts the flip with nothing sent.
 *
 * Required env:
 *   REGISTRY_OWNER_PRIVATE_KEY   AntseedRegistry owner (signs the flips).
 *   ANTSEED_REGISTRY             Legacy AntseedRegistry address.
 *   USAGE_ACCOUNTING             AntseedUsageAccounting from broadcast #1.
 *   SELLER_REGISTRY              AntseedSellerRegistry from broadcast #1.
 *
 * Optional env:
 *   DIEM_STAKING_PROXY           Deployed DiemStakingProxy. Unset skips the
 *                                claim phase (testnets without a proxy).
 *   DIEM_STAKER_PRIVATE_KEY      Key with DIEM staked on the proxy (signs the
 *                                claims). Required when the proxy is set.
 *   SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY
 *                                Owner of the deployed AntseedSellerRewardsPool
 *                                (auto-discovered via the legacy emissions
 *                                contract). Falls back to
 *                                DIEM_STAKER_PRIVATE_KEY. Signs the pinned
 *                                registry facade wiring below.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/CutoverFlip.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --via-ir
 */
contract CutoverFlip is Script {
    function run() external {
        uint256 ownerPrivateKey = vm.envUint("REGISTRY_OWNER_PRIVATE_KEY");
        address registryOwner = vm.addr(ownerPrivateKey);
        IAntseedRegistryFlipAdmin registry = IAntseedRegistryFlipAdmin(vm.envAddress("ANTSEED_REGISTRY"));
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address sellerRegistry = vm.envAddress("SELLER_REGISTRY");
        address proxyAddress = vm.envOr("DIEM_STAKING_PROXY", address(0));

        require(registry.owner() == registryOwner, "REGISTRY_OWNER_PRIVATE_KEY is not the registry owner");
        address legacyEmissions = registry.emissions();
        require(legacyEmissions != usageAccounting, "registry emissions already flipped");

        IEmissionsGateClock gate = IEmissionsGateClock(IUsageAccountingLike(usageAccounting).emissionsGate());
        uint256 effectiveEpoch = gate.effectiveEpoch();
        // The claim below funds pre-effective epochs from legacy V2, which
        // only serves finalized epochs. Until the effective epoch starts, the
        // cutover epoch is still in flight and this whole flip must wait.
        require(gate.currentEpoch() >= effectiveEpoch, "cutover epoch not finalized yet");

        console.log("=== AntSeed Recognized Usage Cutover Flip ===");
        console.log("Registry:               ", address(registry));
        console.log("Legacy emissions (from):", legacyEmissions);
        console.log("UsageAccounting (to):   ", usageAccounting);
        console.log("SellerRegistry (to):    ", sellerRegistry);
        console.log("Effective epoch:        ", effectiveEpoch);
        console.log("Current epoch:          ", gate.currentEpoch());

        if (proxyAddress != address(0)) {
            _fundProxyRewardEpochs(IDiemStakingProxyFlip(proxyAddress), uint32(effectiveEpoch - 1));
        } else {
            console.log("");
            console.log("WARNING: DIEM_STAKING_PROXY unset - skipping the pre-flip claim.");
            console.log("Any deployed delegation proxy with unfunded pre-effective epochs");
            console.log("will permanently freeze them at a zero pot after this flip.");
        }

        _pinRewardsPoolRegistry(registry, legacyEmissions);

        vm.startBroadcast(ownerPrivateKey);
        registry.setEmissions(usageAccounting);
        registry.setStaking(sellerRegistry);
        vm.stopBroadcast();

        console.log("");
        console.log("=== Cutover flip complete ===");
        console.log("Registry emissions is now:", usageAccounting);
        console.log("Registry staking is now:  ", sellerRegistry);
        console.log("");
        console.log("Immediately after:");
        console.log("- Resume the DiemStakingProxy operator.");
        console.log("- Create + seed an ANTS seller pool for the proxy's agent id");
        console.log("  (usage of pool-less agents is not accounted).");
    }

    /// @dev Re-point the deployed AntseedSellerRewardsPool at a pinned
    ///      registry facade before the flip. The pool's recordLockedReward
    ///      auth reads its registry's emissions() live, so leaving it on the
    ///      real registry would break every locked-path legacy claim the
    ///      moment the flip lands. The pool is auto-discovered from the
    ///      legacy emissions contract; contracts without one (testnets)
    ///      skip silently.
    function _pinRewardsPoolRegistry(IAntseedRegistryFlipAdmin registry, address legacyEmissions) internal {
        (bool ok, bytes memory data) = legacyEmissions.staticcall(abi.encodeWithSignature("sellerRewardsPool()"));
        address pool = (ok && data.length == 32) ? abi.decode(data, (address)) : address(0);
        if (pool == address(0)) {
            console.log("");
            console.log("No AntseedSellerRewardsPool on the legacy emissions contract - skipping.");
            return;
        }

        if (ISellerRewardsPoolAdmin(pool).registry() != address(registry)) {
            console.log("");
            console.log("SellerRewardsPool registry already pinned:", ISellerRewardsPoolAdmin(pool).registry());
            return;
        }

        uint256 poolOwnerPrivateKey = vm.envOr("SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY", uint256(0));
        if (poolOwnerPrivateKey == 0) poolOwnerPrivateKey = vm.envOr("DIEM_STAKER_PRIVATE_KEY", uint256(0));
        require(poolOwnerPrivateKey != 0, "SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY not set (pool needs its registry pinned)");
        require(
            ISellerRewardsPoolAdmin(pool).owner() == vm.addr(poolOwnerPrivateKey),
            "SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY is not the pool owner"
        );

        vm.startBroadcast(poolOwnerPrivateKey);
        AntseedLegacyRewardsPoolRegistry facade =
            new AntseedLegacyRewardsPoolRegistry(legacyEmissions, registry.antsToken());
        ISellerRewardsPoolAdmin(pool).setRegistry(address(facade));
        vm.stopBroadcast();

        console.log("");
        console.log("SellerRewardsPool:      ", pool);
        console.log("Pinned registry facade: ", address(facade));
    }

    /// @dev Claim every unfunded pre-effective reward epoch on the proxy while
    ///      registry.emissions() still resolves to legacy V2, so each pot is
    ///      funded with its real ANTS amount before the flip freezes the
    ///      legacy path out. Reverts (in simulation, before anything is sent)
    ///      if an epoch with points cannot be funded by this staker.
    function _fundProxyRewardEpochs(IDiemStakingProxyFlip proxy, uint32 cutoverEpoch) internal {
        uint256 stakerPrivateKey = vm.envUint("DIEM_STAKER_PRIVATE_KEY");
        address staker = vm.addr(stakerPrivateKey);

        console.log("");
        console.log("DiemStakingProxy:       ", address(proxy));
        console.log("Staker:                 ", staker);
        console.log("Staker DIEM staked:     ", proxy.staked(staker));

        vm.startBroadcast(stakerPrivateKey);

        // Close every finalized reward epoch so rewardEpochs() below reflects
        // real totals. Chunked to respect the proxy's per-call capture bound.
        (,, uint32 remaining) = proxy.syncBacklog();
        while (remaining > 0) {
            uint32 chunk = remaining > 16 ? 16 : remaining;
            proxy.syncRewardEpochs(chunk);
            remaining -= chunk;
        }

        uint32 firstEpoch = proxy.firstRewardEpoch();
        uint32[] memory candidates = new uint32[](cutoverEpoch >= firstEpoch ? cutoverEpoch - firstEpoch + 1 : 0);
        uint256 count = 0;
        for (uint32 epoch = firstEpoch; epoch <= cutoverEpoch; epoch++) {
            (, uint256 totalPoints,, bool funded) = proxy.rewardEpochs(epoch);
            if (funded || totalPoints == 0) continue;
            require(
                !proxy.userEpochClaimed(staker, epoch),
                "staker already claimed an unfunded epoch; fund it from another staker first"
            );
            candidates[count++] = epoch;
        }

        if (count > 0) {
            require(count <= 16, "more than 16 unfunded epochs; claim older ones manually first");
            uint32[] memory epochs = new uint32[](count);
            for (uint256 i = 0; i < count; i++) {
                epochs[i] = candidates[i];
            }
            proxy.claimAnts(epochs);
            console.log("Funded reward epochs:   ", count);
        } else {
            console.log("All pre-effective reward epochs already funded or empty.");
        }

        vm.stopBroadcast();

        // The flip is unsafe while any pre-effective epoch with points is
        // unfunded: the first post-flip claim would freeze it at a zero pot.
        for (uint32 epoch = firstEpoch; epoch <= cutoverEpoch; epoch++) {
            (, uint256 totalPoints,, bool funded) = proxy.rewardEpochs(epoch);
            require(
                funded || totalPoints == 0,
                "a pre-effective epoch with points is still unfunded (staker had no points in it); fund it from another staker, then rerun"
            );
        }
    }
}
