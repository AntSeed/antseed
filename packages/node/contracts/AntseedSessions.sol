// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";
import {IAntseedEmissions} from "./interfaces/IAntseedEmissions.sol";

/**
 * @title AntseedSessions
 * @notice Session lifecycle with built-in cumulative payment channels.
 *         USDC is held in this contract during active sessions.
 *
 *         The buyer signs a single EIP-712 MetadataAuth on every request:
 *         - cumulativeAmount: total USDC authorized so far
 *         - metadataHash: hash of (inputTokens, outputTokens, latencyMs, requestCount)
 *
 *         Money flow:
 *           reserve:  Deposits → Sessions (escrow)
 *           settle:   Sessions → Deposits (seller earnings)
 *           close:    Sessions → Deposits (seller earnings + buyer refund)
 *           timeout:  Sessions → Deposits (buyer refund)
 *
 *         Contract is swappable: deploy a new version and re-point Deposits + Stats.
 */
contract AntseedSessions is EIP712, Pausable, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── EIP-712 ─────────────────────────────────────────────────────
    bytes32 public constant METADATA_AUTH_TYPEHASH = keccak256(
        "MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    // ─── Constant Keys for setConstant ──────────────────────────────
    bytes32 private constant KEY_FIRST_SIGN_CAP = keccak256("FIRST_SIGN_CAP");
    bytes32 private constant KEY_PLATFORM_FEE_BPS = keccak256("PLATFORM_FEE_BPS");

    // ─── Configurable Constants ─────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;
    uint256 public TIMEOUT_GRACE_PERIOD = 15 minutes;

    // ─── Enums & Structs ────────────────────────────────────────────
    enum SessionStatus { None, Active, Settled, TimedOut }

    struct Session {
        address buyer;
        address seller;
        uint128 deposit;              // total USDC escrowed in this contract
        uint128 settled;              // last settled cumulative amount
        bytes32 metadataHash;         // latest metadata hash (for auditability)
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;     // timestamp when timeout was requested (0 = not requested)
        SessionStatus status;
    }

    // ─── State Variables ────────────────────────────────────────────
    IAntseedDeposits public depositsContract;
    IAntseedStats public statsContract;
    IAntseedStaking public stakingContract;
    IAntseedEmissions public emissionsContract;
    IERC20 public usdc;
    address public protocolReserve;

    mapping(bytes32 => Session) public sessions;

    // ─── Events ─────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event SessionSettled(bytes32 indexed channelId, address indexed seller, uint128 cumulativeAmount, uint256 platformFee);
    event SessionClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee);
    event TimeoutRequested(bytes32 indexed channelId);
    event SessionTimedOut(bytes32 indexed channelId, address indexed buyer);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error SessionExists();
    error SessionNotActive();
    error SessionExpired();
    error NotAuthorized();
    error InvalidFee();
    error FirstSignCapExceeded();
    error SellerNotStaked();
    error FinalAmountBelowSettled();
    error TimeoutNotReady();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _deposits,
        address _stats,
        address _staking,
        address _usdc
    )
        EIP712("AntseedSessions", "6")
        Ownable(msg.sender)
    {
        if (_deposits == address(0) || _stats == address(0) ||
            _staking == address(0) || _usdc == address(0))
            revert InvalidAddress();

        depositsContract = IAntseedDeposits(_deposits);
        statsContract = IAntseedStats(_stats);
        stakingContract = IAntseedStaking(_staking);
        usdc = IERC20(_usdc);
    }

    // ─── Domain Separator Helper ────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── Channel ID computation ─────────────────────────────────────
    function computeChannelId(
        address buyer,
        address seller,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(buyer, seller, salt));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESERVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Open a payment session. Seller calls this.
     *         USDC is pulled from buyer's Deposits balance into this contract.
     *
     * @param buyer        The buyer's address (signs MetadataAuth off-chain)
     * @param salt         Random salt for deterministic channel ID
     * @param maxAmount    USDC amount to lock
     * @param deadline     Session deadline (for timeout protection)
     * @param buyerSig     Buyer's MetadataAuth signature (cumAmount=0) as reserve proof
     */
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert SessionExpired();
        if (!stakingContract.isStakedAboveMin(msg.sender)) revert SellerNotStaked();
        if (maxAmount == 0) revert InvalidAmount();

        bytes32 channelId = computeChannelId(buyer, msg.sender, salt);

        if (sessions[channelId].status != SessionStatus.None) revert SessionExists();
        if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();

        // Verify buyer signature (cumulativeAmount=0, zero metadata = reserve proof)
        bytes32 zeroMetadataHash = keccak256(abi.encode(uint256(0), uint256(0), uint256(0), uint256(0)));
        _verifyMetadataAuth(channelId, 0, zeroMetadataHash, buyer, buyerSig);

        // Pull USDC from Deposits → this contract (escrow)
        depositsContract.lockForSession(buyer, maxAmount);
        depositsContract.transferToSessions(buyer, address(this), maxAmount);

        sessions[channelId] = Session({
            buyer: buyer,
            seller: msg.sender,
            deposit: maxAmount,
            settled: 0,
            metadataHash: bytes32(0),
            deadline: deadline,
            settledAt: 0,
            closeRequestedAt: 0,
            status: SessionStatus.Active
        });

        stakingContract.incrementActiveSessions(msg.sender);
        emit Reserved(channelId, buyer, msg.sender, maxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — TOP UP
    // ═══════════════════════════════════════════════════════════════════

    function topUp(bytes32 channelId, uint128 additionalAmount) external nonReentrant whenNotPaused {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (block.timestamp > session.deadline) revert SessionExpired();
        if (additionalAmount == 0) revert InvalidAmount();

        depositsContract.lockForSession(session.buyer, additionalAmount);
        depositsContract.transferToSessions(session.buyer, address(this), additionalAmount);

        session.deposit += additionalAmount;
        emit Reserved(channelId, session.buyer, session.seller, session.deposit);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE (mid-session checkpoint)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Settle partial payment. Seller submits buyer's MetadataAuth signature.
     *         The delta USDC is distributed to seller (minus platform fee).
     *         Session stays active for more requests.
     *
     * @param channelId        Session ID
     * @param cumulativeAmount Cumulative USDC amount authorized by buyer
     * @param metadata         ABI-encoded (inputTokens, outputTokens, latencyMs, requestCount)
     * @param buyerSig         Buyer's MetadataAuth EIP-712 signature
     */
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (cumulativeAmount <= session.settled) revert InvalidAmount();
        if (cumulativeAmount > session.deposit) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifyMetadataAuth(channelId, cumulativeAmount, metadataHash, session.buyer, buyerSig);

        uint128 delta = cumulativeAmount - session.settled;

        _distributeDelta(session, delta);

        session.settled = cumulativeAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;

        _recordStatsAndEmissions(session, delta, metadata);

        emit SessionSettled(channelId, session.seller, cumulativeAmount, _lastPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLOSE (final settle + refund)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Close the session with a final settlement.
     *         Seller earnings and buyer refund are sent to Deposits.
     *
     * @param channelId    Session ID
     * @param finalAmount  Final cumulative USDC amount
     * @param metadata     ABI-encoded (inputTokens, outputTokens, latencyMs, requestCount)
     * @param buyerSig     Buyer's MetadataAuth EIP-712 signature
     */
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (finalAmount < session.settled) revert FinalAmountBelowSettled();
        if (finalAmount > session.deposit) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifyMetadataAuth(channelId, finalAmount, metadataHash, session.buyer, buyerSig);

        uint128 delta = finalAmount - session.settled;
        uint128 refund = session.deposit - finalAmount;

        _distributeDelta(session, delta);

        if (refund > 0) {
            usdc.safeTransfer(address(depositsContract), refund);
            depositsContract.creditBuyerRefund(session.buyer, refund);
        }

        session.settled = finalAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;
        session.status = SessionStatus.Settled;
        stakingContract.decrementActiveSessions(session.seller);

        _recordStatsAndEmissions(session, delta, metadata);

        emit SessionClosed(channelId, session.seller, finalAmount, _lastPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TIMEOUT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request session timeout. Permissionless after deadline.
     *         Starts a grace period before funds can be withdrawn.
     */
    function requestTimeout(bytes32 channelId) external {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (block.timestamp <= session.deadline) revert NotAuthorized();
        if (session.closeRequestedAt != 0) revert InvalidAmount(); // already requested

        session.closeRequestedAt = block.timestamp;
        emit TimeoutRequested(channelId);
    }

    /**
     * @notice Withdraw remaining funds after timeout grace period.
     *         Returns unspent USDC to buyer's Deposits balance.
     *         Permissionless after grace period expires.
     */
    function withdraw(bytes32 channelId) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (session.closeRequestedAt == 0) revert TimeoutNotReady();
        if (block.timestamp < session.closeRequestedAt + TIMEOUT_GRACE_PERIOD) revert TimeoutNotReady();

        uint128 refund = session.deposit - session.settled;

        if (refund > 0) {
            usdc.safeTransfer(address(depositsContract), refund);
            depositsContract.creditBuyerRefund(session.buyer, refund);
        }

        session.status = SessionStatus.TimedOut;
        stakingContract.decrementActiveSessions(session.seller);

        // Record ghost
        uint256 agentId = stakingContract.getAgentId(session.seller);
        if (agentId != 0) {
            statsContract.updateStats(agentId, IAntseedStats.StatsUpdate({
                updateType: 1,
                volumeUsdc: 0,
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                requestCount: 0
            }));
        }

        emit SessionTimedOut(channelId, session.buyer);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Temporary storage for platform fee (avoids stack-too-deep in settle/close)
    uint256 private _lastPlatformFee;

    function _distributeDelta(Session storage session, uint128 delta) internal {
        _lastPlatformFee = 0;
        if (delta == 0) return;

        uint256 platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;
        uint256 sellerPayout = uint256(delta) - platformFee;

        if (platformFee > 0 && protocolReserve != address(0)) {
            usdc.safeTransfer(protocolReserve, platformFee);
        } else {
            sellerPayout += platformFee;
        }

        if (sellerPayout > 0) {
            usdc.safeTransfer(address(depositsContract), sellerPayout);
            depositsContract.creditEarnings(session.seller, sellerPayout);
        }

        _lastPlatformFee = platformFee;
    }

    function _recordStatsAndEmissions(
        Session storage session,
        uint128 delta,
        bytes calldata metadata
    ) internal {
        uint256 agentId = stakingContract.getAgentId(session.seller);
        if (agentId != 0) {
            (uint256 inputTokens, uint256 outputTokens, uint256 latencyMs, uint256 requestCount) =
                abi.decode(metadata, (uint256, uint256, uint256, uint256));
            statsContract.updateStats(agentId, IAntseedStats.StatsUpdate({
                updateType: 0,
                volumeUsdc: delta,
                inputTokens: uint128(inputTokens),
                outputTokens: uint128(outputTokens),
                latencyMs: uint64(latencyMs),
                requestCount: uint64(requestCount)
            }));
        }
        if (delta > 0 && address(emissionsContract) != address(0)) {
            emissionsContract.accrueSellerPoints(session.seller, delta);
            emissionsContract.accrueBuyerPoints(session.buyer, delta);
        }
    }

    function _verifyMetadataAuth(
        bytes32 channelId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                METADATA_AUTH_TYPEHASH,
                channelId,
                cumulativeAmount,
                metadataHash
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != buyer) revert InvalidSignature();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setDepositsContract(address _deposits) external onlyOwner {
        if (_deposits == address(0)) revert InvalidAddress();
        depositsContract = IAntseedDeposits(_deposits);
    }

    function setStatsContract(address _stats) external onlyOwner {
        if (_stats == address(0)) revert InvalidAddress();
        statsContract = IAntseedStats(_stats);
    }

    function setEmissionsContract(address _emissions) external onlyOwner {
        emissionsContract = IAntseedEmissions(_emissions);
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
