// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─── Minimal ERC-20 interface ────────────────────────────────────────────────

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @title  AntseedEscrow
 * @notice Pull-payment escrow for the Antseed P2P AI services marketplace.
 *
 * @dev Design summary
 *   - Buyers pre-deposit USDC. To withdraw they must wait a 1-hour timelock.
 *   - To start a session the buyer signs an EIP-712 SpendingAuth off-chain and
 *     sends it to the seller via P2P. The seller calls charge() at any time to
 *     pull funds up to the signed cap.
 *   - When approaching the cap the seller sends a TopUpRequest; buyer responds
 *     with a new SpendingAuth (nonce+1). The contract advances the nonce and
 *     resets the usage counter.
 *   - Sellers stake USDC to unlock the ability to call charge() and to boost
 *     their reputation score. Stake has a 7-day lock-up period.
 *   - Buyers who meet eligibility requirements can rate sellers 0-100. The
 *     composite reputation score is computed off-chain from the on-chain
 *     ReputationData struct.
 * @dev All reverts use custom errors (no require-with-string).
 */
contract AntseedEscrow {

    // ── Custom errors ────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error Paused();
    error Reentrancy();
    error TransferFailed();
    error NotOwner();
    error FeeTooHigh(uint16 bps, uint16 max);

    // Withdrawal
    error WithdrawalNotRequested();
    error WithdrawalTimelockActive(uint256 readyAt);

    // Auth / charge
    error AuthExpired(uint256 deadline, uint256 current);
    error AuthInvalidSig();
    error AuthNonceMismatch(uint256 stored, uint256 provided);
    error AuthCapMismatch(uint256 stored, uint256 provided);
    error AuthCapExceeded(uint256 used, uint256 amount, uint256 cap);
    error InsufficientStake(uint256 have, uint256 required);

    // Balance
    error InsufficientBalance(uint256 have, uint256 need);

    // Stake
    error StakeLocked(uint256 unlocksAt);
    error InsufficientStakedAmount(uint256 have, uint256 need);

    // Rating
    error RatingOutOfRange(uint8 score);
    error RatingAccountTooNew(uint256 unlocksAt);
    error RatingNeedMoreSellers(uint256 have, uint256 required);
    error RatingNoInteraction();
    error RatingInsufficientSpend(uint256 have, uint256 required);
    error RatingCooldownActive(uint256 readyAt);

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant WITHDRAWAL_TIMELOCK  = 1 hours;
    uint256 public constant STAKE_LOCK_PERIOD    = 7 days;
    uint256 public constant MIN_SELLER_STAKE     = 10_000_000;   // 10 USDC (6 dec)
    uint256 public constant RATING_COOLDOWN      = 10 days;
    uint256 public constant BUYER_AGE_REQUIREMENT = 10 days;
    uint256 public constant MIN_UNIQUE_SELLERS   = 3;
    uint256 public constant MIN_VOTE_SPEND       = 1_000_000;    // 1 USDC (6 dec)
    uint16  public constant MAX_PLATFORM_FEE_BPS = 1_000;        // 10 %

    // EIP-712
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 maxAmount,uint256 nonce,uint256 deadline)"
    );

    // ── State variables ──────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;

    address public owner;
    address public feeCollector;
    uint16  public platformFeeBps;  // e.g. 200 = 2 %
    bool    public paused;
    uint256 public accumulatedFees;

    // ── Storage structs ──────────────────────────────────────────────────────

    struct BuyerAccount {
        uint256 balance;
        uint256 withdrawalAmount;
        uint256 withdrawalRequestedAt;
        uint256 firstTransactionAt;
        uint256 uniqueSellersCount;
    }

    struct SellerAccount {
        uint256 pendingEarnings;
        uint256 stakedAmount;
        uint256 stakedSince;
        uint256 firstTransactionAt;
        uint256 totalTransactions;
        uint256 totalVolume;          // all-time USDC charged (6 dec)
        uint256 uniqueBuyersCount;
    }

    struct SessionAuth {
        uint256 nonce;      // current auth nonce (0 = no auth yet)
        uint256 authMax;    // cap for current nonce
        uint256 authUsed;   // cumulative charges in current nonce
        uint256 deadline;   // expiry of current nonce
    }

    struct ReputationData {
        uint256 avgRating;          // 0-100 (0 if no ratings)
        uint256 ratingCount;
        uint256 stakedAmount;
        uint256 totalTransactions;
        uint256 totalVolume;
        uint256 uniqueBuyersServed;
        uint256 ageDays;
    }

    // ── Mappings ─────────────────────────────────────────────────────────────

    mapping(address => BuyerAccount)  public buyers;
    mapping(address => SellerAccount) public sellers;

    // buyer => seller => sessionId => SessionAuth
    mapping(address => mapping(address => mapping(bytes32 => SessionAuth))) private _sessionAuths;

    // Reputation aggregates
    mapping(address => uint256) private _ratingSum;    // sum of all ratings for a seller
    mapping(address => uint256) private _ratingCount;

    // Per (buyer, seller) state
    mapping(address => mapping(address => bool))    public hasInteracted;
    mapping(address => mapping(address => uint256)) public buyerSpendWithSeller;
    mapping(address => mapping(address => uint8))   private _lastRating;
    mapping(address => mapping(address => bool))    private _hasRated;
    mapping(address => mapping(address => uint256)) private _lastRatedAt;

    // Reentrancy guard
    bool private _locked;

    // ── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed buyer, uint256 amount);
    event WithdrawalRequested(address indexed buyer, uint256 amount, uint256 readyAt);
    event WithdrawalExecuted(address indexed buyer, uint256 amount);
    event WithdrawalCancelled(address indexed buyer, uint256 amount);

    event Charged(
        address indexed buyer,
        address indexed seller,
        bytes32 indexed sessionId,
        uint256 amount,
        uint256 fee
    );
    event EarningsClaimed(address indexed seller, uint256 amount);
    event FeeSwept(address indexed collector, uint256 amount);

    event Staked(address indexed seller, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount);

    event SellerRated(address indexed buyer, address indexed seller, uint8 score);

    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event OwnershipTransferred(address indexed prev, address indexed next);
    event FeeCollectorUpdated(address indexed prev, address indexed next);
    event PlatformFeeUpdated(uint16 prev, uint16 next);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address usdcToken,
        address initialFeeCollector,
        uint16  initialFeeBps
    ) {
        if (usdcToken           == address(0)) revert ZeroAddress();
        if (initialFeeCollector == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh(initialFeeBps, MAX_PLATFORM_FEE_BPS);

        usdc         = IERC20(usdcToken);
        owner        = msg.sender;
        feeCollector = initialFeeCollector;
        platformFeeBps = initialFeeBps;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("AntseedEscrow"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ── Owner admin ──────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert ZeroAddress();
        emit FeeCollectorUpdated(feeCollector, newCollector);
        feeCollector = newCollector;
    }

    function setPlatformFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_PLATFORM_FEE_BPS);
        emit PlatformFeeUpdated(platformFeeBps, newFeeBps);
        platformFeeBps = newFeeBps;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ── Buyer: deposit / withdraw ────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the escrow. Requires prior ERC-20 approval.
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        buyers[msg.sender].balance += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Begin the withdrawal timelock. Reserves `amount` without reducing
     *         the chargeable balance — sellers can still call charge() during the
     *         timelock window. The reservation is best-effort and can be reduced
     *         by subsequent charges before executeWithdrawal() runs.
     */
    function requestWithdrawal(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        BuyerAccount storage b = buyers[msg.sender];
        uint256 available = b.balance > b.withdrawalAmount
            ? b.balance - b.withdrawalAmount
            : 0;
        if (available < amount) revert InsufficientBalance(available, amount);
        b.withdrawalAmount      += amount;
        b.withdrawalRequestedAt  = block.timestamp;
        emit WithdrawalRequested(msg.sender, amount, block.timestamp + WITHDRAWAL_TIMELOCK);
    }

    /**
     * @notice Execute a pending withdrawal after the timelock has elapsed.
     *         Transfers up to the reserved amount from the buyer's current balance.
     */
    function executeWithdrawal() external nonReentrant {
        BuyerAccount storage b = buyers[msg.sender];
        if (b.withdrawalAmount == 0) revert WithdrawalNotRequested();
        uint256 readyAt = b.withdrawalRequestedAt + WITHDRAWAL_TIMELOCK;
        if (block.timestamp < readyAt) revert WithdrawalTimelockActive(readyAt);
        uint256 requested = b.withdrawalAmount;
        uint256 amount = requested <= b.balance ? requested : b.balance;
        b.withdrawalAmount      = 0;
        b.withdrawalRequestedAt = 0;
        if (amount > 0) {
            b.balance -= amount;
            _safeTransfer(msg.sender, amount);
        }
        emit WithdrawalExecuted(msg.sender, amount);
    }

    /**
     * @notice Cancel a pending withdrawal and release the reservation.
     */
    function cancelWithdrawal() external {
        BuyerAccount storage b = buyers[msg.sender];
        if (b.withdrawalAmount == 0) revert WithdrawalNotRequested();
        uint256 amount          = b.withdrawalAmount;
        b.withdrawalAmount      = 0;
        b.withdrawalRequestedAt = 0;
        emit WithdrawalCancelled(msg.sender, amount);
    }

    // ── Seller: charge ───────────────────────────────────────────────────────

    /**
     * @notice Pull payment from a buyer using a valid EIP-712 SpendingAuth.
     *
     * @param buyer      The buyer's wallet address.
     * @param amount     USDC amount to charge (6 decimals).
     * @param sessionId  32-byte session identifier (buyer-generated).
     * @param maxAmount  Cap declared in the signed authorization.
     * @param nonce      Auth nonce. Must equal stored nonce (same auth) or
     *                   stored nonce + 1 (new/top-up auth, resets usage).
     * @param deadline   Signature expiry (unix timestamp).
     * @param sig        65-byte ECDSA signature from the buyer.
     */
    function charge(
        address buyer,
        uint256 amount,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        address seller = msg.sender;

        // ── Basic validation ─────────────────────────────────────────────────
        if (amount    == 0)                revert ZeroAmount();
        if (nonce     == 0)                revert AuthNonceMismatch(0, 0);
        if (block.timestamp > deadline)    revert AuthExpired(deadline, block.timestamp);
        if (sellers[seller].stakedAmount < MIN_SELLER_STAKE)
            revert InsufficientStake(sellers[seller].stakedAmount, MIN_SELLER_STAKE);

        // ── EIP-712 signature verification ───────────────────────────────────
        {
            bytes32 structHash = keccak256(abi.encode(
                SPENDING_AUTH_TYPEHASH,
                seller,
                sessionId,
                maxAmount,
                nonce,
                deadline
            ));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
            if (_recoverSigner(digest, sig) != buyer) revert AuthInvalidSig();
        }

        // ── Nonce & cap management ────────────────────────────────────────────
        SessionAuth storage auth = _sessionAuths[buyer][seller][sessionId];

        if (nonce == auth.nonce + 1) {
            // New or top-up auth: advance nonce and reset usage
            auth.nonce    = nonce;
            auth.authUsed = 0;
            auth.authMax  = maxAmount;
            auth.deadline = deadline;
        } else if (nonce == auth.nonce && auth.nonce > 0) {
            // Continuing charge under the same auth
            if (maxAmount != auth.authMax) revert AuthCapMismatch(auth.authMax, maxAmount);
        } else {
            revert AuthNonceMismatch(auth.nonce, nonce);
        }

        if (auth.authUsed + amount > auth.authMax)
            revert AuthCapExceeded(auth.authUsed, amount, auth.authMax);

        // ── Balance check ─────────────────────────────────────────────────────
        // Charges are enforced against current escrow balance. Pending withdrawal
        // reservations do not block charging.
        BuyerAccount storage b = buyers[buyer];
        if (b.balance < amount) revert InsufficientBalance(b.balance, amount);

        // ── Fee split ──────────────────────────────────────────────────────────
        uint256 fee          = (amount * platformFeeBps) / 10_000;
        uint256 sellerAmount = amount - fee;

        // ── State updates ─────────────────────────────────────────────────────
        b.balance -= amount;
        auth.authUsed += amount;

        sellers[seller].pendingEarnings += sellerAmount;
        if (fee > 0) accumulatedFees += fee;

        _updateStats(buyer, seller, amount);

        emit Charged(buyer, seller, sessionId, amount, fee);
    }

    // ── Seller: earnings & stake ─────────────────────────────────────────────

    /**
     * @notice Transfer all pending earnings to the seller's wallet.
     */
    function claimEarnings() external nonReentrant {
        SellerAccount storage s = sellers[msg.sender];
        uint256 amount = s.pendingEarnings;
        if (amount == 0) revert ZeroAmount();
        s.pendingEarnings = 0;
        _safeTransfer(msg.sender, amount);
        emit EarningsClaimed(msg.sender, amount);
    }

    /**
     * @notice Stake USDC to unlock charge() and boost reputation.
     *         Requires prior ERC-20 approval.
     */
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        SellerAccount storage s = sellers[msg.sender];
        // Only reset the lock timer on the first stake (or after a full unstake).
        // Topping up an existing stake does not restart the lock period.
        if (s.stakedAmount == 0) s.stakedSince = block.timestamp;
        s.stakedAmount += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Unstake USDC after the lock period has elapsed.
     */
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        SellerAccount storage s = sellers[msg.sender];
        if (s.stakedAmount < amount) revert InsufficientStakedAmount(s.stakedAmount, amount);
        uint256 unlocksAt = s.stakedSince + STAKE_LOCK_PERIOD;
        if (block.timestamp < unlocksAt) revert StakeLocked(unlocksAt);
        s.stakedAmount -= amount;
        _safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    // ── Platform fee collection ──────────────────────────────────────────────

    /**
     * @notice Transfer accumulated platform fees to the fee collector.
     */
    function sweepFees() external nonReentrant {
        uint256 amount = accumulatedFees;
        if (amount == 0) revert ZeroAmount();
        accumulatedFees = 0;
        _safeTransfer(feeCollector, amount);
        emit FeeSwept(feeCollector, amount);
    }

    // ── Reputation ───────────────────────────────────────────────────────────

    /**
     * @notice Rate a seller 0-100. Eligibility is enforced on-chain.
     *         Existing ratings can be updated after the cooldown expires.
     */
    function rateSeller(address seller, uint8 score) external {
        if (score > 100) revert RatingOutOfRange(score);
        address buyer = msg.sender;

        BuyerAccount storage b = buyers[buyer];

        // Buyer age
        if (b.firstTransactionAt == 0 ||
            block.timestamp < b.firstTransactionAt + BUYER_AGE_REQUIREMENT)
        {
            uint256 readyAt = b.firstTransactionAt == 0
                ? block.timestamp + BUYER_AGE_REQUIREMENT
                : b.firstTransactionAt + BUYER_AGE_REQUIREMENT;
            revert RatingAccountTooNew(readyAt);
        }

        // Unique sellers interacted with
        if (b.uniqueSellersCount < MIN_UNIQUE_SELLERS)
            revert RatingNeedMoreSellers(b.uniqueSellersCount, MIN_UNIQUE_SELLERS);

        // Must have interacted with this specific seller
        if (!hasInteracted[buyer][seller]) revert RatingNoInteraction();

        // Minimum spend with this seller
        if (buyerSpendWithSeller[buyer][seller] < MIN_VOTE_SPEND)
            revert RatingInsufficientSpend(buyerSpendWithSeller[buyer][seller], MIN_VOTE_SPEND);

        // Cooldown since last vote on this seller
        uint256 lastVote = _lastRatedAt[buyer][seller];
        if (lastVote != 0 && block.timestamp < lastVote + RATING_COOLDOWN)
            revert RatingCooldownActive(lastVote + RATING_COOLDOWN);

        // Update aggregates (handle update vs first vote)
        if (_hasRated[buyer][seller]) {
            uint8 old = _lastRating[buyer][seller];
            _ratingSum[seller] = _ratingSum[seller] - old + score;
        } else {
            _ratingSum[seller]    += score;
            _ratingCount[seller]  += 1;
            _hasRated[buyer][seller] = true;
        }

        _lastRating[buyer][seller] = score;
        _lastRatedAt[buyer][seller] = block.timestamp;

        emit SellerRated(buyer, seller, score);
    }

    /**
     * @notice Check whether a buyer is currently eligible to rate a seller.
     */
    function canRate(address buyer, address seller) external view returns (bool) {
        BuyerAccount storage b = buyers[buyer];
        if (b.firstTransactionAt == 0) return false;
        if (block.timestamp < b.firstTransactionAt + BUYER_AGE_REQUIREMENT) return false;
        if (b.uniqueSellersCount < MIN_UNIQUE_SELLERS) return false;
        if (!hasInteracted[buyer][seller]) return false;
        if (buyerSpendWithSeller[buyer][seller] < MIN_VOTE_SPEND) return false;
        uint256 lastVote = _lastRatedAt[buyer][seller];
        if (lastVote != 0 && block.timestamp < lastVote + RATING_COOLDOWN) return false;
        return true;
    }

    /**
     * @notice Return all on-chain reputation data for a seller.
     *         The composite score is computed off-chain by the SDK/dashboard.
     */
    function getReputation(address seller) external view returns (ReputationData memory) {
        SellerAccount storage s = sellers[seller];
        uint256 count  = _ratingCount[seller];
        uint256 avg    = count > 0 ? _ratingSum[seller] / count : 0;
        uint256 ageDays = s.firstTransactionAt > 0
            ? (block.timestamp - s.firstTransactionAt) / 1 days
            : 0;
        return ReputationData({
            avgRating:          avg,
            ratingCount:        count,
            stakedAmount:       s.stakedAmount,
            totalTransactions:  s.totalTransactions,
            totalVolume:        s.totalVolume,
            uniqueBuyersServed: s.uniqueBuyersCount,
            ageDays:            ageDays
        });
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    /**
     * @notice Return a buyer's available balance, pending withdrawal, and
     *         the timestamp at which the withdrawal becomes executable (0 if none).
     */
    function getBuyerBalance(address buyer) external view returns (
        uint256 available,
        uint256 pendingWithdrawal,
        uint256 withdrawalReadyAt
    ) {
        BuyerAccount storage b = buyers[buyer];
        available         = b.balance > b.withdrawalAmount
            ? b.balance - b.withdrawalAmount
            : 0;
        pendingWithdrawal = b.withdrawalAmount;
        withdrawalReadyAt = b.withdrawalAmount > 0
            ? b.withdrawalRequestedAt + WITHDRAWAL_TIMELOCK
            : 0;
    }

    /**
     * @notice Return the current SessionAuth for a (buyer, seller, sessionId) triple.
     */
    function getSessionAuth(
        address buyer,
        address seller,
        bytes32 sessionId
    ) external view returns (
        uint256 nonce,
        uint256 authMax,
        uint256 authUsed,
        uint256 deadline
    ) {
        SessionAuth storage a = _sessionAuths[buyer][seller][sessionId];
        return (a.nonce, a.authMax, a.authUsed, a.deadline);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    function _updateStats(address buyer, address seller, uint256 amount) private {
        BuyerAccount  storage b = buyers[buyer];
        SellerAccount storage s = sellers[seller];

        // First-transaction timestamps
        if (b.firstTransactionAt == 0) b.firstTransactionAt = block.timestamp;
        if (s.firstTransactionAt == 0) s.firstTransactionAt = block.timestamp;

        // Interaction tracking (for unique counts + rating eligibility)
        if (!hasInteracted[buyer][seller]) {
            hasInteracted[buyer][seller] = true;
            b.uniqueSellersCount += 1;
            s.uniqueBuyersCount  += 1;
        }

        buyerSpendWithSeller[buyer][seller] += amount;
        s.totalTransactions += 1;
        s.totalVolume       += amount;
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8   v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }

    function _safeTransferFrom(address from, address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
