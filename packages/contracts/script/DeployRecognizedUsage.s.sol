// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";

interface IAntseedRegistryRecognizedUsageAdmin is IAntseedRegistry {
    function setEmissions(address emissions) external;
    function setStaking(address staking) external;
}

interface IANTSTokenAdmin {
    function setRegistry(address registry) external;
    function setTransferWhitelist(address account, bool allowed) external;
}

interface IAntseedLegacyEmissionsClock {
    function genesis() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
}

interface IAntseedLegacyEmissionsAdmin {
    function setRegistry(address registry) external;
}

/**
 * @title DeployRecognizedUsage
 * @notice Deploys the seller-pool / recognized-usage stack, points ANTS mint
 *         gate at AntseedEmissionsGate, and cuts the registry emissions
 *         and staking pointers. All pointer flips happen at the end of the
 *         broadcast so any partial run leaves the legacy stack fully working.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Owner/broadcaster key.
 *   ANTSEED_REGISTRY       Existing AntseedRegistry address.
 *   VERIFICATION_WALLET    Recipient of the verification bucket.
 *
 * Optional env:
 *   POOL_APY_START_BPS                Initial APY cap, immutable at deploy. Defaults to 10000 (100%).
 *   POOL_APY_FLOOR_BPS                Terminal APY cap after decay, immutable. Defaults to 2000 (20%).
 *   POOL_APY_DECAY_PER_EPOCH_BPS      Linear decay per epoch, immutable. Defaults to 500 (5 points).
 *   POOL_APY_DECAY_START_EPOCH        Epoch the decay begins. Defaults to 0 =
 *                                     not started; fire it later with the
 *                                     one-time startApyDecay(futureEpoch).
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployRecognizedUsage.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployRecognizedUsage is Script {
    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 public constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 public constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");

        IAntseedRegistryRecognizedUsageAdmin registry = IAntseedRegistryRecognizedUsageAdmin(registryAddress);
        address antsToken = registry.antsToken();
        address existingEmissions = registry.emissions();
        address existingChannels = registry.channels();
        address existingDeposits = registry.deposits();
        address existingStaking = registry.staking();
        require(antsToken != address(0), "ANTS token not set");
        require(antsToken == ANTS_TOKEN, "registry ANTS mismatch");
        require(existingEmissions != address(0), "existing emissions not set");
        require(existingChannels != address(0), "channels not set");
        require(existingDeposits != address(0), "deposits not set");

        address verificationWallet = vm.envAddress("VERIFICATION_WALLET");
        require(verificationWallet != address(0), "verification wallet not set");
        uint256 poolApyStartBps = vm.envOr("POOL_APY_START_BPS", uint256(10_000));
        uint256 poolApyFloorBps = vm.envOr("POOL_APY_FLOOR_BPS", uint256(2_000));
        uint256 poolApyDecayPerEpochBps = vm.envOr("POOL_APY_DECAY_PER_EPOCH_BPS", uint256(500));
        uint256 poolApyDecayStartEpoch = vm.envOr("POOL_APY_DECAY_START_EPOCH", uint256(0));
        address teamWallet = registry.teamWallet();
        address protocolReserve = registry.protocolReserve();
        require(teamWallet != address(0), "team wallet not set");
        require(protocolReserve != address(0), "protocol reserve not set");

        vm.startBroadcast(deployerPrivateKey);

        AntseedEmissionsGate gate = new AntseedEmissionsGate(registryAddress, 15_000, 15_000);
        uint256 currentEpoch = gate.currentEpoch();
        uint256 effectiveEpoch = gate.effectiveEpoch();
        uint256 genesis = gate.genesis();
        uint256 epochDuration = gate.epochDuration();

        // SellerPools resolves epochs via registry.emissions(): the legacy
        // clock until the pointer flip below, the gate's clock after. The
        // startApyDecay future-only check below runs against the legacy
        // clock, so the two clocks must agree.
        require(
            IAntseedLegacyEmissionsClock(existingEmissions).genesis() == genesis
                && IAntseedLegacyEmissionsClock(existingEmissions).EPOCH_DURATION() == epochDuration,
            "legacy emissions clock mismatch"
        );

        console.log("=== AntSeed Recognized Usage Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("Registry:               ", registryAddress);
        console.log("ANTS Token:             ", antsToken);
        console.log("Existing Emissions:     ", existingEmissions);
        console.log("Existing Channels:      ", existingChannels);
        console.log("Existing Deposits:      ", existingDeposits);
        console.log("Existing Staking:       ", existingStaking);
        console.log("Team Wallet:            ", teamWallet);
        console.log("Protocol Reserve:       ", protocolReserve);
        console.log("Genesis:                ", genesis);
        console.log("Epoch Duration:         ", epochDuration);
        console.log("Current Epoch:          ", currentEpoch);
        console.log("Effective Epoch:        ", effectiveEpoch);
        console.log("");

        // The APY cap trajectory is immutable from deployment:
        //   cap(e) = max(floor, start - decayPerEpoch * (e - decayStartEpoch))
        // The only lever is the one-time startApyDecay(futureEpoch) call.
        AntseedSellerPools sellerPools =
            new AntseedSellerPools(registryAddress, poolApyStartBps, poolApyFloorBps, poolApyDecayPerEpochBps);
        console.log("SellerPools:          ", address(sellerPools));

        if (poolApyDecayStartEpoch != 0) {
            sellerPools.startApyDecay(poolApyDecayStartEpoch);
        }
        console.log("Pool APY start (bps):   ", poolApyStartBps);
        console.log("Pool APY floor (bps):   ", poolApyFloorBps);
        console.log("Pool APY decay (bps/ep):", poolApyDecayPerEpochBps);
        console.log("Pool APY decay epoch:   ", poolApyDecayStartEpoch);

        AntseedSellerRegistry sellerRegistry =
            new AntseedSellerRegistry(registryAddress, address(sellerPools), existingStaking);
        console.log("SellerRegistry:       ", address(sellerRegistry));

        console.log("EmissionsGate:          ", address(gate));
        gate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, 10_000, true);

        AntseedUsageAccounting usageAccounting =
            new AntseedUsageAccounting(address(sellerPools), existingChannels, address(gate));
        console.log("UsageAccounting:        ", address(usageAccounting));

        AntseedSellerPoolsRewards sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        console.log("SellerPoolsRewards: ", address(sellerPoolsRewards));

        AntseedUsageRewards usageRewards =
            new AntseedUsageRewards(address(gate), registryAddress, address(usageAccounting));
        usageRewards.setSellerPools(address(sellerPools));
        console.log("UsageRewards:       ", address(usageRewards));

        // SellerPools must be able to pay out withdrawals and slash to the dead
        // address. UsageRewards must be able to stake claimed rewards via
        // stakeFor while ANTS transfers are globally disabled.
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(sellerPools), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(usageRewards), true);
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(sellerPoolsRewards), 40_000, true);
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 20_000, true);

        // Mint authority moves only after every bucket minter is configured: a
        // broadcast that fails before this line leaves the legacy emissions
        // path untouched, and one that fails after it leaves the new path
        // fully mintable.
        IANTSTokenAdmin(antsToken).setRegistry(address(gate));
        registry.setEmissions(address(usageAccounting));
        registry.setStaking(address(sellerRegistry));
        IAntseedLegacyEmissionsAdmin(existingEmissions).setRegistry(address(gate));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Recognized usage deployment complete ===");
        console.log("Token gate is:            ", address(gate));
        console.log("Registry emissions is now:", address(usageAccounting));
        console.log("Registry staking is now:  ", address(sellerRegistry));
        console.log("Seller pools bucket:      2-40% dynamic (40% max)");
        console.log("Usage bucket:             buyer 5-10%, seller/operator 5-10% dynamic (20% max)");
        console.log("Team bucket:              15%");
        console.log("Reserve bucket:           15%");
        console.log("Verification bucket:      10%");
        console.log("Seller pools minter:      ", address(sellerPoolsRewards));
        console.log("Usage minter:             ", address(usageRewards));
        console.log("Legacy claims minter:     ", existingEmissions);
        console.log("Legacy claims deposits:   ", existingDeposits);
        console.log("Team recipient:           ", teamWallet);
        console.log("Reserve recipient:        ", protocolReserve);
        console.log("Verification recipient:   ", verificationWallet);
        console.log("");
        console.log("POST-DEPLOY CHECKLIST (manual):");
        console.log("- Sellers staked in legacy USDC staking stay eligible via the");
        console.log("  SellerRegistry legacy fallback. Call setLegacyStakeEligibilityEnabled(false)");
        console.log("  only after seller pools are seeded with ANTS stake.");
        console.log("- Sellers cannot stake ANTS into pools until they are transfer-");
        console.log("  whitelisted or transfers are enabled.");
        console.log("- Legacy EmissionsV2 is now registered against the gate facade.");
        console.log("  Old finalized claims can mint through gate.mint().");
        console.log("- After any one-off gate bucket claims for pre-effective epochs are");
        console.log("  handled, call gate.disableLegacyEpochMints().");
    }
}
