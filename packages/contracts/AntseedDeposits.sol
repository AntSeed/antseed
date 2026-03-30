// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
    uint256 public BASE_CREDIT_LIMIT = 50_000_000;
    uint256 public PEER_INTERACTION_BONUS = 5_000_000;
    uint256 public TIME_BONUS = 500_000;
    uint256 public MAX_CREDIT_LIMIT = 500_000_000;

    // ─── Structs ────────────────────────────────────────────────────────
    struct BuyerAccount {
        uint256 balance;
        uint256 reserved;
        uint256 lastActivityAt;
        uint256 firstSessionAt;
        address operator;
        uint256 operatorNonce;
    }

    // ─── Storage ────────────────────────────────────────────────────────
    mapping(address => BuyerAccount) public buyers;
    mapping(address => uint256) public creditLimitOverride;
    mapping(address => uint256) public uniqueSellersCharged;
    mapping(address => mapping(address => bool)) private _buyerSellerPairs;
    mapping(address => uint256) public sellerPayouts;

    // ─── Events ─────────────────────────────────────────────────────────
    event Deposited(address indexed buyer, uint256 amount);
    event WithdrawalExecuted(address indexed buyer, uint256 amount);
    event PayoutClaimed(address indexed seller, uint256 amount);


    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error BelowMinDeposit();
    error CreditLimitExceeded();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyChannels() {
        if (msg.sender != channelsContract) revert NotAuthorized();
        _;
    }

    /// @dev Check that msg.sender is the buyer's authorized operator.
    function _isOperator(address buyer) internal view returns (bool) {
        return msg.sender == buyers[buyer].operator;
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

    /**
     * @notice Withdraw available USDC immediately. Operator-only.
     *         Sends funds to the buyer address, never to msg.sender.
     */
    function withdraw(address buyer, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!_isOperator(buyer)) revert NotAuthorized();
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved;
        if (available < amount) revert InsufficientBalance();

        ba.balance -= amount;
        usdc.safeTransfer(buyer, amount);

        emit WithdrawalExecuted(buyer, amount);
    }

    function getBuyerBalance(address buyer)
        external
        view
        returns (uint256 available, uint256 reserved, uint256 lastActivity)
    {
        BuyerAccount storage ba = buyers[buyer];
        available = ba.balance > ba.reserved ? ba.balance - ba.reserved : 0;
        reserved = ba.reserved;
        lastActivity = ba.lastActivityAt;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SELLER PAYOUTS
    // ═══════════════════════════════════════════════════════════════════

    function claimPayouts() external nonReentrant {
        uint256 amount = sellerPayouts[msg.sender];
        if (amount == 0) revert InvalidAmount();

        sellerPayouts[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);

        emit PayoutClaimed(msg.sender, amount);
    }

    function getSellerPayouts(address seller) external view returns (uint256) {
        return sellerPayouts[seller];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PRIVILEGED — SESSIONS ONLY
    // ═══════════════════════════════════════════════════════════════════

    function lockForSession(address buyer, uint256 amount) external onlyChannels {
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved;
        if (available < amount) revert InsufficientBalance();
        ba.reserved += amount;
        ba.lastActivityAt = block.timestamp;
        if (ba.firstSessionAt == 0) {
            ba.firstSessionAt = block.timestamp;
        }
    }

    function chargeAndCreditPayouts(
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
        sellerPayouts[seller] += sellerPayout;

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

    /// @notice Set operator for a buyer. Called by Channels after EIP-712 signature verification.
    function setOperatorFor(address buyer, address operator) external onlyChannels {
        BuyerAccount storage ba = buyers[buyer];
        ba.operator = operator;
        ba.operatorNonce += 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OPERATOR VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getOperator(address buyer) external view returns (address) {
        return buyers[buyer].operator;
    }

    function getOperatorNonce(address buyer) external view returns (uint256) {
        return buyers[buyer].operatorNonce;
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
