// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";
import { AntseedShareMath } from "./AntseedShareMath.sol";

/**
 * @title AntseedUsageRewards
 * @notice Controller for direct seller/operator and buyer recognized usage
 *         rewards.
 *
 *         AntseedEmissionsGate owns one 10% usage budget. This controller
 *         reads weighted usage points from AntseedUsageAccounting, splits the
 *         usage budget 50/50 between seller/operator and buyer rewards, and
 *         mints through that explicit usage bucket.
 *
 *         Important behavior:
 *           - Seller/operator rewards pay the current ERC-8004 agent owner.
 *           - Buyer rewards pay the buyer's Deposits operator; the buyer hot
 *             wallet itself never receives rewards.
 *           - Both sides are capped per account/agent at 5% of that side's
 *             epoch budget; overflow routes to protocol reserve.
 */
contract AntseedUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant GATE_SHARE_DENOMINATOR = 100_000;
    uint256 public constant MAX_REWARD_SHARE_BPS = 500;
    uint32 public constant MAX_BUYER_SHARE_BPS = 10_000;
    uint32 public constant MAX_SELLER_SHARE_BPS = 10_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedRegistry public immutable registry;
    IAntseedUsageAccounting public immutable usageAccounting;
    IAntseedSellerPools public sellerPools;

    /// @notice Contract allowed to initiate agent reward claims on a seller's
    ///         behalf via `claimAgentRewardFor`. Rewards still pay the agent
    ///         owner, so the forwarder can only trigger a claim, never divert
    ///         it. Used by the registry-emissions adapter that serves
    ///         deployed seller delegation contracts (e.g. DiemStakingProxy).
    address public claimForwarder;

    // ─── Claim State ─────────────────────────────────────────────────
    /// @dev Budgets frozen at first claim/settlement use of an epoch. Later
    ///      dynamic-config changes must not retroactively resize a finalized
    ///      epoch's budgets: claims and remainder settlement share one gate
    ///      bucket, and a mid-flight resize would over-commit it or skew
    ///      early vs late claimants.
    struct FrozenUsageBudgets {
        bool frozen;
        uint256 buyerBudget;
        uint256 sellerBudget;
    }

    mapping(uint256 => FrozenUsageBudgets) private _frozenUsageBudgets;
    mapping(uint256 => mapping(uint256 => bool)) public agentEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public buyerEpochClaimed;
    mapping(uint256 => bool) public epochRemainderSettled;

    // ─── Dynamic Share Config ────────────────────────────────────────
    uint32 public buyerMinShareBps = 5_000;
    uint32 public buyerMaxShareBps = 10_000;
    uint32 public sellerMinShareBps = 5_000;
    uint32 public sellerMaxShareBps = 10_000;
    uint256 public volumeShareTarget = 1_000_000e6;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerPoolsSet(address indexed sellerPools);
    event ClaimForwarderSet(address indexed claimForwarder);
    event SellerOperatorRewardClaimed(
        address indexed seller,
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );
    event SellerOperatorRewardStaked(
        address indexed seller,
        uint256 indexed agentId,
        uint256 epoch,
        uint256 newPositionId,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 stakedAmount,
        uint256 reserveAmount
    );
    event BuyerUsageRewardClaimed(
        address indexed buyer,
        address indexed recipient,
        uint256 indexed epoch,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );
    event BuyerUsageRewardStaked(
        address indexed buyer,
        address indexed operator,
        uint256 indexed stakeAgentId,
        uint256 epoch,
        uint256 newPositionId,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 stakedAmount,
        uint256 reserveAmount
    );
    event DynamicUsageConfigSet(
        uint32 buyerMinShareBps,
        uint32 buyerMaxShareBps,
        uint32 sellerMinShareBps,
        uint32 sellerMaxShareBps,
        uint256 volumeShareTarget
    );
    event UsageEpochBudgetsFrozen(uint256 indexed epoch, uint256 buyerBudget, uint256 sellerBudget);
    event UsageRewardRemainderSettled(
        uint256 indexed epoch, uint256 unallocatedAmount, uint256 burnedAmount, uint256 reserveAmount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotRewardRecipient();
    error RewardRecipientUnavailable();
    error NotClaimForwarder();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsGate, address _registry, address _usageAccounting) Ownable(msg.sender) {
        if (_emissionsGate == address(0) || _registry == address(0) || _usageAccounting == address(0)) {
            revert InvalidAddress();
        }

        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        registry = IAntseedRegistry(_registry);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM SELLER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimAgentReward(uint256 agentId, uint256 epoch) external nonReentrant whenNotPaused {
        _claimAgentReward(agentId, epoch, msg.sender);
    }

    /// @notice Claim an agent's reward on the seller's behalf. Restricted to
    ///         the configured claim forwarder; the reward is verified against
    ///         and paid to the agent owner exactly as in `claimAgentReward`.
    function claimAgentRewardFor(address seller, uint256 agentId, uint256 epoch) external nonReentrant whenNotPaused {
        if (msg.sender != claimForwarder || claimForwarder == address(0)) revert NotClaimForwarder();
        _claimAgentReward(agentId, epoch, seller);
    }

    function stakeAgentReward(uint256 agentId, uint256 epoch, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        newPositionId = _stakeAgentReward(agentId, epoch, stakeEpochs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM BUYER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimBuyerReward(address buyer, uint256 epoch) external nonReentrant whenNotPaused {
        _claimBuyerReward(buyer, epoch);
    }

    function stakeBuyerReward(address buyer, uint256 epoch, uint256 stakeAgentId, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        newPositionId = _stakeBuyerReward(buyer, epoch, stakeAgentId, stakeEpochs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingAgentReward(uint256 agentId, uint256 epoch) external view returns (uint256 amount) {
        return _pendingAgentReward(agentId, epoch);
    }

    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _buyerShare(buyer, epoch);
        return _pendingReward(buyerEpochBudget(epoch), weightedPoints, totalWeightedPoints);
    }

    function rewardRecipient(uint256 agentId) external view returns (address) {
        return _agentOwner(agentId);
    }

    function _pendingAgentReward(uint256 agentId, uint256 epoch) internal view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _agentShare(agentId, epoch);
        return _pendingReward(sellerEpochBudget(epoch), weightedPoints, totalWeightedPoints);
    }

    function _pendingReward(uint256 epochBudget, uint256 weightedPoints, uint256 totalWeightedPoints)
        internal
        pure
        returns (uint256)
    {
        if (weightedPoints == 0 || totalWeightedPoints == 0) return 0;
        uint256 grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        return grossAmount < cap ? grossAmount : cap;
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

    /// @notice Set (or clear) the contract allowed to initiate owner-destined
    ///         claims via `claimAgentRewardFor`.
    function setClaimForwarder(address _claimForwarder) external onlyOwner {
        claimForwarder = _claimForwarder;
        emit ClaimForwarderSet(_claimForwarder);
    }

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setDynamicUsageConfig(
        uint32 _buyerMinShareBps,
        uint32 _buyerMaxShareBps,
        uint32 _sellerMinShareBps,
        uint32 _sellerMaxShareBps,
        uint256 _volumeShareTarget
    ) external onlyOwner {
        if (
            _buyerMinShareBps > _buyerMaxShareBps || _sellerMinShareBps > _sellerMaxShareBps
                || _buyerMaxShareBps > MAX_BUYER_SHARE_BPS || _sellerMaxShareBps > MAX_SELLER_SHARE_BPS
                || _volumeShareTarget == 0
        ) revert InvalidValue();

        buyerMinShareBps = _buyerMinShareBps;
        buyerMaxShareBps = _buyerMaxShareBps;
        sellerMinShareBps = _sellerMinShareBps;
        sellerMaxShareBps = _sellerMaxShareBps;
        volumeShareTarget = _volumeShareTarget;

        emit DynamicUsageConfigSet(
            _buyerMinShareBps, _buyerMaxShareBps, _sellerMinShareBps, _sellerMaxShareBps, _volumeShareTarget
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Values shared by the claim and stake tails of a reward: share,
    ///      frozen-budget amounts, and the verified recipient. Populated by
    ///      `_prepareAgentReward` / `_prepareBuyerReward`, which also mark
    ///      the epoch claimed.
    struct PreparedReward {
        address recipient;
        uint256 weightedPoints;
        uint256 totalWeightedPoints;
        uint256 grossAmount;
        uint256 claimableAmount;
        uint256 reserveAmount;
    }

    function _prepareAgentReward(uint256 agentId, uint256 epoch, address claimant)
        internal
        returns (PreparedReward memory reward)
    {
        if (agentId == 0) revert InvalidAddress();
        if (agentEpochClaimed[agentId][epoch]) revert AlreadyClaimed();

        (reward.weightedPoints, reward.totalWeightedPoints) = _agentShare(agentId, epoch);
        (, uint256 sellerBudget) = _freezeUsageEpochBudgets(epoch);
        (reward.grossAmount, reward.claimableAmount, reward.reserveAmount) =
            _rewardAmounts(sellerBudget, reward.weightedPoints, reward.totalWeightedPoints);

        reward.recipient = _agentOwner(agentId);
        if (claimant != reward.recipient) revert NotRewardRecipient();

        agentEpochClaimed[agentId][epoch] = true;
    }

    function _claimAgentReward(uint256 agentId, uint256 epoch, address claimant) internal {
        PreparedReward memory reward = _prepareAgentReward(agentId, epoch, claimant);
        _mintReward(epoch, reward.recipient, reward.claimableAmount, reward.reserveAmount);

        emit SellerOperatorRewardClaimed(
            reward.recipient,
            agentId,
            epoch,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    function _stakeAgentReward(uint256 agentId, uint256 epoch, uint256 stakeEpochs)
        internal
        returns (uint256 newPositionId)
    {
        PreparedReward memory reward = _prepareAgentReward(agentId, epoch, msg.sender);
        newPositionId = _stakeClaimedReward(
            reward.recipient, agentId, stakeEpochs, epoch, reward.claimableAmount, reward.reserveAmount
        );

        emit SellerOperatorRewardStaked(
            reward.recipient,
            agentId,
            epoch,
            newPositionId,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    function _prepareBuyerReward(address buyer, uint256 epoch) internal returns (PreparedReward memory reward) {
        if (buyer == address(0)) revert InvalidAddress();
        if (buyerEpochClaimed[buyer][epoch]) revert AlreadyClaimed();

        (reward.weightedPoints, reward.totalWeightedPoints) = _buyerShare(buyer, epoch);
        (uint256 buyerBudget,) = _freezeUsageEpochBudgets(epoch);
        (reward.grossAmount, reward.claimableAmount, reward.reserveAmount) =
            _rewardAmounts(buyerBudget, reward.weightedPoints, reward.totalWeightedPoints);

        reward.recipient = _buyerRewardRecipient(buyer);
        if (msg.sender != reward.recipient) revert NotRewardRecipient();

        buyerEpochClaimed[buyer][epoch] = true;
    }

    function _claimBuyerReward(address buyer, uint256 epoch) internal {
        PreparedReward memory reward = _prepareBuyerReward(buyer, epoch);
        _mintReward(epoch, reward.recipient, reward.claimableAmount, reward.reserveAmount);

        emit BuyerUsageRewardClaimed(
            buyer,
            reward.recipient,
            epoch,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    function _stakeBuyerReward(address buyer, uint256 epoch, uint256 stakeAgentId, uint256 stakeEpochs)
        internal
        returns (uint256 newPositionId)
    {
        if (stakeAgentId == 0) revert InvalidAddress();
        PreparedReward memory reward = _prepareBuyerReward(buyer, epoch);
        newPositionId = _stakeClaimedReward(
            reward.recipient, stakeAgentId, stakeEpochs, epoch, reward.claimableAmount, reward.reserveAmount
        );

        emit BuyerUsageRewardStaked(
            buyer,
            reward.recipient,
            stakeAgentId,
            epoch,
            newPositionId,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    function buyerEpochBudget(uint256 epoch) public view returns (uint256) {
        (uint256 buyerBudget,) = usageEpochBudgets(epoch);
        return buyerBudget;
    }

    function sellerEpochBudget(uint256 epoch) public view returns (uint256) {
        (, uint256 sellerBudget) = usageEpochBudgets(epoch);
        return sellerBudget;
    }

    function usageEpochBudgets(uint256 epoch) public view returns (uint256 buyerBudget, uint256 sellerBudget) {
        FrozenUsageBudgets memory frozen = _frozenUsageBudgets[epoch];
        if (frozen.frozen) return (frozen.buyerBudget, frozen.sellerBudget);
        return _liveUsageEpochBudgets(epoch);
    }

    function _liveUsageEpochBudgets(uint256 epoch) internal view returns (uint256 buyerBudget, uint256 sellerBudget) {
        return _liveUsageEpochBudgets(epoch, emissionsGate.controllerEpochBudget(address(this), epoch));
    }

    /// @dev Epoch volume and epoch emission are hoisted so each external
    ///      fetch happens once for both share budgets; `maxBudget` is passed
    ///      in so a caller that already holds the gate budget saves the call.
    function _liveUsageEpochBudgets(uint256 epoch, uint256 maxBudget)
        internal
        view
        returns (uint256 buyerBudget, uint256 sellerBudget)
    {
        uint256 epochVolume = _epochVolume(epoch);
        uint256 epochEmission = emissionsGate.getEpochEmission(epoch);
        uint256 desiredBuyerBudget = _shareBudget(epochEmission, _buyerShareBpsAt(epochVolume));
        uint256 desiredSellerBudget = _shareBudget(epochEmission, _sellerShareBpsAt(epochVolume));
        uint256 desiredTotal = desiredBuyerBudget + desiredSellerBudget;
        if (desiredTotal <= maxBudget) return (desiredBuyerBudget, desiredSellerBudget);
        if (desiredTotal == 0) return (0, 0);

        buyerBudget = Math.mulDiv(desiredBuyerBudget, maxBudget, desiredTotal);
        sellerBudget = maxBudget - buyerBudget;
    }

    function allocatedEpochBudget(uint256 epoch) public view returns (uint256) {
        (uint256 buyerBudget, uint256 sellerBudget) = usageEpochBudgets(epoch);
        return buyerBudget + sellerBudget;
    }

    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();

        uint256 maxBudget = emissionsGate.controllerEpochBudget(address(this), epoch);
        (uint256 buyerBudget, uint256 sellerBudget) = _freezeUsageEpochBudgets(epoch, maxBudget);
        uint256 allocatedBudget = buyerBudget + sellerBudget;
        if (allocatedBudget >= maxBudget) revert NothingToClaim();

        uint256 unallocatedAmount = maxBudget - allocatedBudget;
        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, _emissionsReserve(), unallocatedAmount);
        emit UsageRewardRemainderSettled(epoch, unallocatedAmount, burnedAmount, reserveAmount);
    }

    function _freezeUsageEpochBudgets(uint256 epoch) internal returns (uint256 buyerBudget, uint256 sellerBudget) {
        FrozenUsageBudgets storage frozen = _frozenUsageBudgets[epoch];
        if (frozen.frozen) return (frozen.buyerBudget, frozen.sellerBudget);
        return _freezeUsageEpochBudgets(epoch, emissionsGate.controllerEpochBudget(address(this), epoch));
    }

    function _freezeUsageEpochBudgets(uint256 epoch, uint256 maxBudget)
        internal
        returns (uint256 buyerBudget, uint256 sellerBudget)
    {
        FrozenUsageBudgets storage frozen = _frozenUsageBudgets[epoch];
        if (frozen.frozen) return (frozen.buyerBudget, frozen.sellerBudget);

        (buyerBudget, sellerBudget) = _liveUsageEpochBudgets(epoch, maxBudget);
        frozen.frozen = true;
        frozen.buyerBudget = buyerBudget;
        frozen.sellerBudget = sellerBudget;
        emit UsageEpochBudgetsFrozen(epoch, buyerBudget, sellerBudget);
    }

    function _rewardAmounts(uint256 epochBudget, uint256 weightedPoints, uint256 totalWeightedPoints)
        internal
        pure
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount)
    {
        if (weightedPoints == 0 || totalWeightedPoints == 0) revert NothingToClaim();

        grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        if (grossAmount == 0) revert NothingToClaim();

        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        claimableAmount = grossAmount < cap ? grossAmount : cap;
        reserveAmount = grossAmount - claimableAmount;
        if (claimableAmount == 0 && reserveAmount == 0) revert NothingToClaim();
    }

    function _mintReward(uint256 epoch, address recipient, uint256 claimableAmount, uint256 reserveAmount) internal {
        if (claimableAmount != 0) {
            emissionsGate.claim(epoch, recipient, claimableAmount);
        }
        if (reserveAmount != 0) {
            emissionsGate.claim(epoch, _emissionsReserve(), reserveAmount);
        }
    }

    function _stakeClaimedReward(
        address staker,
        uint256 stakeAgentId,
        uint256 stakeEpochs,
        uint256 epoch,
        uint256 claimableAmount,
        uint256 reserveAmount
    ) internal returns (uint256 newPositionId) {
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) revert InvalidAddress();

        _mintReward(epoch, address(this), claimableAmount, reserveAmount);

        address tokenAddress = registry.antsToken();
        if (tokenAddress == address(0)) revert InvalidAddress();
        IERC20 token = IERC20(tokenAddress);
        token.forceApprove(address(pools), claimableAmount);
        newPositionId = pools.stakeFor(staker, stakeAgentId, claimableAmount, stakeEpochs);
        token.forceApprove(address(pools), 0);
    }

    function _buyerShareBpsAt(uint256 epochVolume) internal view returns (uint32) {
        return AntseedShareMath.saturatingShareBps(epochVolume, buyerMinShareBps, buyerMaxShareBps, volumeShareTarget);
    }

    function _sellerShareBpsAt(uint256 epochVolume) internal view returns (uint32) {
        return AntseedShareMath.saturatingShareBps(epochVolume, sellerMinShareBps, sellerMaxShareBps, volumeShareTarget);
    }

    function _epochVolume(uint256 epoch) internal view returns (uint256) {
        IAntseedUsageAccounting accounting = usageAccounting;
        uint256 buyerPoints = accounting.totalBuyerPointsByEpoch(epoch);
        uint256 sellerPoints = accounting.totalSellerPointsByEpoch(epoch);
        return buyerPoints > sellerPoints ? buyerPoints : sellerPoints;
    }

    function _shareBudget(uint256 epochEmission, uint32 shareBps) internal pure returns (uint256) {
        if (shareBps == 0) return 0;
        return Math.mulDiv(epochEmission, shareBps, GATE_SHARE_DENOMINATOR);
    }

    function _emissionsReserve() internal view returns (address reserve) {
        reserve = emissionsGate.emissionsReserve();
        if (reserve == address(0)) reserve = registry.protocolReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }

    function _buyerShare(address buyer, uint256 epoch)
        internal
        view
        returns (uint256 weightedPoints, uint256 totalWeightedPoints)
    {
        IAntseedUsageAccounting accounting = usageAccounting;
        if (address(accounting) == address(0)) revert InvalidAddress();
        weightedPoints = accounting.weightedBuyerPointsByEpoch(epoch, buyer);
        totalWeightedPoints = accounting.totalWeightedBuyerPointsByEpoch(epoch);
    }

    function _agentShare(uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 weightedPoints, uint256 totalWeightedPoints)
    {
        IAntseedUsageAccounting accounting = usageAccounting;
        if (address(accounting) == address(0)) revert InvalidAddress();
        weightedPoints = accounting.weightedPoolPointsByEpoch(epoch, agentId);
        totalWeightedPoints = accounting.totalWeightedPoolPointsByEpoch(epoch);
    }

    function _agentOwner(uint256 agentId) internal view returns (address owner) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0)) revert InvalidAddress();
        owner = IERC8004Registry(identityRegistry).ownerOf(agentId);
        if (owner == address(0)) revert InvalidAddress();
    }

    function _buyerRewardRecipient(address buyer) internal view returns (address) {
        // Iron rule: the buyer hot wallet never receives funds. If the
        // operator cannot be resolved, revert (rolling back the claimed flag)
        // so the claim can be retried once an operator is available.
        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0)) revert RewardRecipientUnavailable();

        address operator = IAntseedDeposits(depositsAddress).getOperator(buyer);
        if (operator == address(0)) revert RewardRecipientUnavailable();
        return operator;
    }
}
