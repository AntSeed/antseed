// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {AntseedSellerDelegation} from "./AntseedSellerDelegation.sol";

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
 *         for AntSeed. USDC and ANTS inflow is distributed pro-rata to stakers
 *         via two Uniswap-StakingRewards streams.
 *
 *         Channel lifecycle (reserve / topUp / settle / close) is provided by
 *         {AntseedSellerDelegation}. This contract overrides each to wrap the
 *         super call with USDC balance-delta capture; any inflow is forwarded
 *         to the USDC reward stream. Reward bookkeeping is purely local.
 *
 *         Per-user unlock times are tracked locally because Venice's on-chain
 *         cooldown is per-staker (= this proxy) — without per-user tracking,
 *         any late withdrawer would reset everyone's timer via Venice's
 *         `initiateUnstake`.
 *
 *         KNOWN GRIEFING SURFACE: Venice's shared cooldown still applies to
 *         the proxy as a whole. Any staker calling `initiateUnstake(1 wei)`
 *         resets that shared cooldown, which causes `diem.unstake()` in every
 *         other staker's `unstake()` call to revert until Venice's timer
 *         elapses. A sustained griefer (repeating tiny `initiateUnstake`
 *         calls before the cooldown expires) can indefinitely block all other
 *         stakers from withdrawing their DIEM principal — rewards continue to
 *         accrue during the delay, but the stake itself is stuck. Mitigation
 *         is operational, not on-chain: operators should coordinate
 *         withdrawal windows or rate-limit at the relayer layer.
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

    struct RewardStream {
        uint256 rewardRate;
        uint256 periodFinish;
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored;
        uint256 rewardsDuration;
    }

    struct PendingUnstake {
        uint128 amount;
        uint64 unlockAt;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Immutables
    // ═══════════════════════════════════════════════════════════════════

    IERC20 public immutable diem;
    IERC20 public immutable usdc;
    IERC20 public immutable ants;
    address public immutable emissions;
    address public immutable antseedStaking;

    uint8 internal constant STREAM_USDC = 0;
    uint8 internal constant STREAM_ANTS = 1;

    /// @dev Upper bound for `setRewardsDuration`. Prevents a compromised owner
    ///      from setting an absurdly short duration (e.g. 1 second → extreme
    ///      `rewardRate = amount / 1`) or an absurdly long one that traps
    ///      inflows in slow-release streams.
    uint256 public constant MAX_REWARDS_DURATION = 365 days;

    // ═══════════════════════════════════════════════════════════════════
    //                        Storage
    // ═══════════════════════════════════════════════════════════════════

    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    mapping(address => PendingUnstake) public pendingUnstake;

    RewardStream public usdcStream;
    RewardStream public antsStream;

    mapping(address => uint256) public userUsdcRewardPerTokenPaid;
    mapping(address => uint256) public userAntsRewardPerTokenPaid;
    mapping(address => uint256) public usdcRewards;
    mapping(address => uint256) public antsRewards;

    // ═══════════════════════════════════════════════════════════════════
    //                        Events
    // ═══════════════════════════════════════════════════════════════════

    event Staked(address indexed user, uint256 amount);
    event UnstakeInitiated(address indexed user, uint256 amount, uint256 unlockAt);
    event Unstaked(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 usdcAmount, uint256 antsAmount);
    event RewardNotified(uint8 indexed stream, uint256 amount, uint256 newPeriodFinish);
    event AntseedStakeWithdrawn(address indexed recipient, uint256 amount);
    event EmissionsClaimed(uint256 amount);
    event RewardsDurationUpdated(uint8 indexed stream, uint256 newDuration);

    // ═══════════════════════════════════════════════════════════════════
    //                        Custom Errors
    // ═══════════════════════════════════════════════════════════════════

    error InvalidAmount();
    error NoPendingUnstake();
    error StillCoolingDown();
    error RewardPeriodActive();
    error InvalidDuration();
    error InsufficientStake();

    // ═══════════════════════════════════════════════════════════════════
    //                        Constructor
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address _diem,
        address _usdc,
        address _ants,
        address _registry,
        address _emissions,
        address _antseedStaking,
        address _operator,
        uint256 _usdcRewardsDuration,
        uint256 _antsRewardsDuration
    )
        AntseedSellerDelegation(_registry, _operator)
    {
        if (_diem == address(0) || _usdc == address(0) || _ants == address(0)) revert InvalidAddress();
        if (_emissions == address(0) || _antseedStaking == address(0)) revert InvalidAddress();
        if (_usdcRewardsDuration == 0 || _usdcRewardsDuration > MAX_REWARDS_DURATION) revert InvalidDuration();
        if (_antsRewardsDuration == 0 || _antsRewardsDuration > MAX_REWARDS_DURATION) revert InvalidDuration();

        diem = IERC20(_diem);
        usdc = IERC20(_usdc);
        ants = IERC20(_ants);
        emissions = _emissions;
        antseedStaking = _antseedStaking;

        usdcStream.rewardsDuration = _usdcRewardsDuration;
        antsStream.rewardsDuration = _antsRewardsDuration;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Modifiers
    // ═══════════════════════════════════════════════════════════════════

    modifier updateRewards(address account) {
        _updateStream(usdcStream, userUsdcRewardPerTokenPaid, usdcRewards, account);
        _updateStream(antsStream, userAntsRewardPerTokenPaid, antsRewards, account);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        STAKER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Stake DIEM into the proxy. Proxy re-stakes into Venice in the same tx.
    function stake(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();

        staked[msg.sender] += amount;
        totalStaked += amount;

        diem.safeTransferFrom(msg.sender, address(this), amount);
        IDiemStake(address(diem)).stake(amount);

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Begin unstaking. Calls DIEM.initiateUnstake inline; stops reward
     *         accrual on the requested portion immediately. DIEM is claimable
     *         via `unstake()` after the per-user cooldown has elapsed.
     * @dev Multiple calls accumulate into a single pending bucket and reset
     *      the caller's `unlockAt` for the ENTIRE accumulated balance. Example:
     *      a caller with 50 DIEM pending for 23h who calls `initiateUnstake(1)`
     *      now waits a fresh full cooldown to withdraw the whole 51 DIEM.
     *
     *      Each call also resets Venice's shared cooldown for the whole proxy
     *      (see contract-level NatSpec on the griefing surface this creates).
     */
    function initiateUnstake(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (amount > staked[msg.sender]) revert InsufficientStake();

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        uint256 cd = IDiemStake(address(diem)).cooldownDuration();
        PendingUnstake storage pending = pendingUnstake[msg.sender];
        pending.amount += amount.toUint128();
        pending.unlockAt = (block.timestamp + cd).toUint64();

        IDiemStake(address(diem)).initiateUnstake(amount);

        emit UnstakeInitiated(msg.sender, amount, pending.unlockAt);
    }

    /// @notice Complete unstake after cooldown elapses. Transfers DIEM to caller.
    /// @dev Per-user `unlockAt` gates first. If proxy doesn't hold enough DIEM
    ///      yet, pulls the pending batch from Venice via `diem.unstake()` —
    ///      which itself reverts if Venice's shared cooldown hasn't elapsed
    ///      (e.g., another user just reset it with a fresh `initiateUnstake`).
    function unstake() external nonReentrant {
        PendingUnstake memory pending = pendingUnstake[msg.sender];
        if (pending.amount == 0) revert NoPendingUnstake();
        if (block.timestamp < pending.unlockAt) revert StillCoolingDown();

        if (diem.balanceOf(address(this)) < pending.amount) {
            IDiemStake(address(diem)).unstake();
        }

        delete pendingUnstake[msg.sender];
        diem.safeTransfer(msg.sender, pending.amount);

        emit Unstaked(msg.sender, pending.amount);
    }

    /// @notice Claim accrued USDC and ANTS rewards.
    function getReward() external nonReentrant updateRewards(msg.sender) {
        uint256 usdcEarned = usdcRewards[msg.sender];
        uint256 antsEarned = antsRewards[msg.sender];

        if (usdcEarned > 0) {
            usdcRewards[msg.sender] = 0;
            usdc.safeTransfer(msg.sender, usdcEarned);
        }
        if (antsEarned > 0) {
            antsRewards[msg.sender] = 0;
            ants.safeTransfer(msg.sender, antsEarned);
        }

        emit RewardPaid(msg.sender, usdcEarned, antsEarned);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL OVERRIDES (inflow capture)
    // ═══════════════════════════════════════════════════════════════════

    /// @dev `reserve` has no USDC inflow — base implementation is sufficient.

    /// @inheritdoc AntseedSellerDelegation
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public override {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
    }

    /// @inheritdoc AntseedSellerDelegation
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public override {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.settle(channelId, cumulativeAmount, metadata, buyerSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
    }

    /// @inheritdoc AntseedSellerDelegation
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) public override {
        uint256 beforeBal = usdc.balanceOf(address(this));
        super.close(channelId, finalAmount, metadata, buyerSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ANTS EMISSIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claim accumulated ANTS emissions from AntseedEmissions and notify the ANTS stream.
    ///         Operator is responsible for supplying the list of finalized epochs.
    function operatorClaimEmissions(uint256[] calldata epochs) external onlyOperator nonReentrant {
        uint256 beforeBal = ants.balanceOf(address(this));
        IAntseedEmissionsClaim(emissions).claimSellerEmissions(epochs);
        uint256 inflow = ants.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(antsStream, STREAM_ANTS, inflow);
        emit EmissionsClaimed(inflow);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Recover the proxy's seller stake from AntseedStaking (the USDC
     *         the owner pre-staked for the proxy to register as a seller).
     *         Callable once no channels are active (enforced by AntseedStaking).
     *         Any slashed amount stays with AntseedStaking's protocol reserve.
     * @dev Reverts while either reward stream is still distributing. Calling
     *      during an active stream would short-change stakers: the recovered
     *      USDC would be paid out to the owner instead of flowing into the
     *      active reward stream. Operators must let both streams finish before
     *      decommissioning.
     * @param recipient Address that receives the recovered USDC payout.
     */
    function withdrawAntseedStake(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (block.timestamp < usdcStream.periodFinish || block.timestamp < antsStream.periodFinish) {
            revert RewardPeriodActive();
        }
        uint256 beforeBal = usdc.balanceOf(address(this));
        IAntseedStakingSeller(antseedStaking).unstake();
        uint256 payout = usdc.balanceOf(address(this)) - beforeBal;
        if (payout > 0) usdc.safeTransfer(recipient, payout);
        emit AntseedStakeWithdrawn(recipient, payout);
    }

    /**
     * @notice Change the rewards duration for a stream. Only while the stream's
     *         current period has finished to avoid surprising dilution.
     * @param stream STREAM_USDC (0) or STREAM_ANTS (1).
     */
    function setRewardsDuration(uint8 stream, uint256 newDuration) external onlyOwner {
        if (newDuration == 0 || newDuration > MAX_REWARDS_DURATION) revert InvalidDuration();
        RewardStream storage s = stream == STREAM_USDC ? usdcStream : antsStream;
        if (block.timestamp < s.periodFinish) revert RewardPeriodActive();
        s.rewardsDuration = newDuration;
        emit RewardsDurationUpdated(stream, newDuration);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function earned(address account) external view returns (uint256 usdcEarned, uint256 antsEarned) {
        usdcEarned = usdcRewards[account]
            + (staked[account] * (_rewardPerToken(usdcStream) - userUsdcRewardPerTokenPaid[account])) / 1e18;
        antsEarned = antsRewards[account]
            + (staked[account] * (_rewardPerToken(antsStream) - userAntsRewardPerTokenPaid[account])) / 1e18;
    }

    function rewardPerTokenUsdc() external view returns (uint256) { return _rewardPerToken(usdcStream); }
    function rewardPerTokenAnts() external view returns (uint256) { return _rewardPerToken(antsStream); }

    // ═══════════════════════════════════════════════════════════════════
    //                        ERC-1271 (Venice API-key onboarding)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ERC-1271 signature validation. Returns the magic value when the
    ///         signature recovers to the current `owner()`. Used by Venice to
    ///         verify off-chain challenges when issuing the proxy's API key.
    /// @dev Intentionally keyed on the owner, not operators. Venice onboarding
    ///      is a rare admin action, not an ongoing operational one.
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
    //                        INTERNAL REWARD MATH
    // ═══════════════════════════════════════════════════════════════════

    function _lastTimeRewardApplicable(RewardStream storage s) internal view returns (uint256) {
        return block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
    }

    function _rewardPerToken(RewardStream storage s) internal view returns (uint256) {
        if (totalStaked == 0) return s.rewardPerTokenStored;
        uint256 timeDelta = _lastTimeRewardApplicable(s) - s.lastUpdateTime;
        return s.rewardPerTokenStored + (timeDelta * s.rewardRate * 1e18) / totalStaked;
    }

    function _updateStream(
        RewardStream storage s,
        mapping(address => uint256) storage paid,
        mapping(address => uint256) storage userRewards,
        address account
    ) internal {
        s.rewardPerTokenStored = _rewardPerToken(s);
        s.lastUpdateTime = _lastTimeRewardApplicable(s);
        if (account != address(0)) {
            userRewards[account] += (staked[account] * (s.rewardPerTokenStored - paid[account])) / 1e18;
            paid[account] = s.rewardPerTokenStored;
        }
    }

    function _notifyRewardAmount(RewardStream storage s, uint8 streamId, uint256 amount) internal {
        s.rewardPerTokenStored = _rewardPerToken(s);
        s.lastUpdateTime = block.timestamp;

        if (block.timestamp >= s.periodFinish) {
            s.rewardRate = amount / s.rewardsDuration;
        } else {
            uint256 remaining = s.periodFinish - block.timestamp;
            uint256 leftover = remaining * s.rewardRate;
            s.rewardRate = (amount + leftover) / s.rewardsDuration;
        }
        s.periodFinish = block.timestamp + s.rewardsDuration;

        emit RewardNotified(streamId, amount, s.periodFinish);
    }
}
