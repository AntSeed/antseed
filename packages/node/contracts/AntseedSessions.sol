// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedIdentity} from "./interfaces/IAntseedIdentity.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";

/**
 * @title AntseedSessions
 * @notice Session lifecycle with cumulative streaming model and EIP-712 spending authorizations.
 *         Holds NO USDC — orchestrates between AntseedDeposits and AntseedIdentity.
 *         This contract is swappable: deploy a new version and re-point Deposits + Identity.
 */
contract AntseedSessions is EIP712, Pausable, Ownable, ReentrancyGuard {
    // ─── EIP-712 ────────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(address seller,bytes32 sessionId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeOutputTokens,uint256 nonce,uint256 deadline)"
    );

    // ─── Constant Keys for setConstant ─────────────────────────────────
    bytes32 private constant KEY_FIRST_SIGN_CAP = keccak256("FIRST_SIGN_CAP");
    bytes32 private constant KEY_CLOSE_GRACE_PERIOD = keccak256("CLOSE_GRACE_PERIOD");
    bytes32 private constant KEY_PLATFORM_FEE_BPS = keccak256("PLATFORM_FEE_BPS");

    // ─── Configurable Constants ─────────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public CLOSE_GRACE_PERIOD = 2 hours;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;

    // ─── Enums & Structs ────────────────────────────────────────────────
    enum SessionStatus { None, Active, Settled, TimedOut }

    struct Session {
        address buyer;
        address seller;
        uint256 deposit;
        uint256 settled;
        uint128 settledInputTokens;
        uint128 settledOutputTokens;
        uint256 nonce;
        uint256 deadline;
        uint256 settledAt;
        SessionStatus status;
    }

    // ─── State Variables ────────────────────────────────────────────────
    IAntseedDeposits public depositsContract;
    IAntseedIdentity public identityContract;
    IAntseedStaking public stakingContract;
    address public protocolReserve;

    mapping(bytes32 => Session) public sessions;

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
    error SellerNotStaked();

    // ─── Constructor ────────────────────────────────────────────────────
    constructor(address _deposits, address _identity, address _staking)
        EIP712("AntseedSessions", "2")
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
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        // Basic validation
        if (block.timestamp > deadline) revert SessionExpired();
        if (!stakingContract.isStakedAboveMin(msg.sender)) revert SellerNotStaked();

        // EIP-712 signature verification (cumulative fields = 0 for reserve)
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                msg.sender,
                sessionId,
                uint256(0),
                uint256(0),
                uint256(0),
                nonce,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, buyerSig);
        if (recovered != buyer) revert InvalidSignature();

        Session storage existing = sessions[sessionId];

        if (existing.status == SessionStatus.Active) {
            // Top-up path: add to existing deposit
            if (existing.buyer != buyer || existing.seller != msg.sender) revert NotAuthorized();
            depositsContract.lockForSession(buyer, maxAmount);
            existing.deposit += maxAmount;
            emit Reserved(sessionId, buyer, msg.sender, existing.deposit);
        } else if (existing.status == SessionStatus.None) {
            // Create path: new session
            if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
            depositsContract.lockForSession(buyer, maxAmount);

            sessions[sessionId] = Session({
                buyer: buyer,
                seller: msg.sender,
                deposit: maxAmount,
                settled: 0,
                settledInputTokens: 0,
                settledOutputTokens: 0,
                nonce: nonce,
                deadline: deadline,
                settledAt: 0,
                status: SessionStatus.Active
            });

            stakingContract.incrementActiveSessions(msg.sender);
            emit Reserved(sessionId, buyer, msg.sender, maxAmount);
        } else {
            revert SessionExists();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE
    // ═══════════════════════════════════════════════════════════════════

    function settle(
        bytes32 sessionId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens,
        uint256 nonce,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != SessionStatus.Active) revert SessionNotReserved();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (block.timestamp > deadline) revert SessionExpired();
        if (cumulativeAmount > session.deposit) revert InvalidAmount();

        // EIP-712 buyer signature verification
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                msg.sender,
                sessionId,
                cumulativeAmount,
                cumulativeInputTokens,
                cumulativeOutputTokens,
                nonce,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, buyerSig);
        if (recovered != session.buyer) revert InvalidSignature();

        // Compute platform fee
        uint256 platformFee = 0;
        if (cumulativeAmount > 0) {
            platformFee = (cumulativeAmount * PLATFORM_FEE_BPS) / 10000;
        }

        // Charge buyer and credit seller earnings via Deposits
        depositsContract.chargeAndCreditEarnings(
            session.buyer,
            msg.sender,
            cumulativeAmount,
            session.deposit,
            platformFee,
            protocolReserve
        );

        // Update session
        session.settled = cumulativeAmount;
        session.settledInputTokens = uint128(cumulativeInputTokens);
        session.settledOutputTokens = uint128(cumulativeOutputTokens);
        session.nonce = nonce;
        session.settledAt = block.timestamp;
        session.status = SessionStatus.Settled;
        stakingContract.decrementActiveSessions(msg.sender);

        // Update reputation with settlement data
        uint256 sellerTokenId = identityContract.getTokenId(msg.sender);
        if (sellerTokenId != 0) {
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({
                    updateType: 0,
                    settledVolume: cumulativeAmount,
                    inputTokens: uint128(cumulativeInputTokens),
                    outputTokens: uint128(cumulativeOutputTokens)
                })
            );
        }

        emit Settled(sessionId, msg.sender, cumulativeAmount, platformFee);
    }

    function settleTimeout(bytes32 sessionId) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != SessionStatus.Active) revert SessionNotReserved();
        if (block.timestamp < session.deadline + CLOSE_GRACE_PERIOD) revert TimeoutNotReached();

        // Release full deposit via Deposits
        depositsContract.releaseLock(session.buyer, session.deposit);

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

    function setProtocolReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidAddress();
        protocolReserve = _reserve;
    }

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == KEY_FIRST_SIGN_CAP) FIRST_SIGN_CAP = value;
        else if (key == KEY_CLOSE_GRACE_PERIOD) {
            if (value < 30 minutes) revert InvalidAmount();
            CLOSE_GRACE_PERIOD = value;
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
