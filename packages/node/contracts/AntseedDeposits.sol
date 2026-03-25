// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AntseedDeposits
 * @notice Buyer USDC custody with credit limits, withdrawal timelocks, and seller earnings.
 *         Stable contract — holds funds. Session logic lives in AntseedSessions (swappable).
 */
contract AntseedDeposits is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public sessionsContract;

    // ─── Constant Keys ───────────────────────────────────────────────────
    bytes32 private constant KEY_MIN_BUYER_DEPOSIT = keccak256("MIN_BUYER_DEPOSIT");
    bytes32 private constant KEY_WITHDRAWAL_DELAY = keccak256("WITHDRAWAL_DELAY");
    bytes32 private constant KEY_BUYER_INACTIVITY_PERIOD = keccak256("BUYER_INACTIVITY_PERIOD");
    bytes32 private constant KEY_BASE_CREDIT_LIMIT = keccak256("BASE_CREDIT_LIMIT");
    bytes32 private constant KEY_PEER_INTERACTION_BONUS = keccak256("PEER_INTERACTION_BONUS");
    bytes32 private constant KEY_TIME_BONUS = keccak256("TIME_BONUS");
    bytes32 private constant KEY_FEEDBACK_BONUS = keccak256("FEEDBACK_BONUS");
    bytes32 private constant KEY_MAX_CREDIT_LIMIT = keccak256("MAX_CREDIT_LIMIT");

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_BUYER_DEPOSIT = 10_000_000;
    uint256 public WITHDRAWAL_DELAY = 48 hours;
    uint256 public BUYER_INACTIVITY_PERIOD = 90 days;
    uint256 public BASE_CREDIT_LIMIT = 50_000_000;
    uint256 public PEER_INTERACTION_BONUS = 5_000_000;
    uint256 public TIME_BONUS = 500_000;
    uint256 public FEEDBACK_BONUS = 2_000_000;
    uint256 public MAX_CREDIT_LIMIT = 500_000_000;

    // ─── Structs ────────────────────────────────────────────────────────
    struct BuyerAccount {
        uint256 balance;
        uint256 reserved;
        uint256 withdrawalAmount;
        uint256 withdrawalRequestedAt;
        uint256 lastActivityAt;
        uint256 firstSessionAt;
        uint256 feedbackCount;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => BuyerAccount) public buyers;
    mapping(address => uint256) public creditLimitOverride;
    mapping(address => uint256) public uniqueSellersCharged;
    mapping(address => mapping(address => bool)) private _buyerSellerPairs;
    mapping(address => uint256) public sellerEarnings;

    // ─── Events ─────────────────────────────────────────────────────────
    event Deposited(address indexed buyer, uint256 amount);
    event WithdrawalRequested(address indexed buyer, uint256 amount);
    event WithdrawalExecuted(address indexed buyer, uint256 amount);
    event WithdrawalCancelled(address indexed buyer);
    event EarningsClaimed(address indexed seller, uint256 amount);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error TimeoutNotReached();
    error BelowMinDeposit();
    error CreditLimitExceeded();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlySessions() {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        BUYER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    function getBuyerCreditLimit(address buyer) public view returns (uint256) {
        if (creditLimitOverride[buyer] > 0) return creditLimitOverride[buyer];

        BuyerAccount storage ba = buyers[buyer];
        uint256 uniqueSellers = uniqueSellersCharged[buyer];
        uint256 daysSinceFirst = 0;
        if (ba.firstSessionAt > 0) {
            daysSinceFirst = (block.timestamp - ba.firstSessionAt) / 1 days;
        }

        uint256 limit = BASE_CREDIT_LIMIT
            + PEER_INTERACTION_BONUS * uniqueSellers
            + TIME_BONUS * daysSinceFirst
            + FEEDBACK_BONUS * ba.feedbackCount;

        if (limit > MAX_CREDIT_LIMIT) limit = MAX_CREDIT_LIMIT;
        return limit;
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        BuyerAccount storage ba = buyers[msg.sender];
        if (ba.balance == 0 && amount < MIN_BUYER_DEPOSIT) revert BelowMinDeposit();

        uint256 creditLimit = getBuyerCreditLimit(msg.sender);
        if (ba.balance + amount > creditLimit) revert CreditLimitExceeded();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        ba.balance += amount;
        ba.lastActivityAt = block.timestamp;

        emit Deposited(msg.sender, amount);
    }

    function depositFor(address buyer, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        BuyerAccount storage ba = buyers[buyer];
        if (ba.balance == 0 && amount < MIN_BUYER_DEPOSIT) revert BelowMinDeposit();
        if (ba.balance + amount > getBuyerCreditLimit(buyer)) revert CreditLimitExceeded();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        ba.balance += amount;
        ba.lastActivityAt = block.timestamp;

        emit Deposited(buyer, amount);
    }

    function requestWithdrawal(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        BuyerAccount storage ba = buyers[msg.sender];
        if (ba.withdrawalAmount > 0) revert InvalidAmount();
        uint256 available = ba.balance - ba.reserved - ba.withdrawalAmount;
        if (available < amount) revert InsufficientBalance();

        ba.withdrawalAmount = amount;
        ba.withdrawalRequestedAt = block.timestamp;

        emit WithdrawalRequested(msg.sender, amount);
    }

    function executeWithdrawal() external nonReentrant {
        BuyerAccount storage ba = buyers[msg.sender];
        if (ba.withdrawalAmount == 0) revert InvalidAmount();
        if (block.timestamp < ba.withdrawalRequestedAt + WITHDRAWAL_DELAY) revert TimeoutNotReached();

        uint256 available = ba.balance - ba.reserved;
        uint256 amount = ba.withdrawalAmount > available ? available : ba.withdrawalAmount;
        ba.withdrawalAmount = 0;
        ba.withdrawalRequestedAt = 0;
        ba.balance -= amount;

        usdc.safeTransfer(msg.sender, amount);

        emit WithdrawalExecuted(msg.sender, amount);
    }

    function cancelWithdrawal() external {
        BuyerAccount storage ba = buyers[msg.sender];
        ba.withdrawalAmount = 0;
        ba.withdrawalRequestedAt = 0;

        emit WithdrawalCancelled(msg.sender);
    }

    function getBuyerBalance(address buyer)
        external
        view
        returns (uint256 available, uint256 reserved, uint256 pendingWithdrawal, uint256 lastActivity)
    {
        BuyerAccount storage ba = buyers[buyer];
        uint256 locked = ba.reserved + ba.withdrawalAmount;
        available = ba.balance > locked ? ba.balance - locked : 0;
        reserved = ba.reserved;
        pendingWithdrawal = ba.withdrawalAmount;
        lastActivity = ba.lastActivityAt;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER EARNINGS
    // ═══════════════════════════════════════════════════════════════════

    function claimEarnings() external nonReentrant {
        uint256 amount = sellerEarnings[msg.sender];
        if (amount == 0) revert InvalidAmount();

        sellerEarnings[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);

        emit EarningsClaimed(msg.sender, amount);
    }

    function getSellerEarnings(address seller) external view returns (uint256) {
        return sellerEarnings[seller];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PRIVILEGED — SESSIONS ONLY
    // ═══════════════════════════════════════════════════════════════════

    function lockForSession(address buyer, uint256 amount) external onlySessions {
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved - ba.withdrawalAmount;
        if (available < amount) revert InsufficientBalance();
        ba.reserved += amount;
        ba.lastActivityAt = block.timestamp;
        if (ba.firstSessionAt == 0) {
            ba.firstSessionAt = block.timestamp;
        }
    }

    function chargeAndCreditEarnings(
        address buyer,
        address seller,
        uint256 chargeAmount,
        uint256 reservedAmount,
        uint256 platformFee,
        address protocolReserve
    ) external onlySessions nonReentrant {
        if (chargeAmount > reservedAmount) revert InvalidAmount();
        if (platformFee > chargeAmount) revert InvalidAmount();

        BuyerAccount storage ba = buyers[buyer];
        ba.balance -= chargeAmount;
        ba.reserved -= reservedAmount;
        ba.lastActivityAt = block.timestamp;

        uint256 sellerPayout = chargeAmount - platformFee;
        sellerEarnings[seller] += sellerPayout;

        // Track buyer-seller diversity for credit limit calculation
        if (!_buyerSellerPairs[buyer][seller]) {
            _buyerSellerPairs[buyer][seller] = true;
            uniqueSellersCharged[buyer]++;
        }

        if (platformFee > 0 && protocolReserve != address(0)) {
            usdc.safeTransfer(protocolReserve, platformFee);
        }
    }

    function releaseLock(address buyer, uint256 amount) external onlySessions {
        buyers[buyer].reserved -= amount;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
    }

    function setCreditLimitOverride(address buyer, uint256 limit) external onlyOwner {
        creditLimitOverride[buyer] = limit;
    }

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == KEY_MIN_BUYER_DEPOSIT) MIN_BUYER_DEPOSIT = value;
        else if (key == KEY_WITHDRAWAL_DELAY) {
            if (value < 1 hours) revert InvalidAmount();
            WITHDRAWAL_DELAY = value;
        }
        else if (key == KEY_BUYER_INACTIVITY_PERIOD) {
            if (value < 1 days) revert InvalidAmount();
            BUYER_INACTIVITY_PERIOD = value;
        }
        else if (key == KEY_BASE_CREDIT_LIMIT) BASE_CREDIT_LIMIT = value;
        else if (key == KEY_PEER_INTERACTION_BONUS) PEER_INTERACTION_BONUS = value;
        else if (key == KEY_TIME_BONUS) TIME_BONUS = value;
        else if (key == KEY_FEEDBACK_BONUS) FEEDBACK_BONUS = value;
        else if (key == KEY_MAX_CREDIT_LIMIT) MAX_CREDIT_LIMIT = value;
        else revert InvalidAmount();

        emit ConstantUpdated(key, value);
    }
}
