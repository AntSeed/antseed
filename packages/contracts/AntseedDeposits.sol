// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAntseedChannels} from "./interfaces/IAntseedChannels.sol";

/**
 * @title AntseedDeposits
 * @notice Buyer USDC custody with credit limits, withdrawal timelocks, and seller earnings.
 *         Stable contract — holds funds. Session logic lives in AntseedChannels (swappable).
 */
contract AntseedDeposits is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public channelsContract;

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public MIN_BUYER_DEPOSIT = 10_000_000;
    uint256 public WITHDRAWAL_DELAY = 48 hours;
    uint256 public BASE_CREDIT_LIMIT = 50_000_000;
    uint256 public PEER_INTERACTION_BONUS = 5_000_000;
    uint256 public TIME_BONUS = 500_000;
    uint256 public MAX_CREDIT_LIMIT = 500_000_000;

    // ─── Structs ────────────────────────────────────────────────────────
    struct BuyerAccount {
        uint256 balance;
        uint256 reserved;
        uint256 withdrawalAmount;
        uint256 withdrawalRequestedAt;
        uint256 lastActivityAt;
        uint256 firstSessionAt;
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


    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error TimeoutNotReached();
    error BelowMinDeposit();
    error CreditLimitExceeded();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyChannels() {
        if (msg.sender != channelsContract) revert NotAuthorized();
        _;
    }

    /// @dev Check that msg.sender is the buyer's authorized operator (from Sessions).
    ///      The buyer (hot wallet) is a signer only — it cannot call these functions directly.
    function _isOperator(address buyer) internal view returns (bool) {
        if (channelsContract == address(0)) return false;
        return msg.sender == IAntseedChannels(channelsContract).operators(buyer);
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
            + TIME_BONUS * daysSinceFirst;

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

    function requestWithdrawal(address buyer, uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (!_isOperator(buyer)) revert NotAuthorized();
        BuyerAccount storage ba = buyers[buyer];
        if (ba.withdrawalAmount > 0) revert InvalidAmount();
        uint256 available = ba.balance - ba.reserved - ba.withdrawalAmount;
        if (available < amount) revert InsufficientBalance();

        ba.withdrawalAmount = amount;
        ba.withdrawalRequestedAt = block.timestamp;

        emit WithdrawalRequested(buyer, amount);
    }

    function executeWithdrawal(address buyer) external nonReentrant {
        if (!_isOperator(buyer)) revert NotAuthorized();
        BuyerAccount storage ba = buyers[buyer];
        if (ba.withdrawalAmount == 0) revert InvalidAmount();
        if (block.timestamp < ba.withdrawalRequestedAt + WITHDRAWAL_DELAY) revert TimeoutNotReached();

        uint256 available = ba.balance - ba.reserved;
        uint256 amount = ba.withdrawalAmount > available ? available : ba.withdrawalAmount;
        ba.withdrawalAmount = 0;
        ba.withdrawalRequestedAt = 0;
        ba.balance -= amount;

        // Always send to the buyer address — never to msg.sender
        usdc.safeTransfer(buyer, amount);

        emit WithdrawalExecuted(buyer, amount);
    }

    function cancelWithdrawal(address buyer) external {
        if (!_isOperator(buyer)) revert NotAuthorized();
        BuyerAccount storage ba = buyers[buyer];
        ba.withdrawalAmount = 0;
        ba.withdrawalRequestedAt = 0;

        emit WithdrawalCancelled(buyer);
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

    function lockForSession(address buyer, uint256 amount) external onlyChannels {
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
    ) external onlyChannels nonReentrant {
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

    function releaseLock(address buyer, uint256 amount) external onlyChannels {
        buyers[buyer].reserved -= amount;
    }

    /**
     * @notice Credit back refunded USDC to buyer's available balance.
     *         Used when Sessions refunds unspent USDC on close/withdraw.
     *         The buyer's balance and reserved were already reduced in transferToChannels.
     *         The USDC has been sent back to this contract by Sessions.
     * @param buyer      The buyer address
     * @param creditBack The USDC amount being credited back (refund from Sessions)
     */
    function creditBuyerRefund(address buyer, uint256 creditBack) external onlyChannels {
        BuyerAccount storage ba = buyers[buyer];
        ba.balance += creditBack;
        ba.lastActivityAt = block.timestamp;
    }

    /**
     * @notice Transfer USDC from this contract to Sessions contract for channel funding.
     *         Called by Sessions during reserve/topUp after lockForSession.
     *         The buyer's balance is reduced (USDC physically leaves this contract).
     *         reserved is also reduced since the lock is now enforced by Sessions.
     * @param buyer  The buyer whose balance to debit
     * @param to     The Sessions contract address
     * @param amount USDC amount to transfer
     */
    function transferToChannels(address buyer, address to, uint256 amount) external onlyChannels nonReentrant {
        BuyerAccount storage ba = buyers[buyer];
        ba.balance -= amount;
        ba.reserved -= amount;
        usdc.safeTransfer(to, amount);
    }

    /**
     * @notice Credit seller earnings. Called by Sessions after settle/close.
     * @param seller The seller address
     * @param amount The amount to credit
     */
    function creditEarnings(address seller, uint256 amount) external onlyChannels {
        sellerEarnings[seller] += amount;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setChannelsContract(address _channels) external onlyOwner {
        if (_channels == address(0)) revert InvalidAddress();
        channelsContract = _channels;
    }

    function setCreditLimitOverride(address buyer, uint256 limit) external onlyOwner {
        creditLimitOverride[buyer] = limit;
    }

    function setMinBuyerDeposit(uint256 value) external onlyOwner {
        MIN_BUYER_DEPOSIT = value;
    }

    function setWithdrawalDelay(uint256 value) external onlyOwner {
        if (value < 1 hours) revert InvalidAmount();
        WITHDRAWAL_DELAY = value;
    }


    function setBaseCreditLimit(uint256 value) external onlyOwner {
        BASE_CREDIT_LIMIT = value;
    }

    function setPeerInteractionBonus(uint256 value) external onlyOwner {
        PEER_INTERACTION_BONUS = value;
    }

    function setTimeBonus(uint256 value) external onlyOwner {
        TIME_BONUS = value;
    }

    function setMaxCreditLimit(uint256 value) external onlyOwner {
        MAX_CREDIT_LIMIT = value;
    }
}
