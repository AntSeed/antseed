// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
/**
 * @title AntseedDeposits
 * @notice Buyer USDC custody with credit limits and seller payouts.
 *         Stable contract — holds funds. Channel logic lives in AntseedChannels (swappable).
 */
contract AntseedDeposits is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── EIP-712 ─────────────────────────────────────────────────────────
    bytes32 public constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address operator,uint256 nonce)"
    );

    // ─── State ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedRegistry public registry;

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
        uint256 firstChannelAt;
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
    event OperatorSet(address indexed buyer, address indexed operator);


    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotAuthorized();
    error InvalidAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error BelowMinDeposit();
    error CreditLimitExceeded();
    error InvalidSignature();
    error InvalidNonce();
    error OperatorAlreadySet();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyChannels() {
        if (msg.sender != registry.channels()) revert NotAuthorized();
        _;
    }

    /// @dev Check that msg.sender is the buyer's authorized operator.
    function _isOperator(address buyer) internal view returns (bool) {
        return msg.sender == buyers[buyer].operator;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc)
        EIP712("AntseedDeposits", "1")
        Ownable(msg.sender)
    {
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
        if (ba.firstChannelAt > 0) {
            daysSinceFirst = (block.timestamp - ba.firstChannelAt) / 1 days;
        }

        uint256 limit = BASE_CREDIT_LIMIT
            + PEER_INTERACTION_BONUS * uniqueSellers
            + TIME_BONUS * daysSinceFirst;

        if (limit > MAX_CREDIT_LIMIT) limit = MAX_CREDIT_LIMIT;
        return limit;
    }

    function deposit(address buyer, uint256 amount) external nonReentrant {
        if (!_isOperator(buyer)) revert NotAuthorized();
        _deposit(buyer, amount);
    }

    /**
     * @notice Deposit USDC and set the operator in a single transaction.
     *         If the operator is already set, the signature is ignored and
     *         the call behaves like the plain deposit(). This lets the first
     *         deposit atomically authorize the operator.
     */
    function deposit(
        address buyer,
        uint256 amount,
        uint256 nonce,
        bytes calldata buyerSig
    ) external nonReentrant {
        BuyerAccount storage ba = buyers[buyer];
        if (ba.operator == address(0)) {
            _setOperator(buyer, msg.sender, nonce, buyerSig);
        }
        if (!_isOperator(buyer)) revert NotAuthorized();
        _deposit(buyer, amount);
    }

    function _deposit(address buyer, uint256 amount) internal {
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
     *         Sends funds to the operator (msg.sender).
     */
    function withdraw(address buyer, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!_isOperator(buyer)) revert NotAuthorized();
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved;
        if (available < amount) revert InsufficientBalance();

        ba.balance -= amount;
        usdc.safeTransfer(msg.sender, amount);

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
    //                   PRIVILEGED — CHANNELS ONLY
    // ═══════════════════════════════════════════════════════════════════

    function lockForChannel(address buyer, uint256 amount) external onlyChannels {
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved;
        if (available < amount) revert InsufficientBalance();
        ba.reserved += amount;
        ba.lastActivityAt = block.timestamp;
        if (ba.firstChannelAt == 0) {
            ba.firstChannelAt = block.timestamp;
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

    // ═══════════════════════════════════════════════════════════════════
    //                        OPERATOR MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set the initial operator for a buyer. Anyone can submit
     *         this tx — authorization comes from the buyer's EIP-712 signature.
     *         Can only be called when no operator is set yet.
     */
    function setOperator(
        address buyer,
        address operator,
        uint256 nonce,
        bytes calldata buyerSig
    ) external {
        _setOperator(buyer, operator, nonce, buyerSig);
    }

    function _setOperator(
        address buyer,
        address operator,
        uint256 nonce,
        bytes calldata buyerSig
    ) internal {
        if (buyer == address(0) || operator == address(0)) revert InvalidAddress();
        BuyerAccount storage ba = buyers[buyer];
        if (ba.operator != address(0)) revert OperatorAlreadySet();
        if (nonce != ba.operatorNonce) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(SET_OPERATOR_TYPEHASH, operator, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, buyerSig) != buyer) revert InvalidSignature();

        ba.operator = operator;
        ba.operatorNonce += 1;

        emit OperatorSet(buyer, operator);
    }

    /**
     * @notice Transfer operator to a new address. Only the current operator
     *         can call this — like ownership transfer. No buyer signature needed.
     */
    function transferOperator(address buyer, address newOperator) external {
        if (!_isOperator(buyer)) revert NotAuthorized();
        buyers[buyer].operator = newOperator;

        emit OperatorSet(buyer, newOperator);
    }

    // ─── Domain Separator Helper ────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
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

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
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
