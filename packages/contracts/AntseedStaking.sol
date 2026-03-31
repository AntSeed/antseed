// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IERC8004Registry} from "./interfaces/IERC8004Registry.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";

/**
 * @title AntseedStaking
 * @notice Seller staking and slashing.
 *         Stable contract — holds seller stake USDC. Reads stats from AntseedStats.
 *         Binds each seller's stake to their ERC-8004 agentId.
 */
contract AntseedStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedRegistry public registry;

    // ─── Structs ────────────────────────────────────────────────────────
    struct SellerAccount {
        uint256 stake;
        uint256 stakedAt;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public sellerAgentId;

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_SELLER_STAKE = 10_000_000;
    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;
    uint256 public SLASH_INACTIVITY_DAYS = 30 days;

    // ─── Events ─────────────────────────────────────────────────────────
    event Staked(address indexed seller, uint256 indexed agentId, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientStake();
    error ActiveChannels();
    error NotAgentOwner();
    error AgentIdMismatch();

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc, address _registry) Ownable(msg.sender) {
        if (_usdc == address(0) || _registry == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        registry = IAntseedRegistry(_registry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        _stakeFor(msg.sender, agentId, amount);
    }

    function stakeFor(address seller, uint256 agentId, uint256 amount) external nonReentrant {
        _stakeFor(seller, agentId, amount);
    }

    function _stakeFor(address seller, uint256 agentId, uint256 amount) internal {
        if (seller == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) != seller) revert NotAgentOwner();
        uint256 existingAgentId = sellerAgentId[seller];
        if (existingAgentId != 0 && existingAgentId != agentId) revert AgentIdMismatch();

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
        if (IAntseedChannels(registry.channels()).activeChannelCount(msg.sender) > 0) revert ActiveChannels();

        uint256 slashAmount = _calculateSlash(msg.sender);
        uint256 payout = sa.stake - slashAmount;

        uint256 stakeAmount = sa.stake;
        sa.stake = 0;
        sa.stakedAt = 0;
        sellerAgentId[msg.sender] = 0;

        if (payout > 0) {
            usdc.safeTransfer(msg.sender, payout);
        }
        if (slashAmount > 0) {
            address _protocolReserve = registry.protocolReserve();
            if (_protocolReserve == address(0)) revert InvalidAddress();
            usdc.safeTransfer(_protocolReserve, slashAmount);
        }

        emit Unstaked(msg.sender, stakeAmount, slashAmount);
    }

    // ─── View Helpers ───────────────────────────────────────────────────
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

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL — SLASHING
    // ═══════════════════════════════════════════════════════════════════

    function _calculateSlash(address seller) internal view returns (uint256) {
        uint256 agentId = sellerAgentId[seller];
        if (agentId == 0) return 0;
        IAntseedChannels.AgentStats memory stats = IAntseedChannels(registry.channels()).getAgentStats(agentId);

        uint256 channels = uint256(stats.channelCount);
        uint256 ghosts = uint256(stats.ghostCount);
        uint256 stakeAmt = sellers[seller].stake;

        // Tier 1: ghosts >= threshold AND zero channels → full slash
        if (ghosts >= SLASH_GHOST_THRESHOLD && channels == 0) return stakeAmt;

        // Tier 2: channels > 0 but ghost ratio high → half slash
        if (channels > 0 && ghosts > 0) {
            uint256 ghostRatio = (ghosts * 100) / (channels + ghosts);
            if (ghostRatio >= SLASH_RATIO_THRESHOLD) return stakeAmt / 2;
        }

        // Tier 3: channels > 0 but inactive → 20% slash
        if (channels > 0 && stats.lastSettledAt > 0) {
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

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setMinSellerStake(uint256 value) external onlyOwner {
        MIN_SELLER_STAKE = value;
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
