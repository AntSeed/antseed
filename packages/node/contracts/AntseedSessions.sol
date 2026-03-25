// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAntseedDeposits {
    function lockForSession(address buyer, uint256 amount) external;
    function chargeAndCreditEarnings(
        address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
        uint256 platformFee, address protocolReserve, bool isProvenSign
    ) external;
    function releaseLock(address buyer, uint256 amount) external;
    function uniqueSellersCharged(address buyer) external view returns (uint256);
}

interface IAntseedIdentity {
    struct ReputationUpdate {
        uint8 updateType;
        uint256 tokenVolume;
    }

    function updateReputation(uint256 tokenId, ReputationUpdate calldata update) external;
    function getTokenId(address addr) external view returns (uint256);
    function isRegistered(address addr) external view returns (bool);
}

interface IAntseedStaking {
    function validateSeller(address seller) external view returns (uint256 tokenRate);
    function getStake(address seller) external view returns (uint256);
    function getTokenRate(address seller) external view returns (uint256);
    function isStakedAboveMin(address seller) external view returns (bool);
    function incrementActiveSessions(address seller) external;
    function decrementActiveSessions(address seller) external;
}

interface IAntseedEmissions {
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
}

/**
 * @title AntseedSessions
 * @notice Session lifecycle with Proof of Prior Delivery and EIP-712 spending authorizations.
 *         Holds NO USDC — orchestrates between AntseedDeposits and AntseedIdentity.
 *         This contract is swappable: deploy a new version and re-point Deposits + Identity.
 */
contract AntseedSessions is EIP712, Pausable, Ownable, ReentrancyGuard {
    // ─── EIP-712 ────────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 maxAmount,uint256 nonce,uint256 deadline,uint256 previousConsumption,bytes32 previousSessionId)"
    );

    // ─── Constant Keys for setConstant ─────────────────────────────────
    bytes32 private constant KEY_FIRST_SIGN_CAP = keccak256("FIRST_SIGN_CAP");
    bytes32 private constant KEY_MIN_TOKEN_THRESHOLD = keccak256("MIN_TOKEN_THRESHOLD");
    bytes32 private constant KEY_BUYER_DIVERSITY_THRESHOLD = keccak256("BUYER_DIVERSITY_THRESHOLD");
    bytes32 private constant KEY_PROVEN_SIGN_COOLDOWN = keccak256("PROVEN_SIGN_COOLDOWN");
    bytes32 private constant KEY_SETTLE_TIMEOUT = keccak256("SETTLE_TIMEOUT");
    bytes32 private constant KEY_PLATFORM_FEE_BPS = keccak256("PLATFORM_FEE_BPS");

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public MIN_TOKEN_THRESHOLD = 1000;
    uint256 public BUYER_DIVERSITY_THRESHOLD = 3;
    uint256 public PROVEN_SIGN_COOLDOWN = 7 days;
    uint256 public SETTLE_TIMEOUT = 24 hours;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;

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
        uint256 settledTokenCount;
        uint256 tokenRate;
        SessionStatus status;
        bool isFirstSign;
        bool isProvenSign;
        bool isQualifiedProvenSign;
    }

    // ─── State Variables ────────────────────────────────────────────────
    IAntseedDeposits public depositsContract;
    IAntseedIdentity public identityContract;
    IAntseedStaking public stakingContract;
    IAntseedEmissions public emissionsContract;
    address public protocolReserve;

    mapping(bytes32 => Session) public sessions;
    mapping(address => mapping(address => bytes32)) public latestSessionId;
    mapping(address => mapping(address => uint256)) public firstSessionTimestamp;

    // ─── Events ─────────────────────────────────────────────────────────
    event Reserved(bytes32 indexed sessionId, address indexed buyer, address indexed seller, uint256 maxAmount);
    event Settled(bytes32 indexed sessionId, address indexed seller, uint256 chargeAmount, uint256 platformFee);
    event SettledTimeout(bytes32 indexed sessionId, address indexed buyer, address indexed seller);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ──────────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSession();
    error InvalidSignature();
    error SessionExists();
    error SessionNotReserved();
    error SessionExpired();
    error InsufficientBalance();
    error NotAuthorized();
    error TimeoutNotReached();
    error InvalidFee();
    error FirstSignCapExceeded();
    error CooldownNotElapsed();
    error InvalidProofChain();

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _deposits, address _identity, address _staking)
        EIP712("AntseedSessions", "1")
        Ownable(msg.sender)
    {
        if (_deposits == address(0) || _identity == address(0) || _staking == address(0)) revert InvalidAddress();
        depositsContract = IAntseedDeposits(_deposits);
        identityContract = IAntseedIdentity(_identity);
        stakingContract = IAntseedStaking(_staking);
    }

    // ─── Domain Separator Helper ────────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
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
        uint256 tokenRate = stakingContract.validateSeller(msg.sender);

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
            if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
            if (firstSessionTimestamp[buyer][msg.sender] == 0) {
                firstSessionTimestamp[buyer][msg.sender] = block.timestamp;
            }
        } else {
            if (previousSessionId != latestSessionId[buyer][msg.sender]) revert InvalidProofChain();
            Session storage prevSession = sessions[previousSessionId];
            if (prevSession.status != SessionStatus.Settled) revert InvalidProofChain();
            if (prevSession.buyer != buyer || prevSession.seller != msg.sender) revert InvalidProofChain();
            if (previousConsumption != prevSession.settledTokenCount) revert InvalidProofChain();
            if (previousConsumption < MIN_TOKEN_THRESHOLD) revert InvalidProofChain();

            uint256 firstTime = firstSessionTimestamp[buyer][msg.sender];
            if (firstTime == 0 || block.timestamp < firstTime + PROVEN_SIGN_COOLDOWN) revert CooldownNotElapsed();

            isProvenSign = true;
            if (depositsContract.uniqueSellersCharged(buyer) >= BUYER_DIVERSITY_THRESHOLD) {
                isQualifiedProvenSign = true;
            }
        }

        // Lock buyer funds via Deposits
        depositsContract.lockForSession(buyer, maxAmount);

        // Store session
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
            tokenRate: tokenRate,
            status: SessionStatus.Reserved,
            isFirstSign: isFirstSign,
            isProvenSign: isProvenSign,
            isQualifiedProvenSign: isQualifiedProvenSign
        });

        latestSessionId[buyer][msg.sender] = sessionId;
        stakingContract.incrementActiveSessions(msg.sender);

        // Update reputation
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

        // Compute charge with overflow protection
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

        // Charge buyer and credit seller earnings via Deposits
        depositsContract.chargeAndCreditEarnings(
            session.buyer,
            msg.sender,
            chargeAmount,
            session.maxAmount,
            platformFee,
            protocolReserve,
            session.isProvenSign || session.isQualifiedProvenSign
        );

        // Derive effective token count from capped charge
        uint256 effectiveTokenCount = (session.tokenRate > 0)
            ? chargeAmount / session.tokenRate
            : 0;

        // Update session
        session.settledAmount = chargeAmount;
        session.settledTokenCount = effectiveTokenCount;
        session.status = SessionStatus.Settled;
        stakingContract.decrementActiveSessions(msg.sender);

        // Accrue emission points
        if (address(emissionsContract) != address(0)) {
            if (session.isQualifiedProvenSign) {
                emissionsContract.accrueSellerPoints(msg.sender, effectiveTokenCount);
            }
            if (session.isProvenSign || session.isQualifiedProvenSign) {
                uint256 diversityMult = depositsContract.uniqueSellersCharged(session.buyer);
                emissionsContract.accrueBuyerPoints(session.buyer, effectiveTokenCount * diversityMult);
            }
        }

        emit Settled(sessionId, msg.sender, chargeAmount, platformFee);
    }

    function settleTimeout(bytes32 sessionId) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != SessionStatus.Reserved) revert SessionNotReserved();
        if (msg.sender != session.buyer && msg.sender != session.seller && msg.sender != owner()) revert NotAuthorized();
        if (block.timestamp < session.reservedAt + SETTLE_TIMEOUT && block.timestamp <= session.deadline) revert TimeoutNotReached();

        // Return credits via Deposits
        depositsContract.releaseLock(session.buyer, session.maxAmount);

        // Record ghost on identity
        uint256 sellerTokenId = identityContract.getTokenId(session.seller);
        if (sellerTokenId != 0) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({ updateType: 3, tokenVolume: 0 })
            );
        }

        session.status = SessionStatus.TimedOut;
        stakingContract.decrementActiveSessions(session.seller);

        emit SettledTimeout(sessionId, session.buyer, session.seller);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setDepositsContract(address _deposits) external onlyOwner {
        if (_deposits == address(0)) revert InvalidAddress();
        depositsContract = IAntseedDeposits(_deposits);
    }

    function setIdentityContract(address _identity) external onlyOwner {
        if (_identity == address(0)) revert InvalidAddress();
        identityContract = IAntseedIdentity(_identity);
    }

    function setStakingContract(address _staking) external onlyOwner {
        if (_staking == address(0)) revert InvalidAddress();
        stakingContract = IAntseedStaking(_staking);
    }

    function setEmissionsContract(address _emissions) external onlyOwner {
        emissionsContract = IAntseedEmissions(_emissions);
    }

    function setProtocolReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidAddress();
        protocolReserve = _reserve;
    }

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == KEY_FIRST_SIGN_CAP) FIRST_SIGN_CAP = value;
        else if (key == KEY_MIN_TOKEN_THRESHOLD) MIN_TOKEN_THRESHOLD = value;
        else if (key == KEY_BUYER_DIVERSITY_THRESHOLD) BUYER_DIVERSITY_THRESHOLD = value;
        else if (key == KEY_PROVEN_SIGN_COOLDOWN) {
            if (value < 1 days) revert InvalidAmount();
            PROVEN_SIGN_COOLDOWN = value;
        }
        else if (key == KEY_SETTLE_TIMEOUT) {
            if (value < 1 hours) revert InvalidAmount();
            SETTLE_TIMEOUT = value;
        }
        else if (key == KEY_PLATFORM_FEE_BPS) {
            if (value > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
            PLATFORM_FEE_BPS = value;
        }
        else revert InvalidAmount();

        emit ConstantUpdated(key, value);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
