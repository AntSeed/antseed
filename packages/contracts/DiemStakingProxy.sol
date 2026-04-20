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
 *         UNSTAKE FLOW — epoch batching:
 *           1. `initiateUnstake(amount)` queues into `currentEpoch`. No Venice
 *              call yet. Reward accrual on the queued amount stops immediately.
 *           2. `flush()` (permissionless) sends the epoch to Venice in one
 *              shot, stamps `unlockAt = now + venice_cd`, opens a fresh epoch.
 *           3. After Venice's cooldown, `claimEpoch(id)` (permissionless)
 *              drains Venice and pays every user from the explicit per-user
 *              map. Serialization invariant: Venice only holds one epoch at a
 *              time.
 *
 *         USDC DISTRIBUTION — instant credit:
 *           Each settle bumps `usdcStream.rewardPerTokenStored` inline; stakers
 *           at the moment of the inflow receive their pro-rata share and can
 *           `claimUsdc()` at any time. Equivalent to a Synthetix drip with
 *           `duration = 1` — settles are discrete events, not periods.
 *
 *         ANTS DISTRIBUTION — points + per-epoch pot:
 *           Users accumulate internal "points" based on stake-time weighted by
 *           1/totalStaked (a Compound-style integrator). At operator tick for
 *           a finalized emission epoch, the ANTS arrives and is stored as a
 *           per-epoch pot. Users call `claimAnts(n)` to convert their points
 *           for the next `n` completed epochs into ANTS.
 *
 *           Properties:
 *             - Points persist through unstakes — a user who fully unstakes
 *               can still claim ANTS for epochs they contributed to.
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

    /// @dev ERC-1271 magic value for a valid signature.
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // ═══════════════════════════════════════════════════════════════════
    //                        Structs
    // ═══════════════════════════════════════════════════════════════════

    struct Epoch {
        uint128 total;      // sum of every user's queued amount in this epoch
        uint64 unlockAt;    // 0 = not yet flushed; otherwise venice-release time
        uint32 userCount;   // length of epochUsers[id], cached for MAX check
        bool claimed;
    }

    struct RewardEpoch {
        uint256 stakeIntegratorAtEnd;  // global integrator value at epoch close
        uint256 activeSecondsAtEnd;    // cumulative seconds with totalStaked > 0 at close
        uint256 antsPot;               // ANTS received from AntseedEmissions at close
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Immutables
    // ═══════════════════════════════════════════════════════════════════

    IERC20 public immutable diem;
    IERC20 public immutable usdc;
    IERC20 public immutable ants;
    address public immutable emissions;
    address public immutable antseedStaking;

    /// @dev Max distinct users per unstake epoch. Caps `claimEpoch`'s transfer
    ///      loop at ~50 × 50k gas = 2.5M gas, well under the block limit while
    ///      giving each epoch room for a realistic cohort of unstakers.
    uint32 public constant MAX_PER_EPOCH = 50;

    /// @dev Max reward-epoch backlog that `_captureUserPoints` will traverse in
    ///      a single tx. Beyond this, stake/unstake reverts with `BacklogTooLarge`
    ///      and the user must call `catchUpPoints` first to process incrementally.
    ///      16 epochs × an expected ~weekly tick = ~4 months of dormancy tolerated.
    uint32 public constant MAX_EPOCHS_PER_CAPTURE = 16;

    /// @dev Alpha-launch cap applied at construction. Caps `totalStaked` at 50
    ///      DIEM until the owner raises it via `setMaxTotalStake`. Owner may
    ///      set to `0` (unlimited) at any time. Assumes 18-decimal DIEM.
    uint256 public constant ALPHA_MAX_TOTAL_STAKE = 50e18;

    /// @dev Default minimum time an unstake cohort must remain open before
    ///      `flush()` is allowed. Prevents a first queuer from immediately
    ///      flushing and pushing every other would-be unstaker into the next
    ///      cohort (which would then have to wait a full extra Venice cooldown).
    ///      The window is measured from the first `initiateUnstake` into the
    ///      cohort, so dry-spell cohorts still enforce it. 24h gives stakers a
    ///      predictable joining window without adding noticeable friction on
    ///      top of Venice's own cooldown.
    uint64 public constant ALPHA_MIN_EPOCH_OPEN_SECS = 1 days;

    /// @dev Upper bound on `setMinEpochOpenSecs`. Caps how long the owner can
    ///      make stakers wait before a cohort can leave. 7 days is long
    ///      enough to absorb any reasonable operational need (e.g. a one-week
    ///      cohort cadence) but short enough that owner misconfiguration
    ///      can't effectively freeze withdrawals.
    uint64 public constant MAX_MIN_EPOCH_OPEN_SECS = 7 days;

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

    /// @dev Unstake-epoch state. `currentEpoch` accepts new queuers;
    ///      `oldestUnclaimed` is the lowest flushed-but-not-yet-claimed epoch
    ///      id. A new epoch can only be flushed once the prior one has been
    ///      claimed — Venice only ever holds one epoch at a time.
    mapping(uint32 => Epoch) public epochs;
    mapping(uint32 => address[]) public epochUsers;
    mapping(uint32 => mapping(address => uint128)) public epochUserAmount;
    uint32 public currentEpoch;
    uint32 public oldestUnclaimed;

    /// @dev Timestamp (as uint64) at which the currently-open cohort received
    ///      its first queuer. Zero means the cohort is empty. Reset to zero
    ///      on flush so the next cohort's clock restarts fresh on its first
    ///      `initiateUnstake`.
    uint64 public currentEpochOpenedAt;

    /// @dev Minimum wall-clock seconds a cohort must stay open before
    ///      `flush()` will accept it. Owner-settable, bounded by
    ///      `MAX_MIN_EPOCH_OPEN_SECS`. `0` disables the gate entirely.
    uint64 public minEpochOpenSecs;

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

    /// @dev Global stake-time integrator: A(t) = ∫ 1/totalStaked(τ) dτ × 1e18.
    ///      A user staked with `S` over an interval with Δintegrator gains
    ///      `S × Δintegrator / 1e18` points for that interval.
    uint256 public stakeIntegrator;
    uint256 public lastIntegratorUpdate;

    /// @dev Cumulative wall-clock seconds where `totalStaked > 0`. Serves as
    ///      the denominator when converting per-user points into an epoch
    ///      fraction: sum over users of points in epoch = activeSeconds in epoch.
    uint256 public activeSecondsAccumulator;

    /// @dev Reward-epoch state. `currentRewardEpoch` is the one accumulating
    ///      USDC inflows and stake-time; each `operatorClaimEmissions` call
    ///      closes it and opens the next.
    mapping(uint32 => RewardEpoch) public rewardEpochs;
    uint32 public currentRewardEpoch;

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
    event UnstakeQueued(address indexed user, uint32 indexed epochId, uint256 amount);
    event EpochFlushed(uint32 indexed epochId, uint256 total, uint256 unlockAt);
    event EpochClaimed(uint32 indexed epochId, uint256 total, uint32 userCount);
    event Unstaked(address indexed user, uint256 amount);
    event UsdcDistributed(uint256 amount);
    event UsdcPaid(address indexed user, uint256 amount);
    event RewardEpochClosed(uint32 indexed rewardEpochId, uint256 antsPot, uint256 stakeIntegratorAtEnd, uint256 activeSecondsAtEnd);
    event AntsClaimed(address indexed user, uint32 fromEpoch, uint32 toEpoch, uint256 antsAmount);
    event PointsCaughtUp(address indexed user, uint32 newCurrentEpoch);
    event AntseedStakeWithdrawn(address indexed recipient, uint256 amount);
    event OrphanUsdcSwept(address indexed recipient, uint256 amount);
    event MaxTotalStakeSet(uint256 newMaxTotalStake);
    event MinEpochOpenSecsSet(uint64 newMinEpochOpenSecs);

    // ═══════════════════════════════════════════════════════════════════
    //                        Custom Errors
    // ═══════════════════════════════════════════════════════════════════

    error InvalidAmount();
    error InsufficientStake();
    error EpochFull();
    error NothingToFlush();
    error PriorEpochUnclaimed();
    error EpochNotReady();
    error EpochAlreadyClaimed();
    error EpochTooYoung();
    error BacklogTooLarge();
    error NothingToClaim();
    error MaxStakeExceeded();
    error MinEpochOpenSecsTooLarge();

    // ═══════════════════════════════════════════════════════════════════
    //                        Constructor
    // ═══════════════════════════════════════════════════════════════════

    /// @param _diem External Venice DIEM contract (not in AntseedRegistry).
    /// @param _usdc USDC token used by channels/staking. Kept explicit.
    /// @param _registry AntSeed address book. `ants`, `emissions`, and
    ///                  `antseedStaking` are resolved from it at construction
    ///                  and pinned as immutables for the proxy's lifetime.
    /// @param _operator Initial authorized operator for channel lifecycle ops.
    constructor(
        address _diem,
        address _usdc,
        address _registry,
        address _operator
    )
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

        // Epoch 0 is unused so `unlockAt == 0` remains a reliable "not yet
        // flushed" sentinel. Queuing starts at epoch 1.
        currentEpoch = 1;
        oldestUnclaimed = 1;

        lastIntegratorUpdate = block.timestamp;

        // Ship with an alpha-launch stake cap. Owner can raise it or remove
        // entirely (set to 0) via `setMaxTotalStake`. Emitted so indexers and
        // the frontend's `maxTotalStake()` read pick up the initial value
        // consistently with later owner changes.
        maxTotalStake = ALPHA_MAX_TOTAL_STAKE;
        emit MaxTotalStakeSet(ALPHA_MAX_TOTAL_STAKE);

        // Ship with a 24h minimum cohort-open window so a first queuer can't
        // immediately flush and push later unstakers into a fresh Venice
        // cooldown. Owner can retune via `setMinEpochOpenSecs` (capped at
        // `MAX_MIN_EPOCH_OPEN_SECS`) or disable by setting `0`.
        minEpochOpenSecs = ALPHA_MIN_EPOCH_OPEN_SECS;
        emit MinEpochOpenSecsSet(ALPHA_MIN_EPOCH_OPEN_SECS);
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
     * @notice Queue `amount` DIEM for unstaking. Joins the current open epoch.
     *         Reward accrual on the queued amount stops immediately. The
     *         epoch is sent to Venice in one shot via `flush()`.
     */
    function initiateUnstake(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (amount > staked[msg.sender]) revert InsufficientStake();

        uint32 epochId = currentEpoch;
        Epoch storage e = epochs[epochId];

        // First queuer into this cohort starts the minimum-open-window
        // clock. Measuring from the first queue (not from when the cohort
        // slot was created) means a dry-spell cohort still enforces the
        // window on whoever eventually queues first, matching user intent:
        // "give other stakers a chance to join before the cohort leaves".
        if (e.total == 0) currentEpochOpenedAt = uint64(block.timestamp);

        uint128 existing = epochUserAmount[epochId][msg.sender];
        if (existing == 0) {
            if (e.userCount >= MAX_PER_EPOCH) revert EpochFull();
            epochUsers[epochId].push(msg.sender);
            e.userCount += 1;
        }

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        // Track distinct-staker count on the N→0 (full exit) transition.
        // Only decrement when the user has no remaining active stake — partial
        // unstakes leave them counted. Note: `staked` here reflects post-subtract.
        if (staked[msg.sender] == 0) stakerCount -= 1;

        uint128 amt128 = amount.toUint128();
        epochUserAmount[epochId][msg.sender] = existing + amt128;
        e.total += amt128;

        emit UnstakeQueued(msg.sender, epochId, amount);
    }

    /**
     * @notice Send the current unstake epoch to Venice and open a fresh one.
     *         Permissionless. Serialization: a new epoch can only be flushed
     *         after the prior one is claimed.
     */
    function flush() external nonReentrant {
        if (currentEpoch != oldestUnclaimed) revert PriorEpochUnclaimed();

        uint32 epochId = currentEpoch;
        Epoch storage e = epochs[epochId];
        if (e.total == 0) revert NothingToFlush();

        // Enforce the minimum open window. `currentEpochOpenedAt == 0`
        // when the cohort is empty, which is caught by the NothingToFlush
        // check above — so by this point `openedAt` is always a real
        // timestamp. Using `>` (not `>=`) is deliberate: exactly-at-boundary
        // plays nicely with test warps that land on the exact second.
        uint64 openedAt = currentEpochOpenedAt;
        if (block.timestamp < uint256(openedAt) + uint256(minEpochOpenSecs)) {
            revert EpochTooYoung();
        }

        uint256 cd = IDiemStake(address(diem)).cooldownDuration();
        uint64 unlockAt = (block.timestamp + cd).toUint64();
        e.unlockAt = unlockAt;

        currentEpoch = epochId + 1;
        // Next cohort starts empty — its clock will set on its first queuer.
        currentEpochOpenedAt = 0;

        IDiemStake(address(diem)).initiateUnstake(e.total);

        emit EpochFlushed(epochId, e.total, unlockAt);
    }

    /**
     * @notice Drain `epochId` from Venice and pay out every user in it.
     *         Permissionless. Proxy's direct DIEM balance is 0 before and
     *         after this call.
     */
    function claimEpoch(uint32 epochId) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.unlockAt == 0 || block.timestamp < e.unlockAt) revert EpochNotReady();
        if (e.claimed) revert EpochAlreadyClaimed();

        e.claimed = true;
        if (epochId == oldestUnclaimed) oldestUnclaimed = epochId + 1;

        IDiemStake(address(diem)).unstake();

        address[] storage users = epochUsers[epochId];
        uint256 count = users.length;
        for (uint256 i = 0; i < count; i++) {
            address user = users[i];
            uint128 amount = epochUserAmount[epochId][user];
            delete epochUserAmount[epochId][user];
            diem.safeTransfer(user, amount);
            emit Unstaked(user, amount);
        }

        emit EpochClaimed(epochId, e.total, uint32(count));
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
        uint32 to = from + numEpochs;
        if (to > currentRewardEpoch) to = currentRewardEpoch;
        if (to == from) revert NothingToClaim();

        uint256 totalAnts;
        for (uint32 N = from; N < to; N++) {
            RewardEpoch memory re = rewardEpochs[N];
            // Intentional: epochs with antsPot == 0 or totalPoints == 0 have
            // nothing to pay out. We still advance `userLastClaimedEpoch`
            // below, which permanently abandons any userPoints entry for
            // these epochs. Since no pot ever exists to convert those points
            // into ANTS, there is nothing to claim — the points are logically
            // worthless. The storage slot remains non-zero but is unreachable.
            if (re.antsPot == 0) continue;
            uint256 totalPoints = N == 0
                ? re.activeSecondsAtEnd
                : re.activeSecondsAtEnd - rewardEpochs[N - 1].activeSecondsAtEnd;
            if (totalPoints == 0) continue;
            uint256 userPts = userPoints[msg.sender][N];
            if (userPts == 0) continue;
            totalAnts += (re.antsPot * userPts) / totalPoints;
            delete userPoints[msg.sender][N];
        }
        userLastClaimedEpoch[msg.sender] = to;

        if (totalAnts > 0) {
            ants.safeTransfer(msg.sender, totalAnts);
        }
        emit AntsClaimed(msg.sender, from, to, totalAnts);
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
        _updateStakeIntegrator();

        uint32 userEp = userCurrentEpoch[msg.sender];
        uint32 currentEp = currentRewardEpoch;
        uint32 targetEp = userEp + numEpochs;
        if (targetEp > currentEp) targetEp = currentEp;
        if (targetEp == userEp) revert NothingToClaim();

        uint256 S = staked[msg.sender];
        uint256 userSnap = userIntegratorSnap[msg.sender];

        // Accumulate points for fully completed epochs [userEp, targetEp).
        // `targetEp` itself (and, if targetEp == currentEp, the open epoch)
        // are left for a later capture, since their integratorAtEnd isn't
        // finalized yet.
        for (uint32 N = userEp; N < targetEp; N++) {
            uint256 segStart = N == userEp ? userSnap : rewardEpochs[N - 1].stakeIntegratorAtEnd;
            uint256 segEnd = rewardEpochs[N].stakeIntegratorAtEnd;
            if (S > 0 && segEnd > segStart) {
                userPoints[msg.sender][N] += (S * (segEnd - segStart)) / 1e18;
            }
        }

        userIntegratorSnap[msg.sender] = targetEp == 0 ? 0 : rewardEpochs[targetEp - 1].stakeIntegratorAtEnd;
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
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public override nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.settle(channelId, cumulativeAmount, metadata, buyerSig);
        _distributeUsdcInstant(usdc.balanceOf(address(this)) - beforeBal);
    }

    /// @inheritdoc AntseedSellerDelegation
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public override nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.close(channelId, finalAmount, metadata, buyerSig);
        _distributeUsdcInstant(usdc.balanceOf(address(this)) - beforeBal);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OPERATOR TICK (ANTS emissions)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim ANTS emissions for the given finalized `emissionEpochId`
     *         and close the current reward epoch, making its points claimable.
     *         Operator is expected to tick sequentially as AntseedEmissions
     *         finalizes each epoch.
     */
    function operatorClaimEmissions(uint256 emissionEpochId) external onlyOperator nonReentrant {
        _updateStakeIntegrator();

        uint256 beforeBal = ants.balanceOf(address(this));
        uint256[] memory ids = new uint256[](1);
        ids[0] = emissionEpochId;
        IAntseedEmissionsClaim(emissions).claimSellerEmissions(ids);
        uint256 inflow = ants.balanceOf(address(this)) - beforeBal;

        uint32 rewardEpoch = currentRewardEpoch;
        rewardEpochs[rewardEpoch] = RewardEpoch({
            stakeIntegratorAtEnd: stakeIntegrator,
            activeSecondsAtEnd: activeSecondsAccumulator,
            antsPot: inflow
        });
        currentRewardEpoch = rewardEpoch + 1;

        emit RewardEpochClosed(rewardEpoch, inflow, stakeIntegrator, activeSecondsAccumulator);
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
     * @notice Set the minimum cohort-open window (seconds). `0` disables the
     *         gate. Capped at `MAX_MIN_EPOCH_OPEN_SECS` so owner cannot grief
     *         stakers with an unreasonably long window.
     *         Takes effect on the next `flush` check; does not retroactively
     *         shorten an already-elapsed window.
     */
    function setMinEpochOpenSecs(uint64 newMinEpochOpenSecs) external onlyOwner {
        if (newMinEpochOpenSecs > MAX_MIN_EPOCH_OPEN_SECS) revert MinEpochOpenSecsTooLarge();
        minEpochOpenSecs = newMinEpochOpenSecs;
        emit MinEpochOpenSecsSet(newMinEpochOpenSecs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Unix timestamp at which `flush()` will first be callable for
    ///         the currently-open cohort. Returns `0` if the cohort is still
    ///         empty (no first queuer yet) — in that case `flush` is blocked
    ///         by `NothingToFlush` regardless of this timestamp.
    function flushableAt() external view returns (uint64) {
        uint64 openedAt = currentEpochOpenedAt;
        if (openedAt == 0) return 0;
        return openedAt + minEpochOpenSecs;
    }

    /// @notice USDC earned and claimable by `account` right now.
    function earnedUsdc(address account) external view returns (uint256) {
        return usdcRewards[account]
            + (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / 1e18;
    }

    /// @notice Preview ANTS for a single completed reward epoch for `account`.
    ///         Does not mutate state. Returns 0 for the currently-open epoch.
    /// @dev Computes uncaptured points lazily if the user hasn't interacted
    ///      since before/during the epoch, assuming their stake has been
    ///      constant since their last interaction. (This invariant holds
    ///      because any stake change would have triggered `updateRewards`.)
    function pendingAntsForEpoch(address account, uint32 rewardEpoch)
        external
        view
        returns (uint256)
    {
        if (rewardEpoch >= currentRewardEpoch) return 0;
        RewardEpoch memory re = rewardEpochs[rewardEpoch];
        if (re.antsPot == 0) return 0;
        uint256 totalPoints = rewardEpoch == 0
            ? re.activeSecondsAtEnd
            : re.activeSecondsAtEnd - rewardEpochs[rewardEpoch - 1].activeSecondsAtEnd;
        if (totalPoints == 0) return 0;

        uint256 userPts = userPoints[account][rewardEpoch];

        // Add uncaptured contribution if the user's last capture was at or
        // before the start of this epoch and they're currently staked.
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
                userPts += (S * (segEnd - segStart)) / 1e18;
            }
        }

        if (userPts == 0) return 0;
        return (re.antsPot * userPts) / totalPoints;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ERC-1271 (Venice API-key onboarding)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ERC-1271 signature validation. Returns the magic value when
    ///         the signature recovers to the current `owner()`. Used by
    ///         Venice to verify off-chain challenges when issuing the proxy's
    ///         API key.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4)
    {
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
        usdcRewardPerTokenStored += (amount * 1e18) / totalStaked;
        // Track total owed for the sweep-safety ledger. Includes rounding dust
        // (which is never actually owed to a user) as a conservative margin.
        totalUsdcReservedForStakers += amount;
        // Lifetime counter — never decremented, powers the "USDC distributed
        // · all time" frontend tile with a single SLOAD.
        totalUsdcDistributedEver += amount;
        emit UsdcDistributed(amount);
    }

    /// @dev Settle `account`'s USDC reward debt against the current
    ///      accumulator. Must fire before any `staked[account]` change.
    function _updateUsdcForUser(address account) internal {
        if (account != address(0)) {
            uint256 delta = (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / 1e18;
            if (delta > 0) usdcRewards[account] += delta;
            userUsdcRewardPerTokenPaid[account] = usdcRewardPerTokenStored;
        }
    }

    /// @dev Advance `stakeIntegrator` and `activeSecondsAccumulator` to now.
    function _updateStakeIntegrator() internal {
        uint256 delta = block.timestamp - lastIntegratorUpdate;
        if (delta > 0 && totalStaked > 0) {
            stakeIntegrator += (delta * 1e18) / totalStaked;
            activeSecondsAccumulator += delta;
        }
        lastIntegratorUpdate = block.timestamp;
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
            if (segEnd > segStart) {
                userPoints[account][N] += (S * (segEnd - segStart)) / 1e18;
            }
        }

        // And the currently-open epoch: from (user's start boundary) to NOW.
        {
            uint256 segStart = userEp == currentEp
                ? userSnap
                : rewardEpochs[currentEp - 1].stakeIntegratorAtEnd;
            if (stakeIntegrator > segStart) {
                userPoints[account][currentEp] += (S * (stakeIntegrator - segStart)) / 1e18;
            }
        }

        userIntegratorSnap[account] = stakeIntegrator;
        userCurrentEpoch[account] = currentEp;
    }
}
