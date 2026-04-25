// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {AntseedSellerDelegation} from "./AntseedSellerDelegation.sol";
import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";

/// @dev Venice's DIEM ERC20 is also the staking contract (stake / initiateUnstake / unstake live on the token itself).
interface IDiemStake {
    function stake(uint256 amount) external;
    function initiateUnstake(uint256 amount) external;
    function unstake() external;
    function cooldownDuration() external view returns (uint256);
}

interface IAntseedStakingSeller {
    function unstake() external;
}

interface IAntseedEmissionsClaim {
    function claimSellerEmissions(uint256[] calldata epochs) external;
    function pendingEmissions(address account, uint256[] calldata epochs)
        external
        view
        returns (uint256 totalSeller, uint256 totalBuyer);
}

interface IAntseedEmissionsClock {
    function currentEpoch() external view returns (uint256);
    function genesis() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
}

/**
 * @title DiemStakingProxy
 * @notice Pooled DIEM staker / AntSeed seller façade.
 *         Holders stake DIEM; the proxy re-stakes into Venice (the DIEM token
 *         itself) for API entitlement and acts as the on-chain seller address
 *         for AntSeed. USDC (revenue) and ANTS (emissions) accrue to stakers.
 *
 *         Channel lifecycle (reserve / topUp / settle / close) is provided by
 *         {AntseedSellerDelegation}. This contract overrides each to wrap the
 *         super call with USDC balance-delta capture and instant distribution.
 *
 *         UNSTAKE FLOW — batch queueing:
 *           1. `initiateUnstake(amount)` queues into `currentUnstakeBatch`. No Venice
 *              call yet. Reward accrual on the queued amount stops immediately.
 *           2. `flush()` (permissionless) sends the batch to Venice in one
 *              shot, stamps `unlockAt = now + venice_cd`, opens a fresh batch.
 *           3. After Venice's cooldown, `claimUnstakeBatch(id)` (permissionless)
 *              drains Venice and pays every user from the explicit per-user
 *              map. Serialization invariant: Venice only holds one batch at a
 *              time.
 *
 *         USDC DISTRIBUTION — instant credit:
 *           Each settle bumps `usdcStream.rewardPerTokenStored` inline; stakers
 *           at the moment of the inflow receive their pro-rata share and can
 *           `claimUsdc()` at any time. Equivalent to a Synthetix drip with
 *           `duration = 1` — settles are discrete events, not periods.
 *
 *         ANTS DISTRIBUTION — points + per-emission-epoch pot:
 *           Users accumulate internal "points" based on stake-time weighted by
 *           1/totalStaked (a Compound-style integrator). Finalized AntSeed
 *           emission epochs are closed at their real time boundaries. The
 *           matching ANTS pot is previewed from AntseedEmissions and claimed
 *           lazily by `claimAnts(n)` when needed.
 *
 *           Properties:
 *             - Points persist through unstakes — a user who fully unstakes
 *               can still claim ANTS for reward epochs they contributed to.
 *             - Attribution matches the emission accrual window: long-term
 *               stakers are rewarded proportionally to their time-weighted
 *               contribution, not their presence at tick time.
 *             - Claim is sequential (N before N+1) and bounded per call so
 *               backlogs never trap a stake/unstake transaction. Users with
 *               large backlogs call `catchUpPoints(n)` to process incrementally.
 *
 *         ERC-1271 is keyed on `owner()` (not operators). Venice API-key
 *         onboarding is an admin action, separate from operator channel ops.
 */
contract DiemStakingProxy is AntseedSellerDelegation, IERC1271 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev ERC-1271 magic value for a valid signature. OpenZeppelin's
    ///      `IERC1271` interface (imported above) intentionally does not
    ///      export this constant — the spec names it `MAGIC_VALUE` and every
    ///      implementation hardcodes it. It's `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`
    ///      per EIP-1271; we duplicate it here rather than shipping an
    ///      internal helper because both readers of the contract and
    ///      auditors expect to see the literal at the call-site.
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // ═══════════════════════════════════════════════════════════════════
    //                        Structs
    // ═══════════════════════════════════════════════════════════════════

    struct UnstakeBatch {
        uint128 total; // sum of every user's queued amount in this batch
        uint64 unlockAt; // 0 = not yet flushed; otherwise venice-release time
        uint32 userCount; // length of unstakeBatchUsers[id], cached for MAX check
        bool claimed;
    }

    struct RewardEpoch {
        uint256 stakeIntegratorAtEnd; // global integrator value at epoch close
        uint256 activeSecondsAtEnd; // cumulative seconds with totalStaked > 0 at close
        uint256 antsPot; // ANTS received from AntseedEmissions at close
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Immutables
    // ═══════════════════════════════════════════════════════════════════

    IERC20 public immutable diem;
    IERC20 public immutable usdc;
    IERC20 public immutable ants;
    address public immutable emissions;
    address public immutable antseedStaking;
    uint256 public immutable emissionGenesis;
    uint256 public immutable emissionEpochDuration;
    uint32 public immutable firstRewardEpoch;

    /// @dev Max distinct users per unstake batch. Caps `claimUnstakeBatch`'s transfer
    ///      loop at ~50 × 50k gas = 2.5M gas, well under the block limit while
    ///      giving each batch room for a realistic batch of unstakers.
    uint32 public constant MAX_PER_UNSTAKE_BATCH = 50;

    /// @dev Max reward-epoch backlog that `_captureUserPoints` will traverse in
    ///      a single tx. Beyond this, stake/unstake reverts with `BacklogTooLarge`
    ///      and the user must call `catchUpPoints` first to process incrementally.
    ///      16 reward epochs × an expected ~weekly tick = ~4 months of dormancy tolerated.
    uint32 public constant MAX_EPOCHS_PER_CAPTURE = 16;

    /// @dev Alpha-launch cap applied at construction. Caps `totalStaked` at 50
    ///      DIEM until the owner raises it via `setMaxTotalStake`. Owner may
    ///      set to `0` (unlimited) at any time. Assumes 18-decimal DIEM.
    uint256 public constant ALPHA_MAX_TOTAL_STAKE = 50e18;

    /// @dev Scalar (RAY) used by both the USDC reward-per-token accumulator
    ///      and the stake-time integrator. Chosen at 1e27 so that even at
    ///      very high TVL (e.g. totalStaked == 1e24 ≈ 1M DIEM) a single
    ///      second of accrual produces a non-zero increment
    ///      (1 · 1e27 / 1e24 == 1e3 ≫ 0), avoiding the slow bleed that a
    ///      1e18 scalar would cause. Upper-bound analysis: with 18-dec
    ///      stake capped at 1e24 and USDC inflows capped realistically
    ///      below 1e18 per call, all intermediate products
    ///      (staked × accumulator, S × Δintegrator, amount × scalar) stay
    ///      well under uint256 max (~1.16e77).

    /// @dev Default minimum time an unstake batch must remain open before
    ///      `flush()` is allowed. Prevents a first queuer from immediately
    ///      flushing and pushing every other would-be unstaker into the next
    ///      batch (which would then have to wait a full extra Venice cooldown).
    ///      The window is measured from the first `initiateUnstake` into the
    ///      batch, so dry-spell batches still enforce it. 24h gives stakers a
    ///      predictable joining window without adding noticeable friction on
    ///      top of Venice's own cooldown.
    uint64 public constant ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS = 1 days;

    /// @dev Upper bound on `setMinUnstakeBatchOpenSecs`. Caps how long the owner can
    ///      make stakers wait before a batch can leave. 7 days is long
    ///      enough to absorb any reasonable operational need (e.g. a one-week
    ///      batch cadence) but short enough that owner misconfiguration
    ///      can't effectively freeze withdrawals.
    uint64 public constant MAX_MIN_UNSTAKE_BATCH_OPEN_SECS = 7 days;

    // ═══════════════════════════════════════════════════════════════════
    //                        Storage — Staking
    // ═══════════════════════════════════════════════════════════════════

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    /// @dev Cap on `totalStaked` in DIEM (token-native units). `0` = unlimited.
    ///      Owner-settable. Enforced in `stake()`; never in unstake paths
    ///      (lowering the cap must never trap existing stakers). Existing
    ///      positions above a newly-lowered cap simply can't be topped up
    ///      until someone else unstakes enough to bring totalStaked back under.
    uint256 public maxTotalStake;

    /// @dev Live count of distinct addresses with `staked[addr] > 0`.
    ///      Incremented on the 0→N transition in `stake`, decremented on the
    ///      N→0 transition in `initiateUnstake` (full exit). Partial stakes /
    ///      partial unstakes don't touch it. Powers the frontend "Active
    ///      stakers" tile with a single SLOAD — no event indexer required.
    uint32 public stakerCount;

    /// @dev Unstake-batch state. `currentUnstakeBatch` accepts new queuers;
    ///      `oldestUnclaimedUnstakeBatch` is the lowest flushed-but-not-yet-claimed batch
    ///      id. A new batch can only be flushed once the prior one has been
    ///      claimed — Venice only ever holds one batch at a time.
    mapping(uint32 => UnstakeBatch) public unstakeBatches;
    mapping(uint32 => address[]) public unstakeBatchUsers;
    mapping(uint32 => mapping(address => uint128)) public unstakeBatchUserAmount;
    uint32 public currentUnstakeBatch;
    uint32 public oldestUnclaimedUnstakeBatch;

    /// @dev Timestamp (as uint64) at which the currently-open batch received
    ///      its first queuer. Zero means the batch is empty. Reset to zero
    ///      on flush so the next batch's clock restarts fresh on its first
    ///      `initiateUnstake`.
    uint64 public currentUnstakeBatchOpenedAt;

    /// @dev Minimum wall-clock seconds a batch must stay open before
    ///      `flush()` will accept it. Owner-settable, bounded by
    ///      `MAX_MIN_UNSTAKE_BATCH_OPEN_SECS`. `0` disables the gate entirely.
    uint64 public minUnstakeBatchOpenSecs;

    // ═══════════════════════════════════════════════════════════════════
    //                        Storage — USDC rewards (instant credit)
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Synthetix-style reward-per-token accumulator. Each settle bumps
    ///      this directly; users' accrued USDC = staked × Δ(accumulator).
    uint256 public usdcRewardPerTokenStored;

    mapping(address => uint256) public userUsdcRewardPerTokenPaid;
    mapping(address => uint256) public usdcRewards;

    /// @dev Conservative upper bound on outstanding USDC owed to stakers.
    ///      Incremented by every successfully-distributed inflow (skipping
    ///      inflows that arrive when `totalStaked == 0` — those are orphan
    ///      dust, sweepable). Decremented by every `claimUsdc`. Distribution
    ///      rounding dust (from the integer division in _distributeUsdcInstant)
    ///      is included here as a safety margin — so sweep always leaves at
    ///      least the real liability in the contract.
    uint256 public totalUsdcReservedForStakers;

    /// @dev Monotonic counter of every USDC unit distributed to stakers over
    ///      the proxy's lifetime. Unlike `totalUsdcReservedForStakers`, this
    ///      is never decremented on claim — it's a lifetime "USDC distributed
    ///      · all time" display value. Skips inflows with no stakers (those
    ///      go to `sweepOrphanUsdc`).
    uint256 public totalUsdcDistributedEver;

    // ═══════════════════════════════════════════════════════════════════
    //                        Storage — ANTS rewards (points + epoch pots)
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant _RAY = 1e27;

    /// @dev Global stake-time integrator: A(t) = ∫ 1/totalStaked(τ) dτ × RAY.
    ///      A user staked with `S` over an interval with Δintegrator gains
    ///      `S × Δintegrator / RAY` points for that interval.
    uint256 public stakeIntegrator;
    uint256 public lastIntegratorUpdate;

    /// @dev Cumulative wall-clock seconds where `totalStaked > 0`. Serves as
    ///      the denominator when converting per-user points into an epoch
    ///      fraction: sum over users of points in epoch = activeSeconds in epoch.
    uint256 public activeSecondsAccumulator;

    /// @dev Reward-epoch state. Reward epoch ids match AntseedEmissions epoch ids.
    ///      `currentRewardEpoch` is the first not-yet-finalized epoch; finalized
    ///      reward epochs are funded lazily when users claim ANTS.
    mapping(uint32 => RewardEpoch) public rewardEpochs;
    uint32 public currentRewardEpoch;
    mapping(uint32 => bool) public rewardEpochAccounted;

    /// @dev Per-user points per reward epoch (the "internal points system").
    ///      Populated lazily on the user's next interaction; persists across
    ///      stake/unstake so users can claim after fully unstaking.
    mapping(address => mapping(uint32 => uint256)) public userPoints;

    /// @dev Per-user bookkeeping for the integrator.
    ///      `userIntegratorSnap` = integrator value at the user's last capture.
    ///      `userCurrentEpoch` = reward epoch at the user's last capture.
    ///      `userLastClaimedEpoch` = next unclaimed reward epoch (sequential).
    mapping(address => uint256) public userIntegratorSnap;
    mapping(address => uint32) public userCurrentEpoch;
    mapping(address => uint32) public userLastClaimedEpoch;

    // ═══════════════════════════════════════════════════════════════════
    //                        Events
    // ═══════════════════════════════════════════════════════════════════

    event Staked(address indexed user, uint256 amount);
    event UnstakeQueued(address indexed user, uint32 indexed batchId, uint256 amount);
    event UnstakeBatchFlushed(uint32 indexed batchId, uint256 total, uint256 unlockAt);
    event UnstakeBatchClaimed(uint32 indexed batchId, uint256 total, uint32 userCount);
    event Unstaked(address indexed user, uint256 amount);
    event UsdcDistributed(uint256 amount);
    event UsdcPaid(address indexed user, uint256 amount);
    event RewardEpochClosed(
        uint32 indexed rewardEpochId, uint256 antsPot, uint256 stakeIntegratorAtEnd, uint256 activeSecondsAtEnd
    );
    event RewardEpochFunded(uint32 indexed rewardEpochId, uint256 antsPot);
    event RewardEpochsSynced(uint32 fromEpoch, uint32 toEpoch);
    event AntsClaimed(address indexed user, uint32 fromEpoch, uint32 toEpoch, uint256 antsAmount);
    event PointsCaughtUp(address indexed user, uint32 newCurrentEpoch);
    event AntseedStakeWithdrawn(address indexed recipient, uint256 amount);
    event OrphanUsdcSwept(address indexed recipient, uint256 amount);
    event MaxTotalStakeSet(uint256 newMaxTotalStake);
    event MinUnstakeBatchOpenSecsSet(uint64 newMinUnstakeBatchOpenSecs);

    // ═══════════════════════════════════════════════════════════════════
    //                        Custom Errors
    // ═══════════════════════════════════════════════════════════════════

    error InvalidAmount();
    error InsufficientStake();
    error UnstakeBatchFull();
    error NothingToFlush();
    error PriorUnstakeBatchUnclaimed();
    error UnstakeBatchNotReady();
    error UnstakeBatchAlreadyClaimed();
    error UnstakeBatchTooYoung();
    error BacklogTooLarge();
    error NothingToClaim();
    error MaxStakeExceeded();
    error MinUnstakeBatchOpenSecsTooLarge();
    error RewardEpochNotFinalized();
    error RewardEpochAlreadyAccounted();

    // ═══════════════════════════════════════════════════════════════════
    //                        Constructor
    // ═══════════════════════════════════════════════════════════════════

    /// @param _diem External Venice DIEM contract (not in AntseedRegistry).
    /// @param _usdc USDC token used by channels/staking. Kept explicit.
    /// @param _registry AntSeed address book. `ants`, `emissions`, and
    ///                  `antseedStaking` are resolved from it at construction
    ///                  and pinned as immutables for the proxy's lifetime.
    /// @param _operator Initial authorized operator for channel lifecycle ops.
    constructor(address _diem, address _usdc, address _registry, address _operator)
        AntseedSellerDelegation(_registry, _operator)
    {
        if (_diem == address(0) || _usdc == address(0)) revert InvalidAddress();

        address _ants = IAntseedRegistry(_registry).antsToken();
        address _emissions = IAntseedRegistry(_registry).emissions();
        address _antseedStaking = IAntseedRegistry(_registry).staking();
        if (_ants == address(0) || _emissions == address(0) || _antseedStaking == address(0)) {
            revert InvalidAddress();
        }

        diem = IERC20(_diem);
        usdc = IERC20(_usdc);
        ants = IERC20(_ants);
        emissions = _emissions;
        antseedStaking = _antseedStaking;
        emissionGenesis = IAntseedEmissionsClock(_emissions).genesis();
        emissionEpochDuration = IAntseedEmissionsClock(_emissions).EPOCH_DURATION();

        // Batch 0 is unused so `unlockAt == 0` remains a reliable "not yet
        // flushed" sentinel. Queuing starts at batch 1.
        currentUnstakeBatch = 1;
        oldestUnclaimedUnstakeBatch = 1;

        uint32 _firstRewardEpoch = IAntseedEmissionsClock(_emissions).currentEpoch().toUint32();
        firstRewardEpoch = _firstRewardEpoch;
        currentRewardEpoch = _firstRewardEpoch;
        lastIntegratorUpdate = block.timestamp;

        // Ship with an alpha-launch stake cap. Owner can raise it or remove
        // entirely (set to 0) via `setMaxTotalStake`. Emitted so indexers and
        // the frontend's `maxTotalStake()` read pick up the initial value
        // consistently with later owner changes.
        maxTotalStake = ALPHA_MAX_TOTAL_STAKE;
        emit MaxTotalStakeSet(ALPHA_MAX_TOTAL_STAKE);

        // Ship with a 24h minimum batch-open window so a first queuer can't
        // immediately flush and push later unstakers into a fresh Venice
        // cooldown. Owner can retune via `setMinUnstakeBatchOpenSecs` (capped at
        // `MAX_MIN_UNSTAKE_BATCH_OPEN_SECS`) or disable by setting `0`.
        minUnstakeBatchOpenSecs = ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS;
        emit MinUnstakeBatchOpenSecsSet(ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Modifiers
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Settle both reward surfaces for `user` before the caller's action.
    ///      USDC: Synthetix-style accrual via `usdcRewardPerTokenStored`.
    ///      ANTS: integrator update + capture user points across any reward
    ///      epochs since their last interaction (bounded by
    ///      `MAX_EPOCHS_PER_CAPTURE`).
    modifier updateRewards(address account) {
        _updateUsdcForUser(account);
        _syncFinalizedRewardEpochsForUpdate();
        _updateStakeIntegrator();
        _captureUserPoints(account);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        STAKER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Stake DIEM into the proxy. Proxy re-stakes into Venice in the same tx.
    function stake(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        uint256 cap = maxTotalStake;
        if (cap != 0 && totalStaked + amount > cap) revert MaxStakeExceeded();

        // Track distinct-staker count on the 0→N transition. `_updateUsdcForUser`
        // has already fired (via the modifier), so `staked[msg.sender]` here
        // is the pre-stake value we need.
        if (staked[msg.sender] == 0) stakerCount += 1;

        staked[msg.sender] += amount;
        totalStaked += amount;

        diem.safeTransferFrom(msg.sender, address(this), amount);
        IDiemStake(address(diem)).stake(amount);

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Queue `amount` DIEM for unstaking. Joins the current open batch.
     *         Reward accrual on the queued amount stops immediately. The
     *         batch is sent to Venice in one shot via `flush()`.
     */
    function initiateUnstake(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (amount > staked[msg.sender]) revert InsufficientStake();

        uint32 batchId = currentUnstakeBatch;
        UnstakeBatch storage e = unstakeBatches[batchId];

        // First queuer into this batch starts the minimum-open-window
        // clock. Measuring from the first queue (not from when the batch
        // slot was created) means a dry-spell batch still enforces the
        // window on whoever eventually queues first, matching user intent:
        // "give other stakers a chance to join before the batch leaves".
        if (e.total == 0) currentUnstakeBatchOpenedAt = uint64(block.timestamp);

        uint128 existing = unstakeBatchUserAmount[batchId][msg.sender];
        if (existing == 0) {
            if (e.userCount >= MAX_PER_UNSTAKE_BATCH) revert UnstakeBatchFull();
            unstakeBatchUsers[batchId].push(msg.sender);
            e.userCount += 1;
        }

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        // Track distinct-staker count on the N→0 (full exit) transition.
        // Only decrement when the user has no remaining active stake — partial
        // unstakes leave them counted. Note: `staked` here reflects post-subtract.
        if (staked[msg.sender] == 0) stakerCount -= 1;

        uint128 amt128 = amount.toUint128();
        unstakeBatchUserAmount[batchId][msg.sender] = existing + amt128;
        e.total += amt128;

        emit UnstakeQueued(msg.sender, batchId, amount);
    }

    /**
     * @notice Send the current unstake batch to Venice and open a fresh one.
     *         Permissionless. Serialization: a new batch can only be flushed
     *         after the prior one is claimed.
     */
    function flush() external nonReentrant {
        if (currentUnstakeBatch != oldestUnclaimedUnstakeBatch) revert PriorUnstakeBatchUnclaimed();

        uint32 batchId = currentUnstakeBatch;
        UnstakeBatch storage e = unstakeBatches[batchId];
        if (e.total == 0) revert NothingToFlush();

        // Enforce the minimum open window. `currentUnstakeBatchOpenedAt == 0`
        // when the batch is empty, which is caught by the NothingToFlush
        // check above — so by this point `openedAt` is always a real
        // timestamp. Using `>` (not `>=`) is deliberate: exactly-at-boundary
        // plays nicely with test warps that land on the exact second.
        uint64 openedAt = currentUnstakeBatchOpenedAt;
        if (block.timestamp < uint256(openedAt) + uint256(minUnstakeBatchOpenSecs)) {
            revert UnstakeBatchTooYoung();
        }

        uint256 cd = IDiemStake(address(diem)).cooldownDuration();
        uint64 unlockAt = (block.timestamp + cd).toUint64();
        e.unlockAt = unlockAt;

        currentUnstakeBatch = batchId + 1;
        // Next batch starts empty — its clock will set on its first queuer.
        currentUnstakeBatchOpenedAt = 0;

        IDiemStake(address(diem)).initiateUnstake(e.total);

        emit UnstakeBatchFlushed(batchId, e.total, unlockAt);
    }

    /**
     * @notice Drain `batchId` from Venice and pay out every user in it.
     *         Permissionless. Proxy's direct DIEM balance is 0 before and
     *         after this call.
     */
    function claimUnstakeBatch(uint32 batchId) external nonReentrant {
        UnstakeBatch storage e = unstakeBatches[batchId];
        if (e.unlockAt == 0 || block.timestamp < e.unlockAt) revert UnstakeBatchNotReady();
        if (e.claimed) revert UnstakeBatchAlreadyClaimed();

        e.claimed = true;
        if (batchId == oldestUnclaimedUnstakeBatch) oldestUnclaimedUnstakeBatch = batchId + 1;

        IDiemStake(address(diem)).unstake();

        address[] storage users = unstakeBatchUsers[batchId];
        uint256 count = users.length;
        for (uint256 i = 0; i < count; i++) {
            address user = users[i];
            uint128 amount = unstakeBatchUserAmount[batchId][user];
            delete unstakeBatchUserAmount[batchId][user];
            diem.safeTransfer(user, amount);
            emit Unstaked(user, amount);
        }

        emit UnstakeBatchClaimed(batchId, e.total, uint32(count));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARD CLAIMS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claim accrued USDC (instant-credit). O(1).
    function claimUsdc() external nonReentrant updateRewards(msg.sender) {
        uint256 owed = usdcRewards[msg.sender];
        if (owed == 0) revert NothingToClaim();
        usdcRewards[msg.sender] = 0;
        // Safe subtract: every unit of `owed` was credited via
        // _updateUsdcForUser, which sources from distributions that bumped
        // `totalUsdcReservedForStakers`. Rounding dust only inflates the
        // reservation (safer), never deflates.
        totalUsdcReservedForStakers -= owed;
        usdc.safeTransfer(msg.sender, owed);
        emit UsdcPaid(msg.sender, owed);
    }

    /**
     * @notice Convert points for the next `numEpochs` completed reward epochs
     *         into ANTS. Sequential — must process epoch N before N+1.
     * @dev If the caller has a large backlog that would exceed
     *      `MAX_EPOCHS_PER_CAPTURE`, call `catchUpPoints` first.
     */
    function claimAnts(uint32 numEpochs) external nonReentrant updateRewards(msg.sender) {
        if (numEpochs == 0) revert InvalidAmount();

        uint32 from = userLastClaimedEpoch[msg.sender];
        if (from < firstRewardEpoch) from = firstRewardEpoch;
        uint32 to = from + numEpochs;
        if (to > currentRewardEpoch) to = currentRewardEpoch;
        if (to == from) revert NothingToClaim();

        uint256 totalAnts;
        uint32 processedTo = from;
        for (uint32 N = from; N < to; N++) {
            uint256 antsPot = rewardEpochAccounted[N] ? rewardEpochs[N].antsPot : _fundRewardEpoch(N);

            // Advancing `userLastClaimedEpoch` past this reward epoch permanently
            // abandons any userPoints entry here. For the zero-payout skip
            // paths below we explicitly `delete` the slot so no stale storage
            // lingers — cheap at time-of-claim since each user only walks
            // their own reward epochs once.
            uint256 userPts = userPoints[msg.sender][N];
            if (userPts == 0) {
                processedTo = N + 1;
                continue;
            }

            if (antsPot == 0) {
                delete userPoints[msg.sender][N];
                processedTo = N + 1;
                continue;
            }
            RewardEpoch memory re = rewardEpochs[N];
            uint256 totalPoints =
                N == 0 ? re.activeSecondsAtEnd : re.activeSecondsAtEnd - rewardEpochs[N - 1].activeSecondsAtEnd;
            if (totalPoints == 0) {
                delete userPoints[msg.sender][N];
                processedTo = N + 1;
                continue;
            }
            totalAnts += (antsPot * userPts) / totalPoints;
            delete userPoints[msg.sender][N];
            processedTo = N + 1;
        }
        if (processedTo == from) revert NothingToClaim();
        userLastClaimedEpoch[msg.sender] = processedTo;

        if (totalAnts > 0) {
            ants.safeTransfer(msg.sender, totalAnts);
        }
        emit AntsClaimed(msg.sender, from, processedTo, totalAnts);
    }

    /**
     * @notice Incrementally capture points for a user with a backlog that
     *         exceeds `MAX_EPOCHS_PER_CAPTURE`. Processes up to `numEpochs`
     *         of the user's per-epoch point contributions.
     * @dev    Also settles the caller's USDC reward debt against the current
     *         accumulator. Without this, a user calling `catchUpPoints` to
     *         unblock a later `stake`/`unstake`/`claimUsdc` would leave
     *         their pending USDC at the pre-catch-up integrator — correct,
     *         but surprising. Settling here means `catchUpPoints` leaves
     *         both reward surfaces in a consistent state for the caller.
     */
    function catchUpPoints(uint32 numEpochs) external {
        if (numEpochs == 0) revert InvalidAmount();
        _updateUsdcForUser(msg.sender);
        _syncFinalizedRewardEpochsBounded(numEpochs);
        if (currentRewardEpoch == _finalizedRewardEpoch()) _updateStakeIntegrator();

        uint32 userEp = userCurrentEpoch[msg.sender];
        uint32 currentEp = currentRewardEpoch;
        uint32 targetEp = userEp + numEpochs;
        if (targetEp > currentEp) targetEp = currentEp;
        if (targetEp == userEp) revert NothingToClaim();

        uint256 S = staked[msg.sender];
        uint256 userSnap = userIntegratorSnap[msg.sender];

        // Accumulate points for fully completed reward epochs [userEp, targetEp).
        // `targetEp` itself (and, if targetEp == currentEp, the open epoch)
        // are left for a later capture, since their integratorAtEnd isn't
        // finalized yet.
        for (uint32 N = userEp; N < targetEp; N++) {
            uint256 segStart = N == userEp ? userSnap : rewardEpochs[N - 1].stakeIntegratorAtEnd;
            uint256 segEnd = rewardEpochs[N].stakeIntegratorAtEnd;
            _addUserPoints(msg.sender, N, S, segStart, segEnd);
        }

        // `targetEp > userEp` is guaranteed by the `NothingToClaim` check
        // above, and `userEp >= 0`, so `targetEp >= 1` and the dereference
        // at `targetEp - 1` is always valid.
        userIntegratorSnap[msg.sender] = rewardEpochs[targetEp - 1].stakeIntegratorAtEnd;
        userCurrentEpoch[msg.sender] = targetEp;

        emit PointsCaughtUp(msg.sender, targetEp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL OVERRIDES (inflow capture)
    // ═══════════════════════════════════════════════════════════════════

    /// @dev `reserve` has no USDC inflow — base implementation is sufficient.

    // `onlyOperator` lives on the base forwarders (AntseedSellerDelegation)
    // and still fires here via `super`. `nonReentrant` is applied on each
    // override so the balance-delta capture + `_distributeUsdcInstant` run
    // inside the same lock as the super forward — no window between
    // external call and accumulator update.

    /// @inheritdoc AntseedSellerDelegation
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public override nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        _distributeUsdcInstant(usdc.balanceOf(address(this)) - beforeBal);
    }

    /// @inheritdoc AntseedSellerDelegation
    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
    {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.settle(channelId, cumulativeAmount, metadata, buyerSig);
        _distributeUsdcInstant(usdc.balanceOf(address(this)) - beforeBal);
    }

    /// @inheritdoc AntseedSellerDelegation
    function close(bytes32 channelId, uint128 finalAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
    {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.close(channelId, finalAmount, metadata, buyerSig);
        _distributeUsdcInstant(usdc.balanceOf(address(this)) - beforeBal);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OPERATOR TICK (ANTS emissions)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Permissionlessly close finalized reward epochs in bounded chunks.
    ///         Useful after long dormancy before users call stake/unstake/claim.
    function syncRewardEpochs(uint32 maxEpochs) external nonReentrant {
        if (maxEpochs == 0) revert InvalidAmount();

        if (_syncFinalizedRewardEpochsBounded(maxEpochs) == 0) revert NothingToClaim();
    }

    /// @notice Permissionlessly claim the proxy's ANTS pot for a closed reward epoch.
    ///         `claimAnts` calls this lazily, but anyone can pre-fund an epoch.
    function fundRewardEpoch(uint32 rewardEpoch) external nonReentrant {
        uint32 target = rewardEpoch + 1;
        if (target > _finalizedRewardEpoch()) revert RewardEpochNotFinalized();
        if (target > currentRewardEpoch) {
            if (target - currentRewardEpoch > MAX_EPOCHS_PER_CAPTURE) revert BacklogTooLarge();
            _syncRewardEpochsUntil(target);
        }
        if (rewardEpochAccounted[rewardEpoch]) revert RewardEpochAlreadyAccounted();
        _fundRewardEpoch(rewardEpoch);
    }

    /**
     * @notice Claim ANTS emissions for the given finalized `emissionEpochId`
     *         and attach the pot to the matching closed reward epoch. Reward
     *         epochs close at AntseedEmissions time boundaries, so delayed
     *         operator calls cannot change the staker attribution window.
     */
    function operatorClaimEmissions(uint256 emissionEpochId) external onlyOperator nonReentrant {
        uint32 rewardEpoch = emissionEpochId.toUint32();
        uint32 target = rewardEpoch + 1;
        if (target > _finalizedRewardEpoch()) revert RewardEpochNotFinalized();
        if (target > currentRewardEpoch) {
            if (target - currentRewardEpoch > MAX_EPOCHS_PER_CAPTURE) revert BacklogTooLarge();
            _syncRewardEpochsUntil(target);
        }
        if (rewardEpochAccounted[rewardEpoch]) revert RewardEpochAlreadyAccounted();
        _fundRewardEpoch(rewardEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Recover the proxy's seller stake from AntseedStaking.
     *         AntseedStaking itself enforces "no active channels". Users'
     *         unclaimed points remain intact and claimable after this.
     */
    function withdrawAntseedStake(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 beforeBal = usdc.balanceOf(address(this));
        IAntseedStakingSeller(antseedStaking).unstake();
        uint256 payout = usdc.balanceOf(address(this)) - beforeBal;
        if (payout > 0) usdc.safeTransfer(recipient, payout);
        emit AntseedStakeWithdrawn(recipient, payout);
    }

    /**
     * @notice Sweep USDC that is provably not owed to any staker.
     *         Includes:
     *           - Inflows that arrived while `totalStaked == 0` (skipped by
     *             `_distributeUsdcInstant`, otherwise trapped).
     *           - Any accidental direct USDC transfer to the contract.
     *         Excludes the full `totalUsdcReservedForStakers` ledger — that
     *         represents outstanding per-user `usdcRewards` (plus distribution
     *         rounding dust, which we intentionally keep as a safety margin).
     *         `withdrawAntseedStake` has already transferred the returned seller
     *         stake to the recipient, so there's no double-count risk.
     */
    function sweepOrphanUsdc(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 balance = usdc.balanceOf(address(this));
        uint256 reserved = totalUsdcReservedForStakers;
        if (balance <= reserved) return;
        uint256 amount = balance - reserved;
        usdc.safeTransfer(recipient, amount);
        emit OrphanUsdcSwept(recipient, amount);
    }

    /**
     * @notice Set the pool's total-stake cap. `0` = unlimited.
     *         Enforced only on new stakes; never restricts existing stake or
     *         unstake paths. Lowering the cap below `totalStaked` is allowed
     *         and simply freezes incoming stake until unstakes bring
     *         `totalStaked` back under the new cap.
     */
    function setMaxTotalStake(uint256 newMaxTotalStake) external onlyOwner {
        maxTotalStake = newMaxTotalStake;
        emit MaxTotalStakeSet(newMaxTotalStake);
    }

    /**
     * @notice Set the minimum batch-open window (seconds). `0` disables the
     *         gate. Capped at `MAX_MIN_UNSTAKE_BATCH_OPEN_SECS` so owner cannot grief
     *         stakers with an unreasonably long window.
     *         Takes effect on the next `flush` check; does not retroactively
     *         shorten an already-elapsed window.
     */
    function setMinUnstakeBatchOpenSecs(uint64 newMinUnstakeBatchOpenSecs) external onlyOwner {
        if (newMinUnstakeBatchOpenSecs > MAX_MIN_UNSTAKE_BATCH_OPEN_SECS) revert MinUnstakeBatchOpenSecsTooLarge();
        minUnstakeBatchOpenSecs = newMinUnstakeBatchOpenSecs;
        emit MinUnstakeBatchOpenSecsSet(newMinUnstakeBatchOpenSecs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Unix timestamp at which `flush()` will first be callable for
    ///         the currently-open batch. Returns `0` if the batch is still
    ///         empty (no first queuer yet) — in that case `flush` is blocked
    ///         by `NothingToFlush` regardless of this timestamp.
    function flushableAt() external view returns (uint64) {
        uint64 openedAt = currentUnstakeBatchOpenedAt;
        if (openedAt == 0) return 0;
        return openedAt + minUnstakeBatchOpenSecs;
    }

    /// @notice USDC earned and claimable by `account` right now.
    function earnedUsdc(address account) external view returns (uint256) {
        return usdcRewards[account]
            + (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / _RAY;
    }

    /// @notice Preview ANTS for a single completed reward epoch for `account`.
    ///         Does not mutate state. Returns 0 for the currently-open epoch.
    /// @dev Computes uncaptured points lazily if the user hasn't interacted
    ///      since before/during the reward epoch, assuming their stake has been
    ///      constant since their last interaction. (This invariant holds
    ///      because any stake change would have triggered `updateRewards`.)
    function pendingAntsForEpoch(address account, uint32 rewardEpoch) external view returns (uint256) {
        if (rewardEpoch >= currentRewardEpoch) return 0;
        RewardEpoch memory re = rewardEpochs[rewardEpoch];
        uint256 antsPot = rewardEpochAccounted[rewardEpoch] ? re.antsPot : _pendingRewardEpochPot(rewardEpoch);
        if (antsPot == 0) return 0;
        uint256 totalPoints = rewardEpoch == 0
            ? re.activeSecondsAtEnd
            : re.activeSecondsAtEnd - rewardEpochs[rewardEpoch - 1].activeSecondsAtEnd;
        if (totalPoints == 0) return 0;

        uint256 userPts = userPoints[account][rewardEpoch];

        // Add uncaptured contribution if the user's last capture was at or
        // before the start of this reward epoch and they're currently staked.
        uint32 userEp = userCurrentEpoch[account];
        uint256 S = staked[account];
        if (S > 0 && userEp <= rewardEpoch) {
            uint256 segStart;
            if (userEp == rewardEpoch) {
                segStart = userIntegratorSnap[account];
            } else if (rewardEpoch > 0) {
                segStart = rewardEpochs[rewardEpoch - 1].stakeIntegratorAtEnd;
            }
            uint256 segEnd = re.stakeIntegratorAtEnd;
            if (segEnd > segStart) {
                userPts += (S * (segEnd - segStart)) / _RAY;
            }
        }

        if (userPts == 0) return 0;
        return (antsPot * userPts) / totalPoints;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ERC-1271 (Venice API-key onboarding)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ERC-1271 signature validation. Returns the magic value when
    ///         the signature recovers to the current `owner()`. Used by
    ///         Venice to verify off-chain challenges when issuing the proxy's
    ///         API key.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        address recovered = ECDSA.recover(hash, signature);
        return recovered == owner() ? ERC1271_MAGIC_VALUE : bytes4(0xffffffff);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Instant-credit USDC to stakers at the moment of inflow. Skipped
    ///      if `totalStaked == 0` (no one to credit); the USDC sits in the
    ///      proxy balance as operational dust and can be recovered by admin.
    function _distributeUsdcInstant(uint256 amount) internal {
        if (amount == 0 || totalStaked == 0) return;
        uint256 rewardPerTokenDelta = (amount * _RAY) / totalStaked;
        if (rewardPerTokenDelta == 0) return;

        usdcRewardPerTokenStored += rewardPerTokenDelta;
        uint256 distributable = (rewardPerTokenDelta * totalStaked) / _RAY;
        // Track accumulator-distributable units for the sweep-safety ledger.
        // Per-user integer rounding can still leave tiny conservative dust.
        totalUsdcReservedForStakers += distributable;
        // Lifetime counter — never decremented, powers the "USDC distributed
        // · all time" frontend tile with a single SLOAD.
        totalUsdcDistributedEver += distributable;
        emit UsdcDistributed(distributable);
    }

    /// @dev Settle `account`'s USDC reward debt against the current
    ///      accumulator. Must fire before any `staked[account]` change.
    function _updateUsdcForUser(address account) internal {
        if (account != address(0)) {
            uint256 delta = (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / _RAY;
            if (delta > 0) usdcRewards[account] += delta;
            userUsdcRewardPerTokenPaid[account] = usdcRewardPerTokenStored;
        }
    }

    /// @dev Advance `stakeIntegrator` and `activeSecondsAccumulator` to now.
    function _updateStakeIntegrator() internal {
        _updateStakeIntegratorTo(block.timestamp);
    }

    /// @dev Advance `stakeIntegrator` and `activeSecondsAccumulator` to `timestamp`.
    function _updateStakeIntegratorTo(uint256 timestamp) internal {
        if (timestamp <= lastIntegratorUpdate) return;
        uint256 delta = timestamp - lastIntegratorUpdate;
        if (delta > 0 && totalStaked > 0) {
            stakeIntegrator += (delta * _RAY) / totalStaked;
            activeSecondsAccumulator += delta;
        }
        lastIntegratorUpdate = timestamp;
    }

    function _finalizedRewardEpoch() internal view returns (uint32) {
        return IAntseedEmissionsClock(emissions).currentEpoch().toUint32();
    }

    /// @dev Normal reward-touching paths only sync a bounded backlog. If the
    ///      contract has been dormant for longer, users call `syncRewardEpochs`
    ///      first to close old epochs incrementally.
    function _syncFinalizedRewardEpochsForUpdate() internal {
        uint32 finalized = _finalizedRewardEpoch();
        if (finalized > currentRewardEpoch && finalized - currentRewardEpoch > MAX_EPOCHS_PER_CAPTURE) {
            revert BacklogTooLarge();
        }
        _syncRewardEpochsUntil(finalized);
    }

    function _syncFinalizedRewardEpochsBounded(uint32 maxEpochs) internal returns (uint32 synced) {
        uint32 from = currentRewardEpoch;
        uint32 finalized = _finalizedRewardEpoch();
        uint32 target = from + maxEpochs;
        if (target > finalized) target = finalized;
        if (target > from) {
            _syncRewardEpochsUntil(target);
            synced = target - from;
        }
    }

    /// @dev Close reward epochs at AntseedEmissions boundaries up to `target`.
    ///      This keeps ANTS attribution tied to the external emission window,
    ///      not to the operator's eventual claim transaction timestamp.
    function _syncRewardEpochsUntil(uint32 target) internal {
        uint32 from = currentRewardEpoch;
        while (currentRewardEpoch < target) {
            uint32 rewardEpoch = currentRewardEpoch;
            uint256 epochEnd = emissionGenesis + ((uint256(rewardEpoch) + 1) * emissionEpochDuration);
            _updateStakeIntegratorTo(epochEnd);

            RewardEpoch storage re = rewardEpochs[rewardEpoch];
            re.stakeIntegratorAtEnd = stakeIntegrator;
            re.activeSecondsAtEnd = activeSecondsAccumulator;

            currentRewardEpoch = rewardEpoch + 1;
            emit RewardEpochClosed(rewardEpoch, re.antsPot, stakeIntegrator, activeSecondsAccumulator);
        }
        if (currentRewardEpoch > from) emit RewardEpochsSynced(from, currentRewardEpoch);
    }

    function _fundRewardEpoch(uint32 rewardEpoch) internal returns (uint256 inflow) {
        uint256 beforeBal = ants.balanceOf(address(this));
        uint256[] memory ids = _singleRewardEpochArray(rewardEpoch);
        IAntseedEmissionsClaim(emissions).claimSellerEmissions(ids);
        inflow = ants.balanceOf(address(this)) - beforeBal;

        rewardEpochs[rewardEpoch].antsPot = inflow;
        rewardEpochAccounted[rewardEpoch] = true;

        emit RewardEpochFunded(rewardEpoch, inflow);
    }

    function _pendingRewardEpochPot(uint32 rewardEpoch) internal view returns (uint256 pendingSeller) {
        uint256[] memory ids = _singleRewardEpochArray(rewardEpoch);
        (pendingSeller,) = IAntseedEmissionsClaim(emissions).pendingEmissions(address(this), ids);
    }

    function _singleRewardEpochArray(uint32 rewardEpoch) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = rewardEpoch;
    }

    /// @dev Capture `account`'s point contribution across every reward epoch
    ///      they've spanned since their last interaction, up through the
    ///      currently-open epoch. Reverts `BacklogTooLarge` if they need more
    ///      than `MAX_EPOCHS_PER_CAPTURE` iterations — `catchUpPoints` lets
    ///      them process incrementally.
    function _captureUserPoints(address account) internal {
        if (account == address(0)) return;

        uint256 S = staked[account];
        uint32 currentEp = currentRewardEpoch;

        // Fast path: user has no stake (never interacted, or fully unstaked).
        // Nothing to capture — just snap them to the current state.
        if (S == 0) {
            userIntegratorSnap[account] = stakeIntegrator;
            userCurrentEpoch[account] = currentEp;
            return;
        }

        uint32 userEp = userCurrentEpoch[account];
        if (currentEp > userEp && currentEp - userEp > MAX_EPOCHS_PER_CAPTURE) {
            revert BacklogTooLarge();
        }

        uint256 userSnap = userIntegratorSnap[account];

        // For each completed epoch in [userEp, currentEp): add points for
        // (segEnd - segStart) of the integrator within that epoch.
        for (uint32 N = userEp; N < currentEp; N++) {
            uint256 segStart = N == userEp ? userSnap : rewardEpochs[N - 1].stakeIntegratorAtEnd;
            uint256 segEnd = rewardEpochs[N].stakeIntegratorAtEnd;
            _addUserPoints(account, N, S, segStart, segEnd);
        }

        // And the currently-open epoch: from (user's start boundary) to NOW.
        uint256 openSegStart = userEp == currentEp ? userSnap : rewardEpochs[currentEp - 1].stakeIntegratorAtEnd;
        _addUserPoints(account, currentEp, S, openSegStart, stakeIntegrator);

        userIntegratorSnap[account] = stakeIntegrator;
        userCurrentEpoch[account] = currentEp;
    }

    /// @dev Credit `S × (segEnd - segStart) / RAY` points to `(account, epoch)`.
    ///      No-op when `S == 0` or the integrator hasn't advanced. Shared by
    ///      `_captureUserPoints` and `catchUpPoints` so their math is
    ///      guaranteed identical.
    function _addUserPoints(address account, uint32 epoch, uint256 S, uint256 segStart, uint256 segEnd) internal {
        if (S == 0 || segEnd <= segStart) return;
        userPoints[account][epoch] += (S * (segEnd - segStart)) / _RAY;
    }
}
