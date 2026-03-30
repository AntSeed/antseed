// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC8004Registry} from "./interfaces/IERC8004Registry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";

/**
 * @title AntseedStaking
 * @notice Seller staking, active session tracking, and slashing.
 *         Stable contract — holds seller stake USDC. Reads stats from AntseedStats.
 *         Binds each seller's stake to their ERC-8004 agentId.
 */
contract AntseedStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IERC8004Registry public identityRegistry;
    IAntseedStats public statsContract;
    address public sessionsContract;
    address public protocolReserve;

    // ─── Structs ────────────────────────────────────────────────────────
    struct SellerAccount {
        uint256 stake;
        uint256 stakedAt;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public activeSessionCount;
    mapping(address => uint256) public sellerAgentId;

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_SELLER_STAKE = 10_000_000;
    uint256 public REPUTATION_CAP_COEFFICIENT = 20;
    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;
    uint256 public SLASH_INACTIVITY_DAYS = 30 days;

    // ─── Events ─────────────────────────────────────────────────────────
    event Staked(address indexed seller, uint256 indexed agentId, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientStake();
    error ActiveSessions();
    error NotAgentOwner();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlySessions() {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc, address _identityRegistry, address _stats) Ownable(msg.sender) {
        if (_usdc == address(0) || _identityRegistry == address(0) || _stats == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        identityRegistry = IERC8004Registry(_identityRegistry);
        statsContract = IAntseedStats(_stats);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        SellerAccount storage sa = sellers[msg.sender];
        sa.stake += amount;
        sa.stakedAt = block.timestamp;
        sellerAgentId[msg.sender] = agentId;

        emit Staked(msg.sender, agentId, amount);
    }

    function stakeFor(address seller, uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (identityRegistry.ownerOf(agentId) != seller) revert NotAgentOwner();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        SellerAccount storage sa = sellers[seller];
        sa.stake += amount;
        sa.stakedAt = block.timestamp;
        sellerAgentId[seller] = agentId;

        emit Staked(seller, agentId, amount);
    }

    function unstake() external nonReentrant {
        SellerAccount storage sa = sellers[msg.sender];
        if (sa.stake == 0) revert InsufficientStake();
        if (activeSessionCount[msg.sender] > 0) revert ActiveSessions();

        uint256 slashAmount = _calculateSlash(msg.sender);
        uint256 payout = sa.stake - slashAmount;

        uint256 stakeAmount = sa.stake;
        sa.stake = 0;
        sa.stakedAt = 0;
        sellerAgentId[msg.sender] = 0;

        if (payout > 0) {
            usdc.safeTransfer(msg.sender, payout);
        }
        if (slashAmount > 0 && protocolReserve != address(0)) {
            usdc.safeTransfer(protocolReserve, slashAmount);
        }

        emit Unstaked(msg.sender, stakeAmount, slashAmount);
    }

    // ─── View Helpers ───────────────────────────────────────────────────
    function validateSeller(address seller) external view returns (bool) {
        return sellers[seller].stake >= MIN_SELLER_STAKE;
    }

    function getStake(address seller) external view returns (uint256) {
        return sellers[seller].stake;
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return sellers[seller].stake >= MIN_SELLER_STAKE;
    }

    function getSellerAccount(address seller)
        external
        view
        returns (uint256 stakeAmt, uint256 stakedAt)
    {
        SellerAccount storage sa = sellers[seller];
        return (sa.stake, sa.stakedAt);
    }

    function getAgentId(address seller) external view returns (uint256) {
        return sellerAgentId[seller];
    }

    function effectiveSettlements(address seller) external view returns (uint256) {
        uint256 agentId = sellerAgentId[seller];
        if (agentId == 0) return 0;
        IAntseedStats.AgentStats memory stats = statsContract.getStats(agentId);

        uint256 sessionCount = uint256(stats.sessionCount);
        uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;

        return sessionCount < stakeCap ? sessionCount : stakeCap;
    }

    // ─── Privileged — Sessions Only ─────────────────────────────────────
    function incrementActiveSessions(address seller) external onlySessions {
        activeSessionCount[seller]++;
    }

    function decrementActiveSessions(address seller) external onlySessions {
        if (activeSessionCount[seller] == 0) revert InvalidAmount();
        activeSessionCount[seller]--;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL — SLASHING
    // ═══════════════════════════════════════════════════════════════════

    function _calculateSlash(address seller) internal view returns (uint256) {
        uint256 agentId = sellerAgentId[seller];
        if (agentId == 0) return 0;
        IAntseedStats.AgentStats memory stats = statsContract.getStats(agentId);

        uint256 sessions = uint256(stats.sessionCount);
        uint256 ghosts = uint256(stats.ghostCount);
        uint256 stakeAmt = sellers[seller].stake;

        // Tier 1: ghosts >= threshold AND zero sessions → full slash
        if (ghosts >= SLASH_GHOST_THRESHOLD && sessions == 0) return stakeAmt;

        // Tier 2: sessions > 0 but ghost ratio high → half slash
        if (sessions > 0 && ghosts > 0) {
            uint256 ghostRatio = (ghosts * 100) / (sessions + ghosts);
            if (ghostRatio >= SLASH_RATIO_THRESHOLD) return stakeAmt / 2;
        }

        // Tier 3: sessions > 0 but inactive → 20% slash
        if (sessions > 0 && stats.lastSettledAt > 0) {
            if (block.timestamp > uint256(stats.lastSettledAt) + SLASH_INACTIVITY_DAYS) {
                return stakeAmt / 5;
            }
        }

        // Tier 4: no slash
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
    }

    function setIdentityRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        identityRegistry = IERC8004Registry(_registry);
    }

    function setStatsContract(address _stats) external onlyOwner {
        if (_stats == address(0)) revert InvalidAddress();
        statsContract = IAntseedStats(_stats);
    }

    function setProtocolReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidAddress();
        protocolReserve = _reserve;
    }

    function setMinSellerStake(uint256 value) external onlyOwner {
        MIN_SELLER_STAKE = value;
    }

    function setReputationCapCoefficient(uint256 value) external onlyOwner {
        REPUTATION_CAP_COEFFICIENT = value;
    }

    function setSlashRatioThreshold(uint256 value) external onlyOwner {
        SLASH_RATIO_THRESHOLD = value;
    }

    function setSlashGhostThreshold(uint256 value) external onlyOwner {
        SLASH_GHOST_THRESHOLD = value;
    }

    function setSlashInactivityDays(uint256 value) external onlyOwner {
        if (value < 1 days) revert InvalidAmount();
        SLASH_INACTIVITY_DAYS = value;
    }
}
