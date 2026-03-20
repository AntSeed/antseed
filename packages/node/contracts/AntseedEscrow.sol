// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IAntseedIdentity {
    struct ProvenReputation {
        uint64 firstSignCount;
        uint64 qualifiedProvenSignCount;
        uint64 unqualifiedProvenSignCount;
        uint64 ghostCount;
        uint256 totalQualifiedTokenVolume;
        uint64 lastProvenAt;
    }

    struct ReputationUpdate {
        uint8 updateType;
        uint256 tokenVolume;
    }

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external;
    function getReputation(uint256 tokenId) external view returns (ProvenReputation memory);
    function isRegistered(address addr) external view returns (bool);
    function getTokenId(address addr) external view returns (uint256);
}

interface IAntseedEmissions {
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
}

/**
 * @title AntseedEscrow
 * @notice Proof of Prior Delivery escrow with EIP-712 spending authorizations,
 *         dynamic credit limits, reputation-gated sessions, and 5-tier slashing.
 */
contract AntseedEscrow is EIP712, Pausable {
    // ─── EIP-712 ────────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 maxAmount,uint256 nonce,uint256 deadline,uint256 previousConsumption,bytes32 previousSessionId)"
    );

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public MIN_BUYER_DEPOSIT = 10_000_000;
    uint256 public MIN_SELLER_STAKE = 10_000_000;
    uint256 public MIN_TOKEN_THRESHOLD = 1000;
    uint256 public BUYER_DIVERSITY_THRESHOLD = 3;
    uint256 public PROVEN_SIGN_COOLDOWN = 7 days;
    uint256 public BUYER_INACTIVITY_PERIOD = 90 days;
    uint256 public SETTLE_TIMEOUT = 24 hours;
    uint256 public WITHDRAWAL_DELAY = 48 hours;
    uint256 public REPUTATION_CAP_COEFFICIENT = 20;
    uint256 public SLASH_RATIO_THRESHOLD = 30;
    uint256 public SLASH_GHOST_THRESHOLD = 5;
    uint256 public SLASH_INACTIVITY_DAYS = 30 days;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;
    uint256 public BASE_CREDIT_LIMIT = 10_000_000;
    uint256 public PEER_INTERACTION_BONUS = 5_000_000;
    uint256 public TIME_BONUS = 500_000;
    uint256 public PROVEN_SESSION_BONUS = 10_000_000;
    uint256 public FEEDBACK_BONUS = 2_000_000;
    uint256 public MAX_CREDIT_LIMIT = 500_000_000;

    // ─── Enums & Structs ────────────────────────────────────────────────
    enum SessionStatus { None, Reserved, Settled, TimedOut }

    struct Session {
        address buyer;
        address seller;
        uint256 maxAmount;
        uint256 nonce;
        uint256 deadline;
        uint256 previousConsumption;
        bytes32 previousSessionId;
        uint256 reservedAt;
        uint256 settledAmount;
        uint256 settledTokenCount;  // Tokens delivered (for proof chain validation)
        uint256 tokenRate;          // Snapshotted at reserve time
        SessionStatus status;
        bool isFirstSign;
        bool isProvenSign;
        bool isQualifiedProvenSign;
    }

    struct BuyerAccount {
        uint256 balance;
        uint256 reserved;
        uint256 withdrawalAmount;
        uint256 withdrawalRequestedAt;
        uint256 lastActivityAt;
        uint256 firstSessionAt;
        uint256 provenBuyCount;
        uint256 feedbackCount;
    }

    struct SellerAccount {
        uint256 stake;
        uint256 earnings;
        uint256 stakedAt;
        uint256 tokenRate;
    }

    // ─── State Variables ────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedIdentity public identityContract;
    IAntseedEmissions public emissionsContract;
    address public owner;
    address public protocolReserve;
    bool private _locked;

    mapping(bytes32 => Session) public sessions;
    mapping(address => BuyerAccount) public buyers;
    mapping(address => SellerAccount) public sellers;
    mapping(address => uint256) public uniqueSellersCharged;
    mapping(address => mapping(address => bool)) private _buyerSellerPairs;

    mapping(address => mapping(address => bytes32)) public latestSessionId;
    mapping(address => uint256) public activeSessionCount;
    mapping(address => uint256) public creditLimitOverride;
    mapping(address => mapping(address => uint256)) public firstSessionTimestamp; // buyer → seller → first session time

    // ─── Events ─────────────────────────────────────────────────────────
    event Deposited(address indexed buyer, uint256 amount);
    event WithdrawalRequested(address indexed buyer, uint256 amount);
    event WithdrawalExecuted(address indexed buyer, uint256 amount);
    event WithdrawalCancelled(address indexed buyer);
    event Staked(address indexed seller, uint256 amount);
    event Unstaked(address indexed seller, uint256 amount, uint256 slashed);
    event Reserved(bytes32 indexed sessionId, address indexed buyer, address indexed seller, uint256 maxAmount);
    event Settled(bytes32 indexed sessionId, address indexed seller, uint256 chargeAmount, uint256 platformFee);
    event SettledTimeout(bytes32 indexed sessionId, address indexed buyer, address indexed seller);
    event EarningsClaimed(address indexed seller, uint256 amount);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSession();
    error InvalidSignature();
    error SessionExists();
    error SessionNotReserved();
    error SessionExpired();
    error InsufficientBalance();
    error InsufficientStake();
    error NotRegistered();
    error NotAuthorized();
    error Reentrancy();
    error ActiveSessions();
    error TimeoutNotReached();
    error InactivityNotReached();
    error InvalidFee();
    error FirstSignCapExceeded();
    error CooldownNotElapsed();
    error InvalidProofChain();
    error BelowMinDeposit();
    error TransferFailed();
    error CreditLimitExceeded();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _usdc, address _identity) EIP712("AntseedEscrow", "1") {
        if (_usdc == address(0)) revert InvalidAddress();
        if (_identity == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        identityContract = IAntseedIdentity(_identity);
        owner = msg.sender;
        protocolReserve = msg.sender;
    }

    // ─── Domain Separator Helper ────────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
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
            + PROVEN_SESSION_BONUS * ba.provenBuyCount
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

        _safeTransferFrom(msg.sender, address(this), amount);
        ba.balance += amount;
        ba.lastActivityAt = block.timestamp;

        emit Deposited(msg.sender, amount);
    }

    function requestWithdrawal(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        BuyerAccount storage ba = buyers[msg.sender];
        // Must cancel existing withdrawal request before creating a new one
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

        // Cap withdrawal at available balance in case settlements reduced it
        uint256 available = ba.balance - ba.reserved;
        uint256 amount = ba.withdrawalAmount > available ? available : ba.withdrawalAmount;
        ba.withdrawalAmount = 0;
        ba.withdrawalRequestedAt = 0;
        ba.balance -= amount;

        _safeTransfer(msg.sender, amount);

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
    //                        SELLER OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!identityContract.isRegistered(msg.sender)) revert NotRegistered();

        _safeTransferFrom(msg.sender, address(this), amount);

        SellerAccount storage sa = sellers[msg.sender];
        sa.stake += amount;
        sa.stakedAt = block.timestamp;

        emit Staked(msg.sender, amount);
    }

    function setTokenRate(uint256 rate) external {
        if (rate == 0) revert InvalidAmount();
        SellerAccount storage sa = sellers[msg.sender];
        if (sa.stake == 0) revert InsufficientStake();
        sa.tokenRate = rate;
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

        if (payout > 0) {
            _safeTransfer(msg.sender, payout);
        }
        if (slashAmount > 0 && protocolReserve != address(0)) {
            _safeTransfer(protocolReserve, slashAmount);
        }

        emit Unstaked(msg.sender, stakeAmount, slashAmount);
    }

    function claimEarnings() external nonReentrant {
        SellerAccount storage sa = sellers[msg.sender];
        uint256 amount = sa.earnings;
        if (amount == 0) revert InvalidAmount();

        sa.earnings = 0;
        _safeTransfer(msg.sender, amount);

        emit EarningsClaimed(msg.sender, amount);
    }

    function getSellerAccount(address seller)
        external
        view
        returns (uint256 stakeAmt, uint256 earnings, uint256 stakedAt, uint256 tokenRate)
    {
        SellerAccount storage sa = sellers[seller];
        return (sa.stake, sa.earnings, sa.stakedAt, sa.tokenRate);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function reserve(
        address buyer,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        uint256 previousConsumption,
        bytes32 previousSessionId,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        // Basic validation
        if (sessions[sessionId].status != SessionStatus.None) revert SessionExists();
        if (block.timestamp > deadline) revert SessionExpired();
        if (deadline < block.timestamp + SETTLE_TIMEOUT) revert SessionExpired();
        if (sellers[msg.sender].stake < MIN_SELLER_STAKE) revert InsufficientStake();
        if (sellers[msg.sender].tokenRate == 0) revert InvalidAmount();

        // EIP-712 signature verification
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                msg.sender,
                sessionId,
                maxAmount,
                nonce,
                deadline,
                previousConsumption,
                previousSessionId
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, buyerSig);
        if (recovered != buyer) revert InvalidSignature();

        // Classify session type
        bool isFirstSign = (previousConsumption == 0 && previousSessionId == bytes32(0));
        bool isProvenSign = false;
        bool isQualifiedProvenSign = false;

        if (isFirstSign) {
            // First sign: enforce cap
            if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
            // Record first-ever session timestamp for this buyer-seller pair
            if (firstSessionTimestamp[buyer][msg.sender] == 0) {
                firstSessionTimestamp[buyer][msg.sender] = block.timestamp;
            }

        } else {
            // Proven sign: validate proof chain — must chain from latest session
            if (previousSessionId != latestSessionId[buyer][msg.sender]) revert InvalidProofChain();
            Session storage prevSession = sessions[previousSessionId];
            if (prevSession.status != SessionStatus.Settled) revert InvalidProofChain();
            if (prevSession.buyer != buyer || prevSession.seller != msg.sender) revert InvalidProofChain();
            if (previousConsumption != prevSession.settledTokenCount) revert InvalidProofChain();
            if (previousConsumption < MIN_TOKEN_THRESHOLD) revert InvalidProofChain();

            // Cooldown check: must wait PROVEN_SIGN_COOLDOWN from the first-ever session
            uint256 firstTime = firstSessionTimestamp[buyer][msg.sender];
            if (firstTime == 0 || block.timestamp < firstTime + PROVEN_SIGN_COOLDOWN) revert CooldownNotElapsed();

            isProvenSign = true;
            // Qualified if buyer has interacted with enough unique sellers
            if (uniqueSellersCharged[buyer] >= BUYER_DIVERSITY_THRESHOLD) {
                isQualifiedProvenSign = true;
            }
        }

        // Check buyer available balance
        BuyerAccount storage ba = buyers[buyer];
        uint256 available = ba.balance - ba.reserved - ba.withdrawalAmount;
        if (available < maxAmount) revert InsufficientBalance();

        // Lock credits
        ba.reserved += maxAmount;
        ba.lastActivityAt = block.timestamp;
        if (ba.firstSessionAt == 0) {
            ba.firstSessionAt = block.timestamp;
        }

        // Store session (snapshot tokenRate at reserve time to prevent manipulation)
        sessions[sessionId] = Session({
            buyer: buyer,
            seller: msg.sender,
            maxAmount: maxAmount,
            nonce: nonce,
            deadline: deadline,
            previousConsumption: previousConsumption,
            previousSessionId: previousSessionId,
            reservedAt: block.timestamp,
            settledAmount: 0,
            settledTokenCount: 0,
            tokenRate: sellers[msg.sender].tokenRate,
            status: SessionStatus.Reserved,
            isFirstSign: isFirstSign,
            isProvenSign: isProvenSign,
            isQualifiedProvenSign: isQualifiedProvenSign
        });

        // Update latest session and active count for this buyer-seller pair
        latestSessionId[buyer][msg.sender] = sessionId;
        activeSessionCount[msg.sender]++;

        // Update reputation on identity contract
        uint256 sellerTokenId = identityContract.getTokenId(msg.sender);
        if (isFirstSign) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({ updateType: 0, tokenVolume: 0 })
            );
        } else if (isQualifiedProvenSign) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({ updateType: 1, tokenVolume: previousConsumption })
            );
        } else if (isProvenSign) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({ updateType: 2, tokenVolume: 0 })
            );
        }

        emit Reserved(sessionId, buyer, msg.sender, maxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE
    // ═══════════════════════════════════════════════════════════════════

    function settle(bytes32 sessionId, uint256 tokenCount) external nonReentrant {
        if (tokenCount == 0) revert InvalidAmount();
        Session storage session = sessions[sessionId];
        if (session.status != SessionStatus.Reserved) revert SessionNotReserved();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (block.timestamp > session.deadline) revert SessionExpired();

        SellerAccount storage sa = sellers[msg.sender];
        // Compute charge with overflow protection: check cap before multiplying
        uint256 chargeAmount;
        if (session.tokenRate > 0 && tokenCount > session.maxAmount / session.tokenRate) {
            chargeAmount = session.maxAmount;
        } else {
            chargeAmount = tokenCount * session.tokenRate;
            if (chargeAmount > session.maxAmount) {
                chargeAmount = session.maxAmount;
            }
        }

        uint256 platformFee = 0;
        if (chargeAmount > 0) {
            platformFee = (chargeAmount * PLATFORM_FEE_BPS) / 10000;
        }
        uint256 sellerPayout = chargeAmount - platformFee;

        // Update buyer
        BuyerAccount storage ba = buyers[session.buyer];
        ba.balance -= chargeAmount;
        ba.reserved -= session.maxAmount;
        ba.lastActivityAt = block.timestamp;
        if (session.isProvenSign || session.isQualifiedProvenSign) {
            ba.provenBuyCount++;
        }

        // Update seller earnings
        sa.earnings += sellerPayout;

        // Track diversity
        if (!_buyerSellerPairs[session.buyer][msg.sender]) {
            _buyerSellerPairs[session.buyer][msg.sender] = true;
            uniqueSellersCharged[session.buyer]++;
        }

        // Derive effective token count from the capped charge to prevent
        // emission inflation via uncapped tokenCount argument
        uint256 effectiveTokenCount = (session.tokenRate > 0)
            ? chargeAmount / session.tokenRate
            : 0;

        // Update session
        session.settledAmount = chargeAmount;
        session.settledTokenCount = effectiveTokenCount;
        session.status = SessionStatus.Settled;
        activeSessionCount[msg.sender]--;

        // Transfer platform fee to protocol reserve
        if (platformFee > 0 && protocolReserve != address(0)) {
            _safeTransfer(protocolReserve, platformFee);
        }

        // Accrue emission points using capped effective token count
        if (address(emissionsContract) != address(0)) {
            if (session.isQualifiedProvenSign) {
                uint256 effectiveProven = _effectiveProvenSigns(msg.sender);
                emissionsContract.accrueSellerPoints(msg.sender, effectiveProven * effectiveTokenCount);
            }
            if (session.isProvenSign || session.isQualifiedProvenSign) {
                uint256 diversityMult = uniqueSellersCharged[session.buyer];
                emissionsContract.accrueBuyerPoints(session.buyer, effectiveTokenCount * diversityMult);
            }
        }

        emit Settled(sessionId, msg.sender, chargeAmount, platformFee);
    }

    function settleTimeout(bytes32 sessionId) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != SessionStatus.Reserved) revert SessionNotReserved();
        if (msg.sender != session.buyer && msg.sender != session.seller && msg.sender != owner) revert NotAuthorized();
        // Allow timeout if either: (a) SETTLE_TIMEOUT elapsed, or (b) deadline passed
        // This prevents limbo if deadline < reservedAt + SETTLE_TIMEOUT
        if (block.timestamp < session.reservedAt + SETTLE_TIMEOUT && block.timestamp <= session.deadline) revert TimeoutNotReached();

        // Return credits
        BuyerAccount storage ba = buyers[session.buyer];
        ba.reserved -= session.maxAmount;

        // Record ghost on identity (skip if seller deregistered to avoid locking buyer funds)
        uint256 sellerTokenId = identityContract.getTokenId(session.seller);
        if (sellerTokenId != 0) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({ updateType: 3, tokenVolume: 0 })
            );
        }

        session.status = SessionStatus.TimedOut;
        activeSessionCount[session.seller]--;

        emit SettledTimeout(sessionId, session.buyer, session.seller);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _calculateSlash(address seller) internal view returns (uint256) {
        uint256 sellerTokenId = identityContract.getTokenId(seller);
        IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(sellerTokenId);

        uint256 totalSigns = uint256(rep.qualifiedProvenSignCount) + uint256(rep.unqualifiedProvenSignCount);
        uint256 Q = uint256(rep.qualifiedProvenSignCount);
        uint256 stakeAmt = sellers[seller].stake;

        // Tier 1: no qualified proven signs but has total signs
        if (Q == 0 && totalSigns > 0) return stakeAmt;

        // Tier 2: has qualified but ratio below threshold
        if (Q > 0 && totalSigns > 0) {
            uint256 ratio = (Q * 100) / totalSigns;
            if (ratio < SLASH_RATIO_THRESHOLD) return stakeAmt / 2;
        }

        // Tier 3: too many ghosts and no qualified
        if (uint256(rep.ghostCount) >= SLASH_GHOST_THRESHOLD && Q == 0) return stakeAmt;

        // Tier 4: good ratio but inactive
        if (Q > 0 && totalSigns > 0) {
            uint256 ratio = (Q * 100) / totalSigns;
            if (ratio >= SLASH_RATIO_THRESHOLD && rep.lastProvenAt > 0) {
                if (block.timestamp > uint256(rep.lastProvenAt) + SLASH_INACTIVITY_DAYS) {
                    return stakeAmt / 5;
                }
            }
        }

        // Tier 5: no slash
        return 0;
    }

    function _effectiveProvenSigns(address seller) internal view returns (uint256) {
        uint256 sellerTokenId = identityContract.getTokenId(seller);
        IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(sellerTokenId);

        uint256 qualifiedCount = uint256(rep.qualifiedProvenSignCount);
        uint256 stakeCap = (sellers[seller].stake * REPUTATION_CAP_COEFFICIENT) / 1_000_000;

        return qualifiedCount < stakeCap ? qualifiedCount : stakeCap;
    }

    function _safeTransferFrom(address from, address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransfer(address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == keccak256("FIRST_SIGN_CAP")) FIRST_SIGN_CAP = value;
        else if (key == keccak256("MIN_BUYER_DEPOSIT")) MIN_BUYER_DEPOSIT = value;
        else if (key == keccak256("MIN_SELLER_STAKE")) MIN_SELLER_STAKE = value;
        else if (key == keccak256("MIN_TOKEN_THRESHOLD")) MIN_TOKEN_THRESHOLD = value;
        else if (key == keccak256("BUYER_DIVERSITY_THRESHOLD")) BUYER_DIVERSITY_THRESHOLD = value;
        else if (key == keccak256("PROVEN_SIGN_COOLDOWN")) {
            if (value < 1 days) revert InvalidAmount();
            PROVEN_SIGN_COOLDOWN = value;
        }
        else if (key == keccak256("BUYER_INACTIVITY_PERIOD")) {
            if (value < 1 days) revert InvalidAmount();
            BUYER_INACTIVITY_PERIOD = value;
        }
        else if (key == keccak256("SETTLE_TIMEOUT")) {
            if (value < 1 hours) revert InvalidAmount();
            SETTLE_TIMEOUT = value;
        }
        else if (key == keccak256("WITHDRAWAL_DELAY")) {
            if (value < 1 hours) revert InvalidAmount();
            WITHDRAWAL_DELAY = value;
        }
        else if (key == keccak256("REPUTATION_CAP_COEFFICIENT")) REPUTATION_CAP_COEFFICIENT = value;
        else if (key == keccak256("SLASH_RATIO_THRESHOLD")) SLASH_RATIO_THRESHOLD = value;
        else if (key == keccak256("SLASH_GHOST_THRESHOLD")) SLASH_GHOST_THRESHOLD = value;
        else if (key == keccak256("SLASH_INACTIVITY_DAYS")) {
            if (value < 1 days) revert InvalidAmount();
            SLASH_INACTIVITY_DAYS = value;
        }
        else if (key == keccak256("PLATFORM_FEE_BPS")) {
            if (value > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
            PLATFORM_FEE_BPS = value;
        }
        else if (key == keccak256("BASE_CREDIT_LIMIT")) BASE_CREDIT_LIMIT = value;
        else if (key == keccak256("PEER_INTERACTION_BONUS")) PEER_INTERACTION_BONUS = value;
        else if (key == keccak256("TIME_BONUS")) TIME_BONUS = value;
        else if (key == keccak256("PROVEN_SESSION_BONUS")) PROVEN_SESSION_BONUS = value;
        else if (key == keccak256("FEEDBACK_BONUS")) FEEDBACK_BONUS = value;
        else if (key == keccak256("MAX_CREDIT_LIMIT")) MAX_CREDIT_LIMIT = value;
        else revert InvalidAmount();

        emit ConstantUpdated(key, value);
    }

    function setCreditLimitOverride(address buyer, uint256 limit) external onlyOwner {
        creditLimitOverride[buyer] = limit;
    }

    function setPlatformFee(uint256 bps) external onlyOwner {
        if (bps > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
        PLATFORM_FEE_BPS = bps;
    }

    function setProtocolReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidAddress();
        protocolReserve = _reserve;
    }

    function setIdentityContract(address _identity) external onlyOwner {
        if (_identity == address(0)) revert InvalidAddress();
        identityContract = IAntseedIdentity(_identity);
    }

    function setEmissionsContract(address _emissions) external onlyOwner {
        if (_emissions == address(0)) revert InvalidAddress();
        emissionsContract = IAntseedEmissions(_emissions);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
