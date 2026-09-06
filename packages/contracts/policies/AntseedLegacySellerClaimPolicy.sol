// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

interface IEmissionsV2View {
    function legacyEmissions() external view returns (address);
    function MIGRATION_EPOCH() external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function getEpochEmission(uint256 epoch) external view returns (uint256);
    function epochParams(uint256 epoch)
        external
        view
        returns (
            uint256 sellerSharePct,
            uint256 buyerSharePct,
            uint256 reserveSharePct,
            uint256 teamSharePct,
            uint256 maxSellerSharePct,
            uint256 maxBuyerSharePct,
            bool initialized
        );
    function epochTotalSellerPoints(uint256 epoch) external view returns (uint256);
    function userSellerPoints(address seller, uint256 epoch) external view returns (uint256);
    function sellerEpochClaimed(address seller, uint256 epoch) external view returns (bool);
}

interface IEmissionsV1View {
    function epochTotalSellerPoints(uint256 epoch) external view returns (uint256);
    function userSellerPoints(address seller, uint256 epoch) external view returns (uint256);
}

/**
 * @title AntseedLegacySellerClaimPolicy
 * @notice Stateless claim policy for the deployed AntseedSellerRewardsPool.
 *
 *         The pool calls `claimableSellerRewards(seller, locked)` as a view and
 *         is the only contract that mutates balances, so this policy cannot
 *         keep its own "already claimed" counter. Instead it re-derives the
 *         seller's *cumulative* locked amount from EmissionsV2/V1 state
 *         (mirroring `claimSellerEmissions` exactly) and treats
 *         `cumulative - locked` as what has already been released.
 *
 *         Release rule:
 *           entitled  = cumulative * releaseBps / BPS      (10% of cumulative locked rewards)
 *           entitled *= min(1, (now - vestStart) / vestEpochs)   (optional linear vest)
 *           claimable = entitled - released
 *
 *         Wash trading: a seller flagged by the configured on-chain wash-trading
 *         source (`isProvenWashTrader`) or explicitly by the owner can claim
 *         nothing. Their rewards stay locked in the pool.
 *
 *         Limitations (documented, conservative):
 *           - `sellerEpochClaimed` is set for both locked and unlock-policy
 *             (direct mint) claims. A seller that was unlock-eligible has the
 *             direct-minted amount counted as "already released", which only
 *             ever lowers what this policy returns. The pool clamps to `locked`.
 *           - Epochs are scanned from 0 through `lastEpoch`; pre-migration
 *             epochs claimed through V2 also landed in the pool and must count.
 */
contract AntseedLegacySellerClaimPolicy is IAntseedSellerClaimPolicy, Ownable2Step {
    uint256 public constant BPS = 10_000;

    IEmissionsV2View public immutable v2;
    IEmissionsV1View public immutable v1; // = v2.legacyEmissions(); only contributes points for epochs <= migrationEpoch
    uint256 public immutable migrationEpoch; // V1 points are merged for epochs <= migrationEpoch
    uint256 public immutable lastEpoch; // last epoch that could have been locked into the pool
    uint256 public immutable releaseBps; // 1000 = 10% of cumulative locked rewards
    uint256 public immutable vestStart; // epoch at which vesting begins
    uint256 public immutable vestEpochs; // linear vesting length; 0 = immediate

    IAntseedWashTradingStatus public washTradingRegistry;
    mapping(address => bool) public flaggedSeller;

    event WashTradingRegistrySet(address indexed registry);
    event SellerFlagged(address indexed seller, bool flagged);

    error InvalidAddress();
    error InvalidValue();

    constructor(
        address v2_,
        uint256 lastEpoch_,
        uint256 releaseBps_,
        uint256 vestStart_,
        uint256 vestEpochs_,
        address washTradingRegistry_
    ) Ownable(msg.sender) {
        if (v2_ == address(0)) revert InvalidAddress();
        if (releaseBps_ == 0 || releaseBps_ > BPS) revert InvalidValue();
        address v1_ = IEmissionsV2View(v2_).legacyEmissions();
        if (v1_ == address(0)) revert InvalidAddress();
        v2 = IEmissionsV2View(v2_);
        v1 = IEmissionsV1View(v1_);
        migrationEpoch = IEmissionsV2View(v2_).MIGRATION_EPOCH();
        if (lastEpoch_ < migrationEpoch) revert InvalidValue();
        lastEpoch = lastEpoch_;
        releaseBps = releaseBps_;
        vestStart = vestStart_;
        vestEpochs = vestEpochs_;
        washTradingRegistry = IAntseedWashTradingStatus(washTradingRegistry_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice True when the seller must not receive any locked rewards.
    function isWashTrader(address seller) public view returns (bool) {
        if (flaggedSeller[seller]) return true;
        IAntseedWashTradingStatus source = washTradingRegistry;
        if (address(source) == address(0)) return false;
        return source.isProvenWashTrader(seller);
    }

    /// @notice Total ANTS ever routed to the rewards pool for `seller`,
    ///         reconstructed from V2 claim flags and V2/V1 points.
    function cumulativeLocked(address seller) public view returns (uint256 total) {
        uint256 migration = migrationEpoch;
        for (uint256 e = 0; e <= lastEpoch; e++) {
            // Not claimed, or claimed via V1 before migration -> never entered the pool.
            if (!v2.sellerEpochClaimed(seller, e)) continue;

            uint256 userSP = v2.userSellerPoints(seller, e);
            uint256 totalSP = v2.epochTotalSellerPoints(e);
            if (e <= migration) {
                userSP += v1.userSellerPoints(seller, e);
                totalSP += v1.epochTotalSellerPoints(e);
            }
            if (userSP == 0 || totalSP == 0) continue;

            (uint256 sellerSharePct,,,, uint256 maxSellerSharePct,,) = v2.epochParams(e);
            uint256 sBudget = (v2.getEpochEmission(e) * sellerSharePct) / 100;
            uint256 reward = (userSP * sBudget) / totalSP;
            uint256 maxReward = (sBudget * maxSellerSharePct) / 100;
            total += reward > maxReward ? maxReward : reward;
        }
    }

    /// @notice Share of `cumulative` the seller is entitled to at the current epoch.
    function entitledOf(uint256 cumulative) public view returns (uint256 entitled) {
        entitled = (cumulative * releaseBps) / BPS;
        if (vestEpochs == 0) return entitled;
        uint256 now_ = v2.currentEpoch();
        if (now_ < vestStart) return 0;
        uint256 elapsed = now_ - vestStart;
        if (elapsed < vestEpochs) entitled = (entitled * elapsed) / vestEpochs;
    }

    /// @inheritdoc IAntseedSellerClaimPolicy
    function claimableSellerRewards(address seller, uint256 locked) external view returns (uint256) {
        if (locked == 0) return 0;
        if (isWashTrader(seller)) return 0;

        uint256 cumulative = cumulativeLocked(seller);
        if (cumulative < locked) cumulative = locked; // defensive: never under-count
        uint256 released = cumulative - locked;

        uint256 entitled = entitledOf(cumulative);
        uint256 claimable = entitled > released ? entitled - released : 0;
        return claimable > locked ? locked : claimable;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setWashTradingRegistry(address registry) external onlyOwner {
        washTradingRegistry = IAntseedWashTradingStatus(registry);
        emit WashTradingRegistrySet(registry);
    }

    function setSellerFlagged(address seller, bool flagged) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        flaggedSeller[seller] = flagged;
        emit SellerFlagged(seller, flagged);
    }
}
