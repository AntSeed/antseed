// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistryV2 } from "../interfaces/IAntseedRegistryV2.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedSellerPoolsRewards
 * @notice Lazy seller-pool reward controller for recognized usage.
 *
 *         Usage accounting records raw seller usage and weighted pool points
 *         during each epoch. The pool epoch is settled once, and staker
 *         positions split the settled claimable budget:
 *
 *         poolReward = sellerPoolsBudget(epoch) * poolWeightedPoints / totalWeightedPoints
 *         positionReward = poolReward * positionWeight / poolWeight
 *
 *         Unallocated dynamic staker budget is settled separately through the
 *         emissions gate, where global burn/reserve routing is enforced.
 *
 *         Important behavior:
 *           - This is the staker pool-reward controller, separate from the
 *             direct seller/operator usage rewards.
 *           - Pool epochs are indexed before staker claim/restake. Settlement
 *             mints pool-level claimable ANTS to this contract.
 *           - Restaking rewards creates a new locked position in the source
 *             agent pool and may receive a configured weight bonus based on lock
 *             length.
 *           - Position reward claims use indexed pool accounting and do not
 *             loop over every epoch since the position started.
 */
contract AntseedSellerPoolsRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using Math for uint256;
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant GATE_SHARE_DENOMINATOR = 100_000;
    uint256 public constant INDEX_SCALE = 1e30;
    uint32 public constant MAX_STAKER_SHARE_BPS = 40_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedSellerPools public immutable sellerPools;
    IAntseedUsageAccounting public immutable usageAccounting;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(uint256 => bool) public epochRemainderSettled;
    /// @dev Budget frozen at first settlement use (stored as budget + 1 so a
    ///      frozen zero is distinguishable from unset). Later dynamic-config
    ///      changes must not retroactively resize a finalized epoch's budget:
    ///      remainder settlement and lazy pool settlement share one gate
    ///      bucket, and a mid-flight resize would over-commit it.
    mapping(uint256 => uint256) private _frozenStakerBudgets;
    mapping(uint256 => mapping(uint256 => PoolEpochEmission)) public poolEpochEmissions;
    mapping(uint256 => uint256) public poolRewardIndexNextEpoch;
    mapping(uint256 => uint256) public positionClaimCursor;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeRewardPerWeight;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeEpochRewardPerWeight;
    uint256 public immutable initialIndexEpoch;

    // ─── Dynamic Share Config ────────────────────────────────────────
    uint32 public stakerMinShareBps = 2_000;
    uint32 public stakerMaxShareBps = 40_000;
    uint256 public stakeShareTarget = 400_000_000e18;

    struct ClaimRoute {
        address recipient;
        address staker;
        bool emitClaimEvents;
    }

    struct PoolEpochEmission {
        bool settled;
        uint256 grossAmount;
        uint256 claimableAmount;
        // Retained for event/storage compatibility. Pool-level APY clipping
        // was removed; burn/reserve routing now happens in settleEpochRemainder.
        uint256 burnedAmount;
        uint256 reserveAmount;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event StakerUsageRewardRestaked(
        uint256 indexed sourcePositionId,
        uint256 indexed newPositionId,
        address indexed staker,
        uint256 amount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event PoolUsageRewardSettled(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event PoolUsageRewardIndexed(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 rewardPerWeight,
        uint256 cumulativeRewardPerWeight,
        uint256 cumulativeEpochRewardPerWeight
    );
    event StakerUsageRewardsClaimed(
        uint256 indexed positionId,
        address indexed staker,
        address indexed recipient,
        uint256 fromEpoch,
        uint256 toEpoch,
        uint256 claimableAmount
    );
    event DynamicStakerConfigSet(uint32 minShareBps, uint32 maxShareBps, uint256 stakeShareTarget);
    event StakerEpochBudgetFrozen(uint256 indexed epoch, uint256 budget);
    event StakerRewardRemainderSettled(
        uint256 indexed epoch, uint256 unallocatedAmount, uint256 burnedAmount, uint256 reserveAmount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotPositionOwner();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsGate, address _sellerPools, address _usageAccounting) Ownable(msg.sender) {
        if (_emissionsGate == address(0) || _sellerPools == address(0) || _usageAccounting == address(0)) {
            revert InvalidAddress();
        }
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        sellerPools = IAntseedSellerPools(_sellerPools);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        initialIndexEpoch = IAntseedUsageAccounting(_usageAccounting).currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function indexPoolRewards(uint256 agentId, uint256 maxEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 nextEpoch)
    {
        if (agentId == 0 || maxEpochs == 0) revert InvalidValue();

        nextEpoch = poolRewardIndexNextEpoch[agentId];
        if (nextEpoch == 0) nextEpoch = initialIndexEpoch;

        uint256 currentEpoch_ = sellerPools.currentEpoch();
        uint256 limit = nextEpoch + maxEpochs;
        if (limit > currentEpoch_) limit = currentEpoch_;

        while (nextEpoch < limit) {
            _indexPoolRewardEpoch(agentId, nextEpoch);
            nextEpoch++;
        }
        poolRewardIndexNextEpoch[agentId] = nextEpoch;
    }

    function claimStakerRewards(uint256 positionId, address recipient) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 claimedAmount = _claimIndexedStakerRewards(positionId, ClaimRoute(recipient, msg.sender, true));
        if (claimedAmount == 0) revert NothingToClaim();
    }

    function claimStakerRewardsBatch(uint256[] calldata positionIds, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (positionIds.length == 0) revert InvalidValue();

        uint256 totalClaimed;
        for (uint256 p = 0; p < positionIds.length; p++) {
            totalClaimed += _claimIndexedStakerRewards(positionIds[p], ClaimRoute(recipient, msg.sender, true));
        }
        if (totalClaimed == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function restakeStakerRewards(uint256 positionId, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        uint256 totalRestaked =
            _claimIndexedStakerRewards(positionId, ClaimRoute(address(sellerPools), msg.sender, false));
        if (totalRestaked == 0) revert NothingToClaim();
        newPositionId = sellerPools.stakeMintedReward(msg.sender, positionId, totalRestaked, stakeEpochs);
        emit StakerUsageRewardRestaked(positionId, newPositionId, msg.sender, totalRestaked, 0, 0);
    }

    function restakeStakerRewardsBatch(uint256[] calldata positionIds, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();

        newPositionIds = new uint256[](positionIds.length);
        uint256 totalRestakedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            uint256 totalRestaked =
                _claimIndexedStakerRewards(positionIds[p], ClaimRoute(address(sellerPools), msg.sender, false));
            if (totalRestaked == 0) continue;

            totalRestakedAll += totalRestaked;
            newPositionIds[p] = sellerPools.stakeMintedReward(msg.sender, positionIds[p], totalRestaked, stakeEpochs);
            emit StakerUsageRewardRestaked(positionIds[p], newPositionIds[p], msg.sender, totalRestaked, 0, 0);
        }
        if (totalRestakedAll == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingStakerReward(uint256 positionId, uint256 epoch)
        external
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        (address owner, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        (grossAmount, claimableAmount, burnedAmount) = _positionReward(positionId, agentId, epoch);
    }

    function pendingIndexedStakerReward(uint256 positionId) external view returns (uint256 claimableAmount) {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(positionId, weightAmount, fromEpoch, toEpoch);
    }

    function poolCumulativeRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    function poolCumulativeEpochRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setDynamicStakerConfig(uint32 minShareBps, uint32 maxShareBps, uint256 _stakeShareTarget)
        external
        onlyOwner
    {
        if (minShareBps > maxShareBps || maxShareBps > MAX_STAKER_SHARE_BPS || _stakeShareTarget == 0) {
            revert InvalidValue();
        }
        stakerMinShareBps = minShareBps;
        stakerMaxShareBps = maxShareBps;
        stakeShareTarget = _stakeShareTarget;
        emit DynamicStakerConfigSet(minShareBps, maxShareBps, _stakeShareTarget);
    }

    function stakerEpochBudget(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenStakerBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        return _liveStakerEpochBudget(epoch);
    }

    function _liveStakerEpochBudget(uint256 epoch) internal view returns (uint256) {
        uint256 activeStake = sellerPools.totalActiveStakeAtEpoch(epoch);
        uint32 shareBps = _saturatingShareBps(activeStake, stakerMinShareBps, stakerMaxShareBps, stakeShareTarget);
        if (shareBps == 0) return 0;

        uint256 desiredBudget = Math.mulDiv(emissionsGate.getEpochEmission(epoch), shareBps, GATE_SHARE_DENOMINATOR);
        uint256 maxBudget = emissionsGate.controllerEpochBudget(address(this), epoch);
        return desiredBudget < maxBudget ? desiredBudget : maxBudget;
    }

    function _freezeStakerEpochBudget(uint256 epoch) internal returns (uint256 budget) {
        uint256 frozen = _frozenStakerBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        budget = _liveStakerEpochBudget(epoch);
        _frozenStakerBudgets[epoch] = budget + 1;
        emit StakerEpochBudgetFrozen(epoch, budget);
    }

    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();

        uint256 maxBudget = emissionsGate.controllerEpochBudget(address(this), epoch);
        // An epoch with no weighted usage can never mint through pool
        // settlement, so its whole bucket is remainder — the stake-based
        // budget would otherwise be stranded outside the burn/reserve route.
        uint256 allocatedBudget =
            usageAccounting.totalWeightedPoolPointsByEpoch(epoch) == 0 ? 0 : _freezeStakerEpochBudget(epoch);
        if (allocatedBudget >= maxBudget) revert NothingToClaim();

        uint256 unallocatedAmount = maxBudget - allocatedBudget;
        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, _emissionsReserve(), unallocatedAmount);
        emit StakerRewardRemainderSettled(epoch, unallocatedAmount, burnedAmount, reserveAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _claimIndexedStakerRewards(uint256 positionId, ClaimRoute memory route)
        internal
        returns (uint256 claimableAmount)
    {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        if (owner != route.staker) revert NotPositionOwner();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(positionId, weightAmount, fromEpoch, toEpoch);
        if (claimableAmount == 0) return 0;

        positionClaimCursor[positionId] = toEpoch;
        _transferReward(route.recipient, claimableAmount);
        if (route.emitClaimEvents) {
            emit StakerUsageRewardsClaimed(
                positionId, route.staker, route.recipient, fromEpoch, toEpoch, claimableAmount
            );
        }
    }

    function _positionIndexedReward(uint256 positionId, uint256 weightAmount, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256 rewardAmount)
    {
        uint256 cursor = fromEpoch;
        while (cursor < toEpoch) {
            (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch) =
                sellerPools.positionPowerSegmentAt(positionId, cursor);
            uint256 segmentEnd = nextChangeEpoch < toEpoch ? nextChangeEpoch : toEpoch;
            if (segmentEnd <= cursor) break;

            if (maxLockPower != 0) {
                uint256 rewardDelta = _cumulativeRewardDelta(positionId, cursor, segmentEnd);
                rewardAmount += Math.mulDiv(maxLockPower, rewardDelta, INDEX_SCALE);
            } else if (normalEndEpoch != 0 && cursor < normalEndEpoch) {
                if (segmentEnd > normalEndEpoch) segmentEnd = normalEndEpoch;
                uint256 rewardDelta = _cumulativeRewardDelta(positionId, cursor, segmentEnd);
                uint256 epochRewardDelta = _cumulativeEpochRewardDelta(positionId, cursor, segmentEnd);
                rewardAmount += Math.mulDiv(weightAmount, normalEndEpoch * rewardDelta - epochRewardDelta, INDEX_SCALE);
            }

            cursor = segmentEnd;
        }
    }

    function _indexPoolRewardEpoch(uint256 agentId, uint256 epoch) internal {
        (PoolEpochEmission storage emission,,) = _settlePoolEpoch(agentId, epoch);

        uint256 rewardPerWeight;
        uint256 poolWeight = sellerPools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight != 0 && emission.claimableAmount != 0) {
            rewardPerWeight = Math.mulDiv(emission.claimableAmount, INDEX_SCALE, poolWeight);
        }

        uint256 cumulativeReward = _poolCumulativeRewardPerWeight[agentId].latest() + rewardPerWeight;
        uint256 cumulativeEpochReward = _poolCumulativeEpochRewardPerWeight[agentId].latest() + rewardPerWeight * epoch;
        if (rewardPerWeight != 0) {
            _poolCumulativeRewardPerWeight[agentId].push(epoch + 1, cumulativeReward);
            _poolCumulativeEpochRewardPerWeight[agentId].push(epoch + 1, cumulativeEpochReward);
        }

        emit PoolUsageRewardIndexed(agentId, epoch, rewardPerWeight, cumulativeReward, cumulativeEpochReward);
    }

    function _cumulativeRewardDelta(uint256 positionId, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256)
    {
        (, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        return _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(toEpoch)
            - _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(fromEpoch);
    }

    function _cumulativeEpochRewardDelta(uint256 positionId, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256)
    {
        (, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        return _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(toEpoch)
            - _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(fromEpoch);
    }

    function _positionReward(uint256 positionId, uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        if (agentId == 0 || epoch < positionClaimCursor[positionId]) return (0, 0, 0);

        IAntseedSellerPools pools = sellerPools;
        uint256 positionWeight = pools.positionWeightAtEpoch(positionId, epoch);
        if (positionWeight == 0) return (0, 0, 0);

        uint256 poolWeight = pools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight == 0) return (0, 0, 0);

        (uint256 poolGrossReward, uint256 poolClaimableReward) = _poolRewardPreview(agentId, epoch);
        if (poolGrossReward == 0) return (0, 0, 0);

        grossAmount = Math.mulDiv(poolGrossReward, positionWeight, poolWeight);
        claimableAmount = Math.mulDiv(poolClaimableReward, positionWeight, poolWeight);
        burnedAmount = grossAmount - claimableAmount;
    }

    function _settlePoolEpoch(uint256 agentId, uint256 epoch)
        internal
        returns (PoolEpochEmission storage emission, uint256 burnedAmount, uint256 reserveAmount)
    {
        emission = poolEpochEmissions[epoch][agentId];
        if (emission.settled) return (emission, 0, 0);

        _freezeStakerEpochBudget(epoch);
        (uint256 grossAmount, uint256 claimableAmount) = _poolRewardPreview(agentId, epoch);
        emission.settled = true;
        emission.grossAmount = grossAmount;
        emission.claimableAmount = claimableAmount;
        emission.burnedAmount = burnedAmount;
        emission.reserveAmount = reserveAmount;

        _mint(epoch, address(this), claimableAmount);
        emit PoolUsageRewardSettled(agentId, epoch, grossAmount, claimableAmount, burnedAmount, reserveAmount);
    }

    function _poolRewardPreview(uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount)
    {
        PoolEpochEmission memory settledEmission = poolEpochEmissions[epoch][agentId];
        if (settledEmission.settled) {
            return (settledEmission.grossAmount, settledEmission.claimableAmount);
        }

        grossAmount = _poolGrossReward(agentId, epoch);
        if (grossAmount == 0) return (0, 0);

        claimableAmount = grossAmount;
    }

    function _poolGrossReward(uint256 agentId, uint256 epoch) internal view returns (uint256) {
        IAntseedUsageAccounting accounting = usageAccounting;
        uint256 poolPoints = accounting.weightedPoolPointsByEpoch(epoch, agentId);
        uint256 totalPoints = accounting.totalWeightedPoolPointsByEpoch(epoch);
        if (poolPoints == 0 || totalPoints == 0) return 0;

        uint256 budget = stakerEpochBudget(epoch);
        if (budget == 0) return 0;
        return Math.mulDiv(budget, poolPoints, totalPoints);
    }

    function _mint(uint256 epoch, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        emissionsGate.claim(epoch, recipient, amount);
    }

    function _transferReward(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(_antsToken()).safeTransfer(recipient, amount);
    }

    function _saturatingShareBps(uint256 metric, uint32 minShareBps, uint32 maxShareBps, uint256 target)
        internal
        pure
        returns (uint32)
    {
        if (metric == 0) return 0;
        if (target == 0) return maxShareBps;
        return uint32(uint256(minShareBps) + Math.mulDiv(maxShareBps - minShareBps, metric, metric + target));
    }

    /// @dev ANTS reserve flows go to the registry's dedicated emissions
    ///      reserve; while the split is unset they fall back to the fee
    ///      reserve (`protocolReserve`). The seller pools this controller is
    ///      wired to must live on a v2 registry.
    function _emissionsReserve() internal view returns (address reserve) {
        IAntseedRegistryV2 registry = IAntseedRegistryV2(address(sellerPools.registry()));
        reserve = registry.emissionsReserve();
        if (reserve == address(0)) reserve = registry.protocolReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }

    function _antsToken() internal view returns (address token) {
        token = sellerPools.registry().antsToken();
        if (token == address(0)) revert InvalidAddress();
    }
}
