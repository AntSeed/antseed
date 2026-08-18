// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedLegacyEmissionsEscrow } from "../emissions/AntseedLegacyEmissionsEscrow.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";

interface IANTSTokenAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
    function setTransferWhitelist(address account, bool allowed) external;
}

interface IAntseedLegacyEmissionsClock {
    function genesis() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
    function currentEpoch() external view returns (uint256);
}

interface IAntseedLegacyEmissionsAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
}

/**
 * @title DeployRecognizedUsage
 * @notice Broadcast #1 of the two-broadcast cutover. Deploys the seller-pool /
 *         recognized-usage stack, moves the ANTS mint authority to
 *         AntseedEmissionsGate, funds the legacy escrow, and re-points the
 *         legacy emissions contract at it. It deliberately does NOT touch the
 *         registry emissions/staking pointers: the network keeps running on
 *         the legacy stack (claims paid from the escrow pot) until
 *         CutoverFlip.s.sol runs in the next epoch. That split lets the
 *         in-flight epoch finalize and be claimed from legacy V2 (with its
 *         real pot) BEFORE the pointer flip, so the deployed DiemStakingProxy
 *         can never freeze the cutover epoch at a zero pot.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Broadcaster key. MUST be the owner of ANTSToken and
 *                          the legacy emissions contract (checked upfront).
 *   ANTSEED_REGISTRY       Existing (legacy) AntseedRegistry address.
 *   VERIFICATION_WALLET    Recipient of the verification bucket.
 *
 * Optional env:
 *   EMISSIONS_RESERVE_WALLET          Destination for ANTS emission reserve flows
 *                                     via the reserve minter controller. Unset =
 *                                     ANTS reserve flows use protocolReserve.
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

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
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
        address emissionsReserveWallet = vm.envOr("EMISSIONS_RESERVE_WALLET", address(0));
        address teamWallet = registry.teamWallet();
        address protocolReserve = registry.protocolReserve();
        address identityRegistry = registry.identityRegistry();
        require(teamWallet != address(0), "team wallet not set");
        require(protocolReserve != address(0), "protocol reserve not set");
        require(identityRegistry != address(0), "identity registry not set");

        // On mainnet the deployer EOA and the protocol owner key differ; this
        // broadcast performs owner-gated calls on both contracts, so fail the
        // simulation before any tx is sent rather than mid-broadcast.
        require(IANTSTokenAdmin(antsToken).owner() == deployer, "deployer must own ANTSToken");
        require(
            IAntseedLegacyEmissionsAdmin(existingEmissions).owner() == deployer, "deployer must own legacy emissions"
        );

        // Minter share checkpoints activate at currentEpoch()+1 == the gate's
        // effectiveEpoch only if every setMinter lands in the same epoch as
        // the gate's construction. A broadcast straddling an epoch boundary
        // would leave the effective epoch's buckets at zero share forever, so
        // refuse to start near the boundary.
        {
            uint256 legacyGenesis = IAntseedLegacyEmissionsClock(existingEmissions).genesis();
            uint256 legacyEpochDuration = IAntseedLegacyEmissionsClock(existingEmissions).EPOCH_DURATION();
            uint256 legacyCurrentEpoch = IAntseedLegacyEmissionsClock(existingEmissions).currentEpoch();
            uint256 nextBoundary = legacyGenesis + (legacyCurrentEpoch + 1) * legacyEpochDuration;
            require(nextBoundary - block.timestamp > 1 hours, "too close to epoch boundary; deploy earlier in the epoch");
        }

        vm.startBroadcast(deployerPrivateKey);

        AntseedEmissionsGate gate = new AntseedEmissionsGate(teamWallet, protocolReserve, 15_000, 15_000);
        if (emissionsReserveWallet != address(0)) {
            gate.setMinterController(gate.RESERVE_MINTER_ID(), emissionsReserveWallet);
        }
        uint256 currentEpoch = gate.currentEpoch();
        uint256 effectiveEpoch = gate.effectiveEpoch();
        uint256 genesis = gate.genesis();
        uint256 epochDuration = gate.epochDuration();

        // The escrow funding below settles pre-effective epochs on the
        // gate's schedule, so the legacy and gate clocks must agree.
        require(
            IAntseedLegacyEmissionsClock(existingEmissions).genesis() == genesis
                && IAntseedLegacyEmissionsClock(existingEmissions).EPOCH_DURATION() == epochDuration,
            "legacy emissions clock mismatch"
        );

        console.log("=== AntSeed Recognized Usage Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("Legacy Registry:        ", registryAddress);
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

        AntseedSellerPools sellerPools =
            new AntseedSellerPools(antsToken, address(gate), identityRegistry, existingStaking);
        console.log("SellerPools:          ", address(sellerPools));

        AntseedSellerRegistry sellerRegistry =
            new AntseedSellerRegistry(identityRegistry, address(sellerPools), existingStaking);
        console.log("SellerRegistry:       ", address(sellerRegistry));

        // SellerPools is constructed against the legacy staking contract only
        // because SellerRegistry doesn't exist yet (circular constructor
        // dependency). Re-point it now: agentIdForSeller and pool-creation
        // ownership checks must resolve sellers registered in the new
        // SellerRegistry, not just legacy stakers (SellerRegistry itself
        // falls back to legacy bindings, so old sellers keep resolving).
        sellerPools.setStakingSource(address(sellerRegistry));

        console.log("EmissionsGate:          ", address(gate));
        gate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, 10_000, true);

        AntseedUsageAccounting usageAccounting =
            new AntseedUsageAccounting(address(sellerPools), existingChannels, address(gate));
        console.log("UsageAccounting:        ", address(usageAccounting));

        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(deployer);
        usageAccounting.setPointsPolicy(address(pointsPolicyRegistry));
        console.log("PointsPolicyRegistry:   ", address(pointsPolicyRegistry));

        AntseedSellerPoolsRewards sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        console.log("SellerPoolsRewards: ", address(sellerPoolsRewards));

        AntseedUsageRewards usageRewards =
            new AntseedUsageRewards(address(gate), address(usageAccounting), identityRegistry, existingDeposits);
        usageRewards.setSellerPools(address(sellerPools));
        console.log("UsageRewards:       ", address(usageRewards));

        // Seller delegation adapter: already-deployed delegation contracts
        // (e.g. DiemStakingProxy) call the legacy pendingEmissions /
        // claimSellerEmissions selectors on registry.emissions(). The
        // accounting contract adapts those to agent usage rewards, and the
        // rewards controller lets it initiate owner-destined claims.
        usageAccounting.setUsageRewards(address(usageRewards));
        usageRewards.setClaimForwarder(address(usageAccounting));

        // Legacy emissions escrow: the deployed legacy emissions contract is
        // re-pointed at this registry facade whose antsToken() is the escrow
        // itself, so its unchanged mint() claims draw from a fixed pre-minted
        // pot instead of minting. The gate then refuses pre-effective epochs
        // unconditionally.
        AntseedLegacyEmissionsEscrow legacyEscrow =
            new AntseedLegacyEmissionsEscrow(registryAddress, existingEmissions);
        console.log("LegacyEmissionsEscrow:  ", address(legacyEscrow));

        // SellerPools must be able to pay out withdrawals and slash to the dead
        // address. UsageRewards must be able to stake claimed rewards via
        // stakeFor, SellerPoolsRewards to pay out and restake indexed staker
        // rewards, and the escrow to pay legacy claims — all while ANTS
        // transfers are globally disabled.
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(sellerPools), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(usageRewards), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(sellerPoolsRewards), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(legacyEscrow), true);
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(sellerPoolsRewards), 40_000, true);
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 20_000, true);

        // Mint authority moves only after every bucket minter is configured: a
        // broadcast that fails before this line leaves the legacy emissions
        // path untouched, and one that fails after it leaves the new path
        // fully mintable. The escrow is funded and wired immediately after so
        // legacy claims never touch a token that only accepts the gate.
        //
        // The registry emissions/staking pointers are deliberately NOT flipped
        // here. Until CutoverFlip.s.sol runs (next epoch), the network keeps
        // operating fully on the legacy stack: Channels accruals, seller
        // eligibility, and all legacy claims — now paid from the escrow pot —
        // keep working, while the gate cannot mint anything (its first
        // mintable epoch is effectiveEpoch, claimable only once the epoch
        // after it starts). There is no moment where both stacks can emit for
        // the same epoch.
        IANTSTokenAdmin(antsToken).setRegistry(address(gate));
        uint256 escrowAmount = gate.fundLegacyEscrow(address(legacyEscrow));
        IAntseedLegacyEmissionsAdmin(existingEmissions).setRegistry(address(legacyEscrow));
        console.log("Legacy escrow funded:   ", escrowAmount);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Recognized usage deployment complete (broadcast 1 of 2) ===");
        console.log("Token gate is:            ", address(gate));
        console.log("Registry emissions:        UNCHANGED (legacy) until CutoverFlip");
        console.log("Registry staking:          UNCHANGED (legacy) until CutoverFlip");
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
        console.log("Reserve recipient:        ", gate.emissionsReserve());
        console.log("Verification recipient:   ", verificationWallet);
        console.log("");
        console.log("NEXT STEP (broadcast 2 of 2):");
        console.log("- Run scripts/cutover-flip.sh: it pauses AntseedChannels 60s");
        console.log("  before the epoch boundary (so no usage anywhere on the network");
        console.log("  can land on the legacy ledger for the new epoch), waits for the");
        console.log("  epoch to finalize, runs CutoverFlip.s.sol, then unpauses");
        console.log("  Channels ONLY after verifying on-chain that both registry");
        console.log("  pointers reached the new stack (which implies the proxy pots");
        console.log("  were funded first - the flips are the last txs broadcast). If");
        console.log("  the flip fails, Channels stay paused: fix the cause and rerun");
        console.log("  (CutoverFlip is idempotent and finishes whatever is left, e.g.");
        console.log("  setStaking after a run that died past setEmissions), or");
        console.log("  force-unpause manually. Running CutoverFlip by hand instead");
        console.log("  requires managing the Channels pause yourself (owner key).");
        console.log("- Once the current epoch finalizes, run CutoverFlip.s.sol (or");
        console.log("  scripts/cutover-flip.sh to wait + run automatically). It claims");
        console.log("  the finalized epoch's Diem pot from legacy V2 (paid by the");
        console.log("  escrow) BEFORE flipping, then sets registry emissions/staking");
        console.log("  to the new stack. Env it needs:");
        console.log("    USAGE_ACCOUNTING=          ", address(usageAccounting));
        console.log("    POINTS_POLICY_REGISTRY=    ", address(pointsPolicyRegistry));
        console.log("    SELLER_REGISTRY=           ", address(sellerRegistry));
        console.log("    DIEM_STAKING_PROXY=        <deployed proxy address>");
        console.log("    REGISTRY_OWNER_PRIVATE_KEY=<AntseedRegistry owner key>");
        console.log("    DIEM_STAKER_PRIVATE_KEY=   <key with DIEM staked on the proxy>");
        console.log("");
        console.log("POST-FLIP CHECKLIST (manual):");
        console.log("- Create + seed an ANTS seller pool for the proxy's agent id right");
        console.log("  after the flip: usage of pool-less agents is not accounted, so");
        console.log("  the proxy earns nothing in the new stack until it has a pool.");
        console.log("- The deployer EOA still owns ANTSToken, the gate, and every new");
        console.log("  contract. Until it is dealt with, that key can re-point the");
        console.log("  token's mint authority (ANTSToken.setRegistry) and rotate any");
        console.log("  bucket controller (gate.setMinterController, locked buckets");
        console.log("  included). Transfer ownership to the ops multisig, and once");
        console.log("  minters/deposits/escrow are final call gate.renounceOwnership()");
        console.log("  to freeze the emission plan.");
        console.log("- KEEP AntseedRegistry ownership: it is the only key that can open");
        console.log("  the temporary setStaking(legacy) window needed to withdraw the");
        console.log("  proxy's legacy USDC stake (SellerRegistry.unstake reverts by");
        console.log("  design). Do not renounce it before that stake is out.");
        console.log("- Sellers staked in legacy USDC staking stay eligible via the");
        console.log("  SellerRegistry legacy fallback. Call setLegacyStakeEligibilityEnabled(false)");
        console.log("  only after seller pools are seeded with ANTS stake.");
        console.log("- Sellers cannot stake ANTS into pools until they are transfer-");
        console.log("  whitelisted or transfers are enabled.");
        console.log("- Legacy EmissionsV2 is registered against the escrow: all its");
        console.log("  claims and team/reserve flushes (any epoch, any time) pay from");
        console.log("  the pre-minted pot. Sweep the escrow leftovers only after legacy");
        console.log("  claim activity has wound down.");
        console.log("- Locked-path legacy sellers (not unlock-approved) claim through");
        console.log("  AntseedSellerRewardsPool, whose auth reads its registry's");
        console.log("  emissions() live. CutoverFlip pins the pool to a dedicated");
        console.log("  facade before flipping (signed by the pool owner key), so those");
        console.log("  claims keep working. Fallback for stragglers either way:");
        console.log("  EmissionsV2.setSellerUnlockPolicy (plain onlyOwner, works even");
        console.log("  after any registry renouncement).");
    }
}
