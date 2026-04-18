// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IVeniceStaking} from "./interfaces/IVeniceStaking.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";

interface IAntseedEmissionsClaim {
    function claimSellerEmissions(uint256[] calldata epochs) external;
}

/**
 * @title DiemStakingProxy
 * @notice Pooled DIEM staker / Venice re-staker / AntSeed seller façade.
 *         Holders stake DIEM; the proxy re-stakes into Venice for API entitlement
 *         and acts as the on-chain seller address for AntSeed. USDC and ANTS
 *         inflow is distributed pro-rata to stakers via two Uniswap-StakingRewards
 *         streams, each notified inline in the operator's inflow-bringing tx.
 *
 *         Two-step withdraw because Venice has a 7-day unbonding delay.
 */
contract DiemStakingProxy is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //                        EIP-712
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant SELLER_DELEGATION_TYPEHASH = keccak256(
        "SellerDelegation(address peerAddress,address sellerContract,uint256 chainId,uint256 expiresAt)"
    );

    // ═══════════════════════════════════════════════════════════════════
    //                        Configurable Constants
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Venice unbonding period seconds (default 7 days; owner may sync if Venice changes it).
    uint256 public VENICE_COOLDOWN = 7 days;

    // ═══════════════════════════════════════════════════════════════════
    //                        Structs
    // ═══════════════════════════════════════════════════════════════════

    struct RewardStream {
        uint256 rewardRate;            // tokens per second during active period
        uint256 periodFinish;          // timestamp when current period ends
        uint256 lastUpdateTime;        // last timestamp rewardPerTokenStored was updated
        uint256 rewardPerTokenStored;  // accumulated reward per staked unit
        uint256 rewardsDuration;       // window over which a notifyRewardAmount is distributed
    }

    struct PendingWithdrawal {
        uint128 amount;
        uint64 unlockAt;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Immutables
    // ═══════════════════════════════════════════════════════════════════

    IERC20 public immutable diem;
    IERC20 public immutable usdc;
    IERC20 public immutable ants;
    IVeniceStaking public immutable venice;
    IAntseedChannels public immutable channels;
    address public immutable emissions;

    uint8 internal constant STREAM_USDC = 0;
    uint8 internal constant STREAM_ANTS = 1;

    // ═══════════════════════════════════════════════════════════════════
    //                        Storage
    // ═══════════════════════════════════════════════════════════════════

    address public operator;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    mapping(address => PendingWithdrawal) public pendingWithdrawal;

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
    event WithdrawRequested(address indexed user, uint256 amount, uint256 unlockAt);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 usdcAmount, uint256 antsAmount);
    event RewardNotified(uint8 indexed stream, uint256 amount, uint256 newPeriodFinish);
    event OperatorRotated(address indexed oldOperator, address indexed newOperator);
    event EmissionsClaimed(uint256 amount);
    event ForwardedReserve(bytes32 indexed channelId, address indexed buyer, uint128 maxAmount);
    event ForwardedSettle(bytes32 indexed channelId, uint128 cumulativeAmount, uint256 inflow);
    event ForwardedClose(bytes32 indexed channelId, uint128 finalAmount, uint256 inflow);
    event ForwardedTopUp(bytes32 indexed channelId, uint128 newMaxAmount);
    event RewardsDurationUpdated(uint8 indexed stream, uint256 newDuration);
    event VeniceCooldownSynced(uint256 newCooldown);

    // ═══════════════════════════════════════════════════════════════════
    //                        Custom Errors
    // ═══════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error InvalidAmount();
    error NotOperator();
    error PendingAlreadyExists();
    error NoPendingWithdrawal();
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
        address _venice,
        address _channels,
        address _emissions,
        address _operator,
        uint256 _usdcRewardsDuration,
        uint256 _antsRewardsDuration
    )
        Ownable(msg.sender)
        EIP712("DiemStakingProxy", "1")
    {
        if (_diem == address(0) || _usdc == address(0) || _ants == address(0)) revert InvalidAddress();
        if (_venice == address(0) || _channels == address(0) || _emissions == address(0)) revert InvalidAddress();
        if (_operator == address(0)) revert InvalidAddress();
        if (_usdcRewardsDuration == 0 || _antsRewardsDuration == 0) revert InvalidDuration();

        diem = IERC20(_diem);
        usdc = IERC20(_usdc);
        ants = IERC20(_ants);
        venice = IVeniceStaking(_venice);
        channels = IAntseedChannels(_channels);
        emissions = _emissions;
        operator = _operator;

        usdcStream.rewardsDuration = _usdcRewardsDuration;
        antsStream.rewardsDuration = _antsRewardsDuration;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        Modifiers
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

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

        // Re-stake into Venice
        diem.forceApprove(address(venice), amount);
        venice.stake(amount);

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Begin withdrawal. Calls Venice.unstake inline; stops reward accrual on
     *         the requested portion immediately. DIEM is claimable after VENICE_COOLDOWN.
     */
    function requestWithdraw(uint256 amount) external nonReentrant updateRewards(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (amount > staked[msg.sender]) revert InsufficientStake();
        if (pendingWithdrawal[msg.sender].amount != 0) revert PendingAlreadyExists();

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        uint64 unlockAt = uint64(block.timestamp + VENICE_COOLDOWN);
        pendingWithdrawal[msg.sender] = PendingWithdrawal({ amount: uint128(amount), unlockAt: unlockAt });

        venice.unstake(amount);

        emit WithdrawRequested(msg.sender, amount, unlockAt);
    }

    /// @notice Complete withdrawal after cooldown elapses. Transfers DIEM to caller.
    function withdraw() external nonReentrant {
        PendingWithdrawal memory pending = pendingWithdrawal[msg.sender];
        if (pending.amount == 0) revert NoPendingWithdrawal();
        if (block.timestamp < pending.unlockAt) revert StillCoolingDown();

        delete pendingWithdrawal[msg.sender];
        diem.safeTransfer(msg.sender, pending.amount);

        emit Withdrawn(msg.sender, pending.amount);
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
    //                        ANTSEED CHANNELS FAÇADE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Forwarded `AntseedChannels.reserve`. No USDC inflow at this step.
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external onlyOperator nonReentrant {
        channels.reserve(buyer, salt, maxAmount, deadline, buyerSig);
        bytes32 channelId = channels.computeChannelId(buyer, address(this), salt);
        emit ForwardedReserve(channelId, buyer, maxAmount);
    }

    /// @notice Forwarded `AntseedChannels.topUp`. topUp may settle delta — capture inflow.
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) external onlyOperator nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        channels.topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
        emit ForwardedTopUp(channelId, newMaxAmount);
    }

    /// @notice Forwarded `AntseedChannels.settle`. Captures USDC inflow and notifies the USDC stream.
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external onlyOperator nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        channels.settle(channelId, cumulativeAmount, metadata, buyerSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
        emit ForwardedSettle(channelId, cumulativeAmount, inflow);
    }

    /// @notice Forwarded `AntseedChannels.close`. Captures USDC inflow.
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external onlyOperator nonReentrant {
        uint256 beforeBal = usdc.balanceOf(address(this));
        channels.close(channelId, finalAmount, metadata, buyerSig);
        uint256 inflow = usdc.balanceOf(address(this)) - beforeBal;
        if (inflow > 0) _notifyRewardAmount(usdcStream, STREAM_USDC, inflow);
        emit ForwardedClose(channelId, finalAmount, inflow);
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

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address old = operator;
        operator = newOperator;
        emit OperatorRotated(old, newOperator);
    }

    /**
     * @notice Change the rewards duration for a stream. Only while the stream's
     *         current period has finished to avoid surprising dilution.
     * @param stream STREAM_USDC (0) or STREAM_ANTS (1).
     */
    function setRewardsDuration(uint8 stream, uint256 newDuration) external onlyOwner {
        if (newDuration == 0) revert InvalidDuration();
        RewardStream storage s = stream == STREAM_USDC ? usdcStream : antsStream;
        if (block.timestamp < s.periodFinish) revert RewardPeriodActive();
        s.rewardsDuration = newDuration;
        emit RewardsDurationUpdated(stream, newDuration);
    }

    /**
     * @notice Owner-callable updater in case Venice changes its cooldown parameter.
     *         Expects the new cooldown (seconds) to be supplied by the owner — the
     *         IVeniceStaking interface is intentionally minimal.
     */
    function syncVeniceCooldown(uint256 newCooldown) external onlyOwner {
        VENICE_COOLDOWN = newCooldown;
        emit VeniceCooldownSynced(newCooldown);
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

    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }

    function isValidDelegation(
        address peerAddress,
        address _sellerContract,
        uint256 chainId,
        uint256 expiresAt,
        bytes calldata signature
    ) external view returns (bool) {
        if (block.timestamp > expiresAt) return false;
        if (chainId != block.chainid) return false;
        if (_sellerContract != address(this)) return false;

        bytes32 structHash = keccak256(
            abi.encode(SELLER_DELEGATION_TYPEHASH, peerAddress, _sellerContract, chainId, expiresAt)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        return recovered == operator;
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
