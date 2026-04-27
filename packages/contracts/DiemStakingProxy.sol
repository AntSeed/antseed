// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { AntseedSellerDelegation } from "./AntseedSellerDelegation.sol";
import { IAntseedRegistry } from "./interfaces/IAntseedRegistry.sol";

interface IDiemStake {
    function stake(uint256 amount) external;
    function initiateUnstake(uint256 amount) external;
    function unstake() external;
    function cooldownDuration() external view returns (uint256);
}

contract DiemStakingProxy is AntseedSellerDelegation, IERC1271, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ─── Constants ──────────────────────────────────────────────────
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // ─── Structs ────────────────────────────────────────────────────
    struct UnstakeBatch {
        uint128 total; // sum of every user's queued amount in this batch
        uint64 unlockAt; // 0 = not yet flushed; otherwise venice-release time
        uint32 userCount; // length of unstakeBatchUsers[id], cached for MAX check
        bool claimed;
    }

    struct RewardEpoch {
        uint256 revenuePerTokenAtEnd; // USDC reward-per-token checkpoint at epoch close
        uint256 totalPoints; // epoch-local revenue denominator for userPoints shares
        uint256 antsPot; // ANTS received from AntseedEmissions when first claimed
        bool funded; // true once the epoch's ANTS pot has been claimed from AntseedEmissions
    }

    // ─── Immutables ─────────────────────────────────────────────────
    IERC20 public immutable diem;
    IERC20 public immutable usdc;
    IERC20 public immutable ants;
    address public immutable emissions;
    uint32 public immutable firstRewardEpoch;

    uint32 public constant MAX_PER_UNSTAKE_BATCH = 50;

    uint32 public constant MAX_EPOCHS_PER_CAPTURE = 16;

    uint256 public constant ALPHA_MAX_TOTAL_STAKE = 10e18;

    uint64 public constant ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS = 1 days;

    uint64 public constant MAX_MIN_UNSTAKE_BATCH_OPEN_SECS = 7 days;

    // ─── Staking State ──────────────────────────────────────────────
    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    uint256 public maxTotalStake;

    uint32 public stakerCount;

    mapping(uint32 => UnstakeBatch) public unstakeBatches;
    mapping(uint32 => address[]) public unstakeBatchUsers;
    mapping(uint32 => mapping(address => uint128)) public unstakeBatchUserAmount;
    uint32 public currentUnstakeBatch;
    uint32 public oldestUnclaimedUnstakeBatch;

    uint64 public currentUnstakeBatchOpenedAt;

    uint64 public minUnstakeBatchOpenSecs;

    // ─── USDC Rewards ───────────────────────────────────────────────
    uint256 public usdcRewardPerTokenStored;

    mapping(address => uint256) public userUsdcRewardPerTokenPaid;
    mapping(address => uint256) public usdcRewards;

    uint256 public totalUsdcReservedForStakers;

    uint256 public totalUsdcDistributedEver;

    // ─── ANTS Rewards ───────────────────────────────────────────────
    uint256 private constant _RAY = 1e27;

    uint256 public currentEpochRevenuePoints;

    mapping(uint32 => RewardEpoch) public rewardEpochs;
    uint32 public syncedRewardEpoch;

    mapping(address => mapping(uint32 => uint256)) public userPoints;

    mapping(address => uint256) public userRevenuePerTokenSnap;
    mapping(address => uint32) public userCurrentEpoch;
    mapping(address => uint32) public userLastClaimedEpoch;
    mapping(address => mapping(uint32 => bool)) public userEpochClaimed;

    // ─── Events ─────────────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event UnstakeQueued(address indexed user, uint32 indexed batchId, uint256 amount);
    event UnstakeBatchFlushed(uint32 indexed batchId, uint256 total, uint256 unlockAt);
    event UnstakeBatchClaimed(uint32 indexed batchId, uint256 total, uint32 userCount);
    event Unstaked(address indexed user, uint256 amount);
    event UsdcDistributed(uint256 amount);
    event UsdcPaid(address indexed user, uint256 amount);
    event RewardEpochClosed(uint32 indexed rewardEpochId, uint256 revenuePerTokenAtEnd, uint256 totalPoints);
    event RewardEpochFunded(uint32 indexed rewardEpochId, uint256 antsPot);
    event RewardEpochsSynced(uint32 fromEpoch, uint32 toEpoch);
    event AntsClaimed(address indexed user, uint32[] rewardEpochs, uint256 antsAmount);
    event PointsCaughtUp(address indexed user, uint32 newCurrentEpoch);
    event OrphanUsdcSwept(address indexed recipient, uint256 amount);
    event MaxTotalStakeSet(uint256 newMaxTotalStake);
    event MinUnstakeBatchOpenSecsSet(uint64 newMinUnstakeBatchOpenSecs);

    // ─── Custom Errors ──────────────────────────────────────────────
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
    error NothingToSync();
    error MaxStakeExceeded();
    error MinUnstakeBatchOpenSecsTooLarge();
    error RewardEpochNotFinalized();

    // ─── Constructor ────────────────────────────────────────────────
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

        currentUnstakeBatch = 1;
        oldestUnclaimedUnstakeBatch = 1;

        uint32 _firstRewardEpoch = _currentEmissionsEpoch().toUint32();
        firstRewardEpoch = _firstRewardEpoch;
        syncedRewardEpoch = _firstRewardEpoch;

        maxTotalStake = ALPHA_MAX_TOTAL_STAKE;
        emit MaxTotalStakeSet(ALPHA_MAX_TOTAL_STAKE);

        minUnstakeBatchOpenSecs = ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS;
        emit MinUnstakeBatchOpenSecsSet(ALPHA_MIN_UNSTAKE_BATCH_OPEN_SECS);
    }

    // ─── Modifiers ──────────────────────────────────────────────────
    modifier updateRewards(address account) {
        _updateUsdcForUser(account);
        _syncFinalizedRewardEpochsForUpdate();
        _captureUserPoints(account);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        STAKING
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 amount) external nonReentrant whenNotPaused updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        uint256 cap = maxTotalStake;
        if (cap != 0 && totalStaked + amount > cap) revert MaxStakeExceeded();

        if (staked[msg.sender] == 0) stakerCount += 1;

        staked[msg.sender] += amount;
        totalStaked += amount;

        diem.safeTransferFrom(msg.sender, address(this), amount);
        IDiemStake(address(diem)).stake(amount);

        emit Staked(msg.sender, amount);
    }

    function initiateUnstake(uint256 amount) external nonReentrant whenNotPaused updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (amount > staked[msg.sender]) revert InsufficientStake();

        uint32 batchId = currentUnstakeBatch;
        UnstakeBatch storage e = unstakeBatches[batchId];

        if (e.total == 0) currentUnstakeBatchOpenedAt = uint64(block.timestamp);

        uint128 existing = unstakeBatchUserAmount[batchId][msg.sender];
        if (existing == 0) {
            if (e.userCount >= MAX_PER_UNSTAKE_BATCH) revert UnstakeBatchFull();
            unstakeBatchUsers[batchId].push(msg.sender);
            e.userCount += 1;
        }

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        if (staked[msg.sender] == 0) stakerCount -= 1;

        uint128 amt128 = amount.toUint128();
        unstakeBatchUserAmount[batchId][msg.sender] = existing + amt128;
        e.total += amt128;

        emit UnstakeQueued(msg.sender, batchId, amount);
    }

    function flush() external nonReentrant whenNotPaused {
        if (currentUnstakeBatch != oldestUnclaimedUnstakeBatch) revert PriorUnstakeBatchUnclaimed();

        uint32 batchId = currentUnstakeBatch;
        UnstakeBatch storage e = unstakeBatches[batchId];
        if (e.total == 0) revert NothingToFlush();

        uint64 openedAt = currentUnstakeBatchOpenedAt;
        if (
            e.userCount < MAX_PER_UNSTAKE_BATCH
                && block.timestamp < uint256(openedAt) + uint256(minUnstakeBatchOpenSecs)
        ) {
            revert UnstakeBatchTooYoung();
        }

        uint256 cd = IDiemStake(address(diem)).cooldownDuration();
        uint64 unlockAt = (block.timestamp + cd).toUint64();
        e.unlockAt = unlockAt;

        currentUnstakeBatch = batchId + 1;
        currentUnstakeBatchOpenedAt = 0;

        IDiemStake(address(diem)).initiateUnstake(e.total);

        emit UnstakeBatchFlushed(batchId, e.total, unlockAt);
    }

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

    function claimUsdc() external nonReentrant whenNotPaused updateRewards(msg.sender) {
        uint256 owed = usdcRewards[msg.sender];
        if (owed == 0) revert NothingToClaim();
        usdcRewards[msg.sender] = 0;
        totalUsdcReservedForStakers -= owed;
        usdc.safeTransfer(msg.sender, owed);
        emit UsdcPaid(msg.sender, owed);
    }

    function claimAnts(uint32[] calldata rewardEpochIds) external nonReentrant whenNotPaused {
        uint256 len = rewardEpochIds.length;
        if (len == 0 || len > MAX_EPOCHS_PER_CAPTURE) revert InvalidAmount();

        uint32 target = firstRewardEpoch;
        for (uint256 i = 0; i < len; i++) {
            uint32 rewardEpoch = rewardEpochIds[i];
            if (rewardEpoch < firstRewardEpoch) revert RewardEpochNotFinalized();
            uint32 next = rewardEpoch + 1;
            if (next > target) target = next;
        }

        uint32 finalized = _finalizedRewardEpoch();
        if (target > finalized) revert RewardEpochNotFinalized();

        _updateUsdcForUser(msg.sender);
        if (target > syncedRewardEpoch) {
            if (target - syncedRewardEpoch > MAX_EPOCHS_PER_CAPTURE) revert BacklogTooLarge();
            _syncRewardEpochsUntil(target);
        }
        _captureUserPoints(msg.sender);

        uint256 totalAnts;
        bool processed;
        for (uint256 i = 0; i < len; i++) {
            uint32 N = rewardEpochIds[i];
            if (userEpochClaimed[msg.sender][N]) continue;

            userEpochClaimed[msg.sender][N] = true;
            processed = true;

            uint256 userPts = userPoints[msg.sender][N];
            if (userPts == 0) {
                continue;
            }

            uint256 totalPoints = rewardEpochs[N].totalPoints;
            if (totalPoints == 0) {
                delete userPoints[msg.sender][N];
                continue;
            }

            uint256 antsPot = rewardEpochs[N].funded ? rewardEpochs[N].antsPot : _fundRewardEpoch(N);
            if (antsPot == 0) {
                delete userPoints[msg.sender][N];
                continue;
            }
            totalAnts += (antsPot * userPts) / totalPoints;
            delete userPoints[msg.sender][N];
        }
        if (!processed) revert NothingToClaim();
        _advanceUserClaimCursor(msg.sender);

        if (totalAnts > 0) {
            ants.safeTransfer(msg.sender, totalAnts);
        }
        emit AntsClaimed(msg.sender, rewardEpochIds, totalAnts);
    }

    function catchUpPoints(uint32 numEpochs) external nonReentrant whenNotPaused {
        if (numEpochs == 0) revert InvalidAmount();
        _updateUsdcForUser(msg.sender);
        _syncFinalizedRewardEpochsBounded(numEpochs);

        uint32 userEp = userCurrentEpoch[msg.sender];
        uint32 currentEp = syncedRewardEpoch;
        uint32 targetEp = userEp + numEpochs;
        if (targetEp > currentEp) targetEp = currentEp;
        if (targetEp == userEp) revert NothingToClaim();

        uint256 S = staked[msg.sender];
        uint256 userSnap = userRevenuePerTokenSnap[msg.sender];

        for (uint32 N = userEp; N < targetEp; N++) {
            uint256 segStart = N == userEp ? userSnap : rewardEpochs[N - 1].revenuePerTokenAtEnd;
            uint256 segEnd = rewardEpochs[N].revenuePerTokenAtEnd;
            _addUserPoints(msg.sender, N, S, segStart, segEnd);
        }

        userRevenuePerTokenSnap[msg.sender] = rewardEpochs[targetEp - 1].revenuePerTokenAtEnd;
        userCurrentEpoch[msg.sender] = targetEp;

        emit PointsCaughtUp(msg.sender, targetEp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL OVERRIDES
    // ═══════════════════════════════════════════════════════════════════

    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public override nonReentrant whenNotPaused returns (uint256 netPayout) {
        netPayout = super.topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        _distributeUsdcInstant(netPayout);
    }

    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 netPayout)
    {
        netPayout = super.settle(channelId, cumulativeAmount, metadata, buyerSig);
        _distributeUsdcInstant(netPayout);
    }

    function close(bytes32 channelId, uint128 finalAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 netPayout)
    {
        netPayout = super.close(channelId, finalAmount, metadata, buyerSig);
        _distributeUsdcInstant(netPayout);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARD EPOCHS
    // ═══════════════════════════════════════════════════════════════════

    function syncRewardEpochs(uint32 maxEpochs) external nonReentrant {
        if (maxEpochs == 0) revert InvalidAmount();

        if (_syncFinalizedRewardEpochsBounded(maxEpochs) == 0) revert NothingToSync();
    }

    function syncBacklog() external view returns (uint32 finalized, uint32 synced, uint32 remaining) {
        finalized = _finalizedRewardEpoch();
        synced = syncedRewardEpoch;
        if (finalized > synced) remaining = finalized - synced;
    }

    function userPointsBacklog(address account)
        external
        view
        returns (uint32 userEpoch, uint32 synced, uint32 remaining)
    {
        userEpoch = userCurrentEpoch[account];
        synced = syncedRewardEpoch;
        if (synced > userEpoch) remaining = synced - userEpoch;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function sweepOrphanUsdc(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 balance = usdc.balanceOf(address(this));
        uint256 reserved = totalUsdcReservedForStakers;
        if (balance <= reserved) return;
        uint256 amount = balance - reserved;
        usdc.safeTransfer(recipient, amount);
        emit OrphanUsdcSwept(recipient, amount);
    }

    function setMaxTotalStake(uint256 newMaxTotalStake) external onlyOwner {
        maxTotalStake = newMaxTotalStake;
        emit MaxTotalStakeSet(newMaxTotalStake);
    }

    function setMinUnstakeBatchOpenSecs(uint64 newMinUnstakeBatchOpenSecs) external onlyOwner {
        if (newMinUnstakeBatchOpenSecs > MAX_MIN_UNSTAKE_BATCH_OPEN_SECS) revert MinUnstakeBatchOpenSecsTooLarge();
        minUnstakeBatchOpenSecs = newMinUnstakeBatchOpenSecs;
        emit MinUnstakeBatchOpenSecsSet(newMinUnstakeBatchOpenSecs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function flushableAt() external view returns (uint64) {
        uint64 openedAt = currentUnstakeBatchOpenedAt;
        if (openedAt == 0) return 0;
        return openedAt + minUnstakeBatchOpenSecs;
    }

    function earnedUsdc(address account) external view returns (uint256) {
        return usdcRewards[account]
            + (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / _RAY;
    }

    function finalizedRewardEpoch() external view returns (uint32) {
        return _finalizedRewardEpoch();
    }

    function pendingAntsForEpoch(address account, uint32 rewardEpoch) external view returns (uint256) {
        if (userEpochClaimed[account][rewardEpoch]) return 0;
        if (rewardEpoch >= syncedRewardEpoch) return 0;
        RewardEpoch memory re = rewardEpochs[rewardEpoch];
        uint256 antsPot = re.funded ? re.antsPot : _pendingRewardEpochEmissions(rewardEpoch);
        if (antsPot == 0) return 0;
        uint256 totalPoints = re.totalPoints;
        if (totalPoints == 0) return 0;

        uint256 userPts = userPoints[account][rewardEpoch];

        uint32 userEp = userCurrentEpoch[account];
        uint256 S = staked[account];
        if (S > 0 && userEp <= rewardEpoch) {
            uint256 segStart;
            if (userEp == rewardEpoch) {
                segStart = userRevenuePerTokenSnap[account];
            } else if (rewardEpoch > 0) {
                segStart = rewardEpochs[rewardEpoch - 1].revenuePerTokenAtEnd;
            }
            uint256 segEnd = re.revenuePerTokenAtEnd;
            if (segEnd > segStart) {
                userPts += (S * (segEnd - segStart)) / _RAY;
            }
        }

        if (userPts == 0) return 0;
        return (antsPot * userPts) / totalPoints;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ERC-1271
    // ═══════════════════════════════════════════════════════════════════

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError) return bytes4(0xffffffff);
        return recovered == owner() ? ERC1271_MAGIC_VALUE : bytes4(0xffffffff);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _distributeUsdcInstant(uint256 amount) internal {
        if (amount == 0 || totalStaked == 0) return;
        _syncFinalizedRewardEpochsForUpdate();

        uint256 rewardPerTokenDelta = (amount * _RAY) / totalStaked;
        if (rewardPerTokenDelta == 0) return;

        usdcRewardPerTokenStored += rewardPerTokenDelta;
        uint256 distributable = (rewardPerTokenDelta * totalStaked) / _RAY;
        currentEpochRevenuePoints += distributable;
        totalUsdcReservedForStakers += distributable;
        totalUsdcDistributedEver += distributable;
        emit UsdcDistributed(distributable);
    }

    function _updateUsdcForUser(address account) internal {
        if (account != address(0)) {
            uint256 delta = (staked[account] * (usdcRewardPerTokenStored - userUsdcRewardPerTokenPaid[account])) / _RAY;
            if (delta > 0) usdcRewards[account] += delta;
            userUsdcRewardPerTokenPaid[account] = usdcRewardPerTokenStored;
        }
    }

    function _finalizedRewardEpoch() internal view returns (uint32) {
        return _currentEmissionsEpoch().toUint32();
    }

    function _syncFinalizedRewardEpochsForUpdate() internal {
        uint32 finalized = _finalizedRewardEpoch();
        uint32 synced = syncedRewardEpoch;
        if (finalized > synced && finalized - synced > MAX_EPOCHS_PER_CAPTURE) {
            revert BacklogTooLarge();
        }
        _syncRewardEpochsUntil(finalized);
    }

    function _syncFinalizedRewardEpochsBounded(uint32 maxEpochs) internal returns (uint32 synced) {
        uint32 from = syncedRewardEpoch;
        uint32 finalized = _finalizedRewardEpoch();
        uint32 target = from + maxEpochs;
        if (target > finalized) target = finalized;
        if (target > from) {
            _syncRewardEpochsUntil(target);
            synced = target - from;
        }
    }

    function _syncRewardEpochsUntil(uint32 target) internal {
        uint32 from = syncedRewardEpoch;
        while (syncedRewardEpoch < target) {
            uint32 rewardEpoch = syncedRewardEpoch;

            RewardEpoch storage re = rewardEpochs[rewardEpoch];
            re.revenuePerTokenAtEnd = usdcRewardPerTokenStored;
            re.totalPoints = currentEpochRevenuePoints;
            currentEpochRevenuePoints = 0;

            syncedRewardEpoch = rewardEpoch + 1;
            emit RewardEpochClosed(rewardEpoch, usdcRewardPerTokenStored, re.totalPoints);
        }
        if (syncedRewardEpoch > from) emit RewardEpochsSynced(from, syncedRewardEpoch);
    }

    function _fundRewardEpoch(uint32 rewardEpoch) internal returns (uint256 antsPot) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = rewardEpoch;
        antsPot = _claimSellerEmissions(ids);

        rewardEpochs[rewardEpoch].antsPot = antsPot;
        rewardEpochs[rewardEpoch].funded = true;

        emit RewardEpochFunded(rewardEpoch, antsPot);
    }

    function _pendingRewardEpochEmissions(uint32 rewardEpoch) internal view returns (uint256 pendingSeller) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = rewardEpoch;
        pendingSeller = _pendingSellerEmissions(address(this), ids);
    }

    function _advanceUserClaimCursor(address account) internal {
        uint32 cursor = userLastClaimedEpoch[account];
        if (cursor < firstRewardEpoch) cursor = firstRewardEpoch;

        uint32 limit = syncedRewardEpoch;
        uint32 scanned;
        while (cursor < limit && userEpochClaimed[account][cursor] && scanned < MAX_EPOCHS_PER_CAPTURE) {
            cursor++;
            scanned++;
        }
        userLastClaimedEpoch[account] = cursor;
    }

    function _captureUserPoints(address account) internal {
        if (account == address(0)) return;

        uint256 S = staked[account];
        uint32 currentEp = syncedRewardEpoch;

        if (S == 0) {
            userRevenuePerTokenSnap[account] = usdcRewardPerTokenStored;
            userCurrentEpoch[account] = currentEp;
            return;
        }

        uint32 userEp = userCurrentEpoch[account];
        if (currentEp > userEp && currentEp - userEp > MAX_EPOCHS_PER_CAPTURE) {
            revert BacklogTooLarge();
        }

        uint256 userSnap = userRevenuePerTokenSnap[account];

        for (uint32 N = userEp; N < currentEp; N++) {
            uint256 segStart = N == userEp ? userSnap : rewardEpochs[N - 1].revenuePerTokenAtEnd;
            uint256 segEnd = rewardEpochs[N].revenuePerTokenAtEnd;
            _addUserPoints(account, N, S, segStart, segEnd);
        }

        uint256 openSegStart = userEp == currentEp ? userSnap : rewardEpochs[currentEp - 1].revenuePerTokenAtEnd;
        _addUserPoints(account, currentEp, S, openSegStart, usdcRewardPerTokenStored);

        userRevenuePerTokenSnap[account] = usdcRewardPerTokenStored;
        userCurrentEpoch[account] = currentEp;
    }

    function _addUserPoints(address account, uint32 epoch, uint256 S, uint256 segStart, uint256 segEnd) internal {
        if (S == 0 || segEnd <= segStart) return;
        userPoints[account][epoch] += (S * (segEnd - segStart)) / _RAY;
    }
}
