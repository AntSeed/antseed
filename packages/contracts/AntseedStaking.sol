// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IERC8004Registry} from "./interfaces/IERC8004Registry.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";
import {IAntseedSlashing} from "./interfaces/IAntseedSlashing.sol";

/**
 * @title AntseedStaking
 * @notice Seller staking and slashing.
 *         Stable contract — holds seller stake USDC. Reads stats from AntseedChannels.
 *         Binds each seller's stake to their ERC-8004 agentId.
 */
contract AntseedStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedRegistry public registry;
    IAntseedSlashing public slashing;

    // ─── Structs ────────────────────────────────────────────────────────
    struct SellerAccount {
        uint256 stake;
        uint256 stakedAt;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public sellerAgentId;
    mapping(uint256 => address) public agentSeller;

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_SELLER_STAKE = 10_000_000;

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
    error AgentAlreadyBound();

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
        address existingSeller = agentSeller[agentId];
        if (existingSeller != address(0) && existingSeller != seller) revert AgentAlreadyBound();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        SellerAccount storage sa = sellers[seller];
        if (sa.stakedAt == 0) {
            sa.stakedAt = block.timestamp;
        }
        sa.stake += amount;
        sellerAgentId[seller] = agentId;
        agentSeller[agentId] = seller;

        emit Staked(seller, agentId, amount);
    }

    function unstake() external nonReentrant {
        SellerAccount storage sa = sellers[msg.sender];
        if (sa.stake == 0) revert InsufficientStake();
        if (IAntseedChannels(registry.channels()).activeChannelCount(msg.sender) > 0) revert ActiveChannels();

        uint256 slashAmount = 0;
        if (address(slashing) != address(0)) {
            slashAmount = slashing.calculateSlash(msg.sender, sa.stake);
        }
        uint256 payout = sa.stake - slashAmount;

        uint256 stakeAmount = sa.stake;
        uint256 agentId = sellerAgentId[msg.sender];
        sa.stake = 0;
        sellerAgentId[msg.sender] = 0;
        agentSeller[agentId] = address(0);

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

    function getAgentId(address seller) external view returns (uint256) {
        return sellerAgentId[seller];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setSlashing(address _slashing) external onlyOwner {
        slashing = IAntseedSlashing(_slashing);
    }

    function setMinSellerStake(uint256 value) external onlyOwner {
        MIN_SELLER_STAKE = value;
    }
}
