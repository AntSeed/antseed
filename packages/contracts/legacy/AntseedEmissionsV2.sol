// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IANTSToken } from "../interfaces/IANTSToken.sol";
import { IAntseedSellerRewardsPool } from "../interfaces/IAntseedSellerRewardsPool.sol";
import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";

interface IAntseedLegacyEmissions {
    function EPOCH_DURATION() external view returns (uint256);
    function HALVING_INTERVAL() external view returns (uint256);
    function INITIAL_EMISSION() external view returns (uint256);
    function genesis() external view returns (uint256);
    function currentEpoch() external view returns (uint256);

    function SELLER_SHARE_PCT() external view returns (uint256);
    function BUYER_SHARE_PCT() external view returns (uint256);
    function RESERVE_SHARE_PCT() external view returns (uint256);
    function TEAM_SHARE_PCT() external view returns (uint256);
    function MAX_SELLER_SHARE_PCT() external view returns (uint256);

    function epochParams(uint256 epoch)
        external
        view
        returns (
            uint256 sellerSharePct,
            uint256 buyerSharePct,
            uint256 reserveSharePct,
            uint256 teamSharePct,
            uint256 maxSellerSharePct,
            bool initialized
        );

    function epochTotalSellerPoints(uint256 epoch) external view returns (uint256);
    function epochTotalBuyerPoints(uint256 epoch) external view returns (uint256);
    function userSellerPoints(address seller, uint256 epoch) external view returns (uint256);
    function userBuyerPoints(address buyer, uint256 epoch) external view returns (uint256);
    function sellerEpochClaimed(address seller, uint256 epoch) external view returns (bool);
    function buyerEpochClaimed(address buyer, uint256 epoch) external view returns (bool);
}

/**
 * @title AntseedEmissionsV2
 * @notice Backward-compatible emissions replacement for the deployed V1 system.
 *
 *         V2 keeps the V1 epoch clock by reading V1's genesis and emission
 *         constants. It can be deployed in the middle of an epoch and combine
 *         V1 pre-migration points with V2 post-migration points for that same
 *         migration epoch.
 *
 *         New behavior:
 *           - buyer per-epoch cap, with migration/legacy epochs snapshotted uncapped;
 *           - seller rewards route to a locked rewards pool unless an on-chain
 *             unlock policy allows immediate claim;
 *           - optional pair-aware points policy hook for future buyer/seller
 *             reputation multipliers without changing this emissions contract.
 */
contract AntseedEmissionsV2 is Ownable, Pausable, ReentrancyGuard {
    // ─── Configuration ───
    IAntseedRegistry public registry;
    IAntseedLegacyEmissions public immutable legacyEmissions;
    IAntseedSellerRewardsPool public sellerRewardsPool;
    IAntseedSellerUnlockPolicy public sellerUnlockPolicy;
    IAntseedPointsPolicy public pointsPolicy;

    uint256 public immutable EPOCH_DURATION;
    uint256 public immutable HALVING_INTERVAL;
    uint256 public immutable INITIAL_EMISSION;
    uint256 public immutable genesis;
    uint256 public immutable MIGRATION_EPOCH;

    uint256 public SELLER_SHARE_PCT;
    uint256 public BUYER_SHARE_PCT;
    uint256 public RESERVE_SHARE_PCT;
    uint256 public TEAM_SHARE_PCT;
    uint256 public MAX_SELLER_SHARE_PCT;
    uint256 public MAX_BUYER_SHARE_PCT;

    // ─── Per-Epoch Params (snapshotted on first V2 touch) ───
    struct EpochParams {
        uint256 sellerSharePct;
        uint256 buyerSharePct;
        uint256 reserveSharePct;
        uint256 teamSharePct;
        uint256 maxSellerSharePct;
        uint256 maxBuyerSharePct;
        bool initialized;
    }

    mapping(uint256 => EpochParams) public epochParams;

    // ─── Per-Epoch Totals (V2 post-migration points only) ───
    mapping(uint256 => uint256) public epochTotalSellerPoints;
    mapping(uint256 => uint256) public epochTotalBuyerPoints;

    // ─── Per-User State (V2 post-migration points and V2 claims) ───
    mapping(address => mapping(uint256 => uint256)) public userSellerPoints;
    mapping(address => mapping(uint256 => uint256)) public userBuyerPoints;
    mapping(address => mapping(uint256 => bool)) public sellerEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public buyerEpochClaimed;

    // ─── Reserve & Team ───
    uint256 public reserveAccumulated;
    uint256 public teamAccumulated;
    mapping(uint256 => bool) public epochNonUserAccounted;

    // ─── Events ───
    event SellerPointsAccrued(address indexed seller, uint256 indexed epoch, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 indexed epoch, uint256 pointsDelta);
    event PairPointsAccrued(
        bytes32 indexed channelId,
        address indexed buyer,
        address indexed seller,
        uint256 epoch,
        uint256 rawPoints,
        uint256 creditedSellerPoints,
        uint256 creditedBuyerPoints
    );
    event EmissionsClaimed(address indexed account, address indexed recipient, uint256 amount, uint256[] epochs);
    event SellerEmissionsLocked(address indexed seller, address indexed pool, uint256 amount, uint256[] epochs);
    event ReserveFlushed(address indexed destination, uint256 amount);
    event TeamFlushed(address indexed destination, uint256 amount);
    event SellerRewardsPoolSet(address indexed pool);
    event SellerUnlockPolicySet(address indexed policy);
    event PointsPolicySet(address indexed policy);
    event MaxSellerSharePctSet(uint256 value);
    event MaxBuyerSharePctSet(uint256 value);

    // ─── Custom Errors ───
    error NotAuthorized();
    error EpochNotFinalized();
    error InvalidShareSum();
    error NoProtocolReserve();
    error NoTeamWallet();
    error NoReserve();
    error NoTeamAccumulated();
    error InvalidAddress();
    error InvalidValue();

    // ─── Modifiers ───
    modifier onlyChannels() {
        if (msg.sender != registry.channels()) revert NotAuthorized();
        _;
    }

    constructor(address _registry, address _legacyEmissions, address _sellerRewardsPool)
        Ownable(msg.sender)
        ReentrancyGuard()
    {
        if (_registry == address(0) || _legacyEmissions == address(0) || _sellerRewardsPool == address(0)) {
            revert InvalidAddress();
        }

        registry = IAntseedRegistry(_registry);
        legacyEmissions = IAntseedLegacyEmissions(_legacyEmissions);
        sellerRewardsPool = IAntseedSellerRewardsPool(_sellerRewardsPool);

        INITIAL_EMISSION = legacyEmissions.INITIAL_EMISSION();
        EPOCH_DURATION = legacyEmissions.EPOCH_DURATION();
        HALVING_INTERVAL = legacyEmissions.HALVING_INTERVAL();
        genesis = legacyEmissions.genesis();
        MIGRATION_EPOCH = legacyEmissions.currentEpoch();

        SELLER_SHARE_PCT = legacyEmissions.SELLER_SHARE_PCT();
        BUYER_SHARE_PCT = legacyEmissions.BUYER_SHARE_PCT();
        RESERVE_SHARE_PCT = legacyEmissions.RESERVE_SHARE_PCT();
        TEAM_SHARE_PCT = legacyEmissions.TEAM_SHARE_PCT();
        MAX_SELLER_SHARE_PCT = legacyEmissions.MAX_SELLER_SHARE_PCT();

        // Migration/legacy epochs are snapshotted uncapped. Future snapshots use this default.
        MAX_BUYER_SHARE_PCT = 5;
        for (uint256 i = 0; i <= MIGRATION_EPOCH; i++) {
            epochParams[i] = _legacyParamsForEpoch(i);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public view returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINT ACCRUAL
    // ═══════════════════════════════════════════════════════════════════

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlyChannels whenNotPaused {
        uint256 epoch = currentEpoch();
        _snapshotEpoch(epoch);
        userSellerPoints[seller][epoch] += pointsDelta;
        epochTotalSellerPoints[epoch] += pointsDelta;
        emit SellerPointsAccrued(seller, epoch, pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlyChannels whenNotPaused {
        uint256 epoch = currentEpoch();
        _snapshotEpoch(epoch);
        userBuyerPoints[buyer][epoch] += pointsDelta;
        epochTotalBuyerPoints[epoch] += pointsDelta;
        emit BuyerPointsAccrued(buyer, epoch, pointsDelta);
    }

    /// @notice Pair-aware accrual for future Channels versions.
    /// @dev Current deployed Channels can keep calling the two legacy accrual functions above.
    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta)
        external
        onlyChannels
        whenNotPaused
    {
        uint256 epoch = currentEpoch();
        (uint256 creditedSellerPoints, uint256 creditedBuyerPoints) =
            _policyPoints(channelId, buyer, seller, pointsDelta);
        _snapshotEpoch(epoch);

        userSellerPoints[seller][epoch] += creditedSellerPoints;
        epochTotalSellerPoints[epoch] += creditedSellerPoints;
        userBuyerPoints[buyer][epoch] += creditedBuyerPoints;
        epochTotalBuyerPoints[epoch] += creditedBuyerPoints;

        emit SellerPointsAccrued(seller, epoch, creditedSellerPoints);
        emit BuyerPointsAccrued(buyer, epoch, creditedBuyerPoints);
        emit PairPointsAccrued(
            channelId, buyer, seller, epoch, pointsDelta, creditedSellerPoints, creditedBuyerPoints
        );
    }

    function _snapshotEpoch(uint256 epoch) internal {
        if (!epochParams[epoch].initialized) {
            epochParams[epoch] = EpochParams({
                sellerSharePct: SELLER_SHARE_PCT,
                buyerSharePct: BUYER_SHARE_PCT,
                reserveSharePct: RESERVE_SHARE_PCT,
                teamSharePct: TEAM_SHARE_PCT,
                maxSellerSharePct: MAX_SELLER_SHARE_PCT,
                maxBuyerSharePct: MAX_BUYER_SHARE_PCT,
                initialized: true
            });
        }
    }

    function _policyPoints(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        internal
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        IAntseedPointsPolicy policy = pointsPolicy;
        if (address(policy) == address(0)) return (rawPoints, rawPoints);
        try policy.points(channelId, buyer, seller, rawPoints) returns (
            uint256 weightedSellerPoints,
            uint256 weightedBuyerPoints
        ) {
            return (weightedSellerPoints, weightedBuyerPoints);
        } catch {
            return (rawPoints, rawPoints);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function claimSellerEmissions(uint256[] calldata epochs) external nonReentrant whenNotPaused {
        uint256 _currentEpoch = currentEpoch();
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) revert EpochNotFinalized();
            if (_sellerEpochClaimed(msg.sender, epoch)) continue;

            uint256 userSP = _combinedUserSellerPoints(msg.sender, epoch);
            if (userSP == 0) continue;

            uint256 totalSP = _combinedTotalSellerPoints(epoch);
            if (totalSP == 0) continue;

            sellerEpochClaimed[msg.sender][epoch] = true;
            _accountReserveAndTeam(epoch);

            EpochParams memory params = epochParams[epoch];
            uint256 sBudget = (getEpochEmission(epoch) * params.sellerSharePct) / 100;
            uint256 reward = (userSP * sBudget) / totalSP;

            uint256 maxReward = (sBudget * params.maxSellerSharePct) / 100;
            if (reward > maxReward) {
                reserveAccumulated += reward - maxReward;
                reward = maxReward;
            }

            totalReward += reward;
        }

        if (totalReward > 0) {
            if (_canClaimSellerUnlocked(msg.sender)) {
                IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
                emit EmissionsClaimed(msg.sender, msg.sender, totalReward, epochs);
            } else {
                address pool = address(sellerRewardsPool);
                IANTSToken(registry.antsToken()).mint(pool, totalReward);
                sellerRewardsPool.recordLockedReward(msg.sender, totalReward);
                emit SellerEmissionsLocked(msg.sender, pool, totalReward, epochs);
                emit EmissionsClaimed(msg.sender, pool, totalReward, epochs);
            }
        }
    }

    function claimBuyerEmissions(address buyer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        if (IAntseedDeposits(registry.deposits()).getOperator(buyer) != msg.sender) revert NotAuthorized();

        uint256 _currentEpoch = currentEpoch();
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) revert EpochNotFinalized();
            if (_buyerEpochClaimed(buyer, epoch)) continue;

            uint256 userBP = _combinedUserBuyerPoints(buyer, epoch);
            if (userBP == 0) continue;

            uint256 totalBP = _combinedTotalBuyerPoints(epoch);
            if (totalBP == 0) continue;

            buyerEpochClaimed[buyer][epoch] = true;
            _accountReserveAndTeam(epoch);

            EpochParams memory params = epochParams[epoch];
            uint256 bBudget = (getEpochEmission(epoch) * params.buyerSharePct) / 100;
            uint256 reward = (userBP * bBudget) / totalBP;

            uint256 maxReward = (bBudget * params.maxBuyerSharePct) / 100;
            if (reward > maxReward) {
                reserveAccumulated += reward - maxReward;
                reward = maxReward;
            }

            totalReward += reward;
        }

        if (totalReward > 0) {
            IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
            emit EmissionsClaimed(buyer, msg.sender, totalReward, epochs);
        }
    }

    function pendingEmissions(address account, uint256[] calldata epochs)
        external
        view
        returns (uint256 totalSeller, uint256 totalBuyer)
    {
        uint256 _currentEpoch = currentEpoch();

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) continue;

            EpochParams memory params = epochParams[epoch];

            if (!_sellerEpochClaimed(account, epoch)) {
                uint256 userSP = _combinedUserSellerPoints(account, epoch);
                uint256 totalSP = _combinedTotalSellerPoints(epoch);
                if (userSP > 0 && totalSP > 0) {
                    uint256 sBudget = (getEpochEmission(epoch) * params.sellerSharePct) / 100;
                    uint256 reward = (userSP * sBudget) / totalSP;
                    uint256 maxReward = (sBudget * params.maxSellerSharePct) / 100;
                    totalSeller += reward > maxReward ? maxReward : reward;
                }
            }

            if (!_buyerEpochClaimed(account, epoch)) {
                uint256 userBP = _combinedUserBuyerPoints(account, epoch);
                uint256 totalBP = _combinedTotalBuyerPoints(epoch);
                if (userBP > 0 && totalBP > 0) {
                    uint256 bBudget = (getEpochEmission(epoch) * params.buyerSharePct) / 100;
                    uint256 reward = (userBP * bBudget) / totalBP;
                    uint256 maxReward = (bBudget * params.maxBuyerSharePct) / 100;
                    totalBuyer += reward > maxReward ? maxReward : reward;
                }
            }
        }
    }

    function _accountReserveAndTeam(uint256 epoch) internal {
        if (!epochNonUserAccounted[epoch]) {
            epochNonUserAccounted[epoch] = true;

            // Previous epochs were already accounted in V1. The migration epoch
            // and all future epochs are accounted in V2.
            if (epoch >= MIGRATION_EPOCH) {
                EpochParams memory params = epochParams[epoch];
                uint256 emission = getEpochEmission(epoch);
                reserveAccumulated += (emission * params.reserveSharePct) / 100;
                teamAccumulated += (emission * params.teamSharePct) / 100;
            }
        }
    }

    function _canClaimSellerUnlocked(address seller) internal view returns (bool) {
        IAntseedSellerUnlockPolicy policy = sellerUnlockPolicy;
        if (address(policy) == address(0)) return false;
        try policy.canClaimSellerUnlocked(seller) returns (bool allowed) {
            return allowed;
        } catch {
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        LEGACY + V2 STATE HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _sellerEpochClaimed(address seller, uint256 epoch) internal view returns (bool) {
        if (sellerEpochClaimed[seller][epoch]) return true;
        if (epoch < MIGRATION_EPOCH) return legacyEmissions.sellerEpochClaimed(seller, epoch);
        return false;
    }

    function _buyerEpochClaimed(address buyer, uint256 epoch) internal view returns (bool) {
        if (buyerEpochClaimed[buyer][epoch]) return true;
        if (epoch < MIGRATION_EPOCH) return legacyEmissions.buyerEpochClaimed(buyer, epoch);
        return false;
    }

    function _combinedUserSellerPoints(address seller, uint256 epoch) internal view returns (uint256 points) {
        points = userSellerPoints[seller][epoch];
        if (epoch <= MIGRATION_EPOCH) points += legacyEmissions.userSellerPoints(seller, epoch);
    }

    function _combinedUserBuyerPoints(address buyer, uint256 epoch) internal view returns (uint256 points) {
        points = userBuyerPoints[buyer][epoch];
        if (epoch <= MIGRATION_EPOCH) points += legacyEmissions.userBuyerPoints(buyer, epoch);
    }

    function _combinedTotalSellerPoints(uint256 epoch) internal view returns (uint256 points) {
        points = epochTotalSellerPoints[epoch];
        if (epoch <= MIGRATION_EPOCH) points += legacyEmissions.epochTotalSellerPoints(epoch);
    }

    function _combinedTotalBuyerPoints(uint256 epoch) internal view returns (uint256 points) {
        points = epochTotalBuyerPoints[epoch];
        if (epoch <= MIGRATION_EPOCH) points += legacyEmissions.epochTotalBuyerPoints(epoch);
    }

    function _legacyParamsForEpoch(uint256 epoch) internal view returns (EpochParams memory params) {
        (
            params.sellerSharePct,
            params.buyerSharePct,
            params.reserveSharePct,
            params.teamSharePct,
            params.maxSellerSharePct,
            params.initialized
        ) = legacyEmissions.epochParams(epoch);
        params.maxBuyerSharePct = 100;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function flushReserve() external onlyOwner nonReentrant {
        address dest = registry.protocolReserve();
        if (dest == address(0)) revert NoProtocolReserve();
        uint256 amount = reserveAccumulated;
        if (amount == 0) revert NoReserve();
        reserveAccumulated = 0;
        IANTSToken(registry.antsToken()).mint(dest, amount);
        emit ReserveFlushed(dest, amount);
    }

    function flushTeam() external onlyOwner nonReentrant {
        address dest = registry.teamWallet();
        if (dest == address(0)) revert NoTeamWallet();
        uint256 amount = teamAccumulated;
        if (amount == 0) revert NoTeamAccumulated();
        teamAccumulated = 0;
        IANTSToken(registry.antsToken()).mint(dest, amount);
        emit TeamFlushed(dest, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setSellerRewardsPool(address pool) external onlyOwner {
        if (pool == address(0)) revert InvalidAddress();
        sellerRewardsPool = IAntseedSellerRewardsPool(pool);
        emit SellerRewardsPoolSet(pool);
    }

    function setSellerUnlockPolicy(address policy) external onlyOwner {
        sellerUnlockPolicy = IAntseedSellerUnlockPolicy(policy);
        emit SellerUnlockPolicySet(policy);
    }

    function setPointsPolicy(address policy) external onlyOwner {
        pointsPolicy = IAntseedPointsPolicy(policy);
        emit PointsPolicySet(policy);
    }

    function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct, uint256 teamPct)
        external
        onlyOwner
    {
        if (sellerPct + buyerPct + reservePct + teamPct != 100) revert InvalidShareSum();
        SELLER_SHARE_PCT = sellerPct;
        BUYER_SHARE_PCT = buyerPct;
        RESERVE_SHARE_PCT = reservePct;
        TEAM_SHARE_PCT = teamPct;
    }

    function setMaxSellerSharePct(uint256 value) external onlyOwner {
        if (value > 100) revert InvalidValue();
        MAX_SELLER_SHARE_PCT = value;
        emit MaxSellerSharePctSet(value);
    }

    /// @notice Set buyer cap for future epoch snapshots. Already-snapshotted epochs are unchanged.
    function setMaxBuyerSharePct(uint256 value) external onlyOwner {
        if (value > 100) revert InvalidValue();
        MAX_BUYER_SHARE_PCT = value;
        emit MaxBuyerSharePctSet(value);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
