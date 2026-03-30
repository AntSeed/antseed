// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
 *         USDC stays in AntseedDeposits — this contract holds none.
 *
 *         The buyer signs a single EIP-712 SpendingAuth on every request:
 *         - cumulativeAmount: total USDC authorized so far
 *         - metadataHash: hash of (inputTokens, outputTokens, latencyMs, requestCount)
 *
 *         Money flow:
 *           reserve:  Deposits locks buyer funds
 *           settle:   Deposits charges buyer, credits seller earnings
 *           close:    Deposits charges buyer, credits seller, releases remaining
 *           timeout:  Deposits releases locked funds back to buyer
 *
 *         Contract is swappable: deploy a new version and re-point Deposits + Stats.
 */
contract AntseedSessions is EIP712, Pausable, Ownable, ReentrancyGuard {

    // ─── EIP-712 ─────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    bytes32 public constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );

    bytes32 public constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address operator,uint256 nonce)"
    );

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
    address public protocolReserve;

    mapping(bytes32 => Session) public sessions;

    /// @notice Authorized operator per buyer — can call requestClose, withdraw on buyer's behalf
    mapping(address => address) public operators;
    /// @notice Nonce for SetOperator signatures (replay protection)
    mapping(address => uint256) public operatorNonces;

    // ─── Events ─────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event SessionSettled(bytes32 indexed channelId, address indexed seller, uint128 cumulativeAmount, uint256 platformFee);
    event SessionClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee);
    event SessionTopUp(bytes32 indexed channelId, address indexed buyer, uint128 newMaxAmount);
    event CloseRequested(bytes32 indexed channelId, address indexed buyer);
    event SessionWithdrawn(bytes32 indexed channelId, address indexed buyer);
    event OperatorSet(address indexed buyer, address indexed operator);


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
    error CloseNotReady();
    error CloseAlreadyRequested();
    error InvalidNonce();
    error OperatorAlreadySet();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _deposits,
        address _stats,
        address _staking
    )
        EIP712("AntseedSessions", "7")
        Ownable(msg.sender)
    {
        if (_deposits == address(0) || _stats == address(0) || _staking == address(0))
            revert InvalidAddress();

        depositsContract = IAntseedDeposits(_deposits);
        statsContract = IAntseedStats(_stats);
        stakingContract = IAntseedStaking(_staking);
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
     * @param buyer        The buyer's address (signs SpendingAuth off-chain)
     * @param salt         Random salt for deterministic channel ID
     * @param maxAmount    USDC amount to lock
     * @param deadline     Session deadline (for timeout protection)
     * @param buyerSig     Buyer's SpendingAuth signature (cumAmount=0) as reserve proof
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

        // Verify buyer's ReserveAuth signature — binds channelId, maxAmount, deadline
        _verifyReserveAuth(channelId, maxAmount, deadline, buyer, buyerSig);

        // Lock buyer's USDC in Deposits (stays there, no transfer)
        depositsContract.lockForSession(buyer, maxAmount);

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
    //                        CORE — TOP UP (extend reserve)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Minimum fraction of deposit that must be settled before top-up (85% = 8500 bps).
    uint256 public TOP_UP_SETTLED_THRESHOLD_BPS = 8500;

    error TopUpThresholdNotMet();
    error TopUpAmountTooLow();

    /**
     * @notice Top up an active session by increasing the reserve ceiling.
     *         Seller calls this when the buyer's cumulative spending approaches
     *         the current deposit. Requires at least 85% of the current deposit
     *         to be settled (proven via SpendingAuth) before allowing more funds.
     *
     * @param channelId    Existing session ID
     * @param newMaxAmount New total reserve ceiling (must be > current deposit)
     * @param deadline     New session deadline
     * @param buyerSig     Buyer's ReserveAuth signature for (channelId, newMaxAmount, deadline)
     */
    function topUp(
        bytes32 channelId,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (block.timestamp > deadline) revert SessionExpired();
        if (newMaxAmount <= session.deposit) revert TopUpAmountTooLow();

        // Require at least 85% of current deposit to be settled
        uint256 threshold = (uint256(session.deposit) * TOP_UP_SETTLED_THRESHOLD_BPS) / 10000;
        if (session.settled < threshold) revert TopUpThresholdNotMet();

        // Verify buyer's ReserveAuth signature for the new ceiling
        _verifyReserveAuth(channelId, newMaxAmount, deadline, session.buyer, buyerSig);

        // Lock the additional amount in Deposits
        uint128 additionalAmount = newMaxAmount - session.deposit;
        depositsContract.lockForSession(session.buyer, additionalAmount);

        // Update session
        session.deposit = newMaxAmount;
        session.deadline = deadline;

        emit SessionTopUp(channelId, session.buyer, newMaxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE (mid-session checkpoint)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Settle partial payment. Seller submits buyer's SpendingAuth signature.
     *         The delta USDC is distributed to seller (minus platform fee).
     *         Session stays active for more requests.
     *
     * @param channelId        Session ID
     * @param cumulativeAmount Cumulative USDC amount authorized by buyer
     * @param metadata         ABI-encoded (inputTokens, outputTokens, latencyMs, requestCount)
     * @param buyerSig         Buyer's SpendingAuth EIP-712 signature
     */
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (cumulativeAmount <= session.settled) revert InvalidAmount();
        if (cumulativeAmount > session.deposit) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifySpendingAuth(channelId, cumulativeAmount, metadataHash, session.buyer, buyerSig);

        uint128 delta = cumulativeAmount - session.settled;
        uint256 platformFee = _chargeAndSettle(session, delta, delta);

        session.settled = cumulativeAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;

        _recordStatsAndEmissions(session, delta, metadata, 2); // partial settlement

        emit SessionSettled(channelId, session.seller, cumulativeAmount, platformFee);
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
     * @param buyerSig     Buyer's SpendingAuth EIP-712 signature
     */
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (finalAmount < session.settled) revert FinalAmountBelowSettled();
        if (finalAmount > session.deposit) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifySpendingAuth(channelId, finalAmount, metadataHash, session.buyer, buyerSig);

        uint128 delta = finalAmount - session.settled;
        // Release all remaining reserved: charge delta, un-reserve everything
        uint128 remainingReserved = session.deposit - session.settled;
        uint256 platformFee = _chargeAndSettle(session, delta, remainingReserved);

        session.settled = finalAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;
        session.status = SessionStatus.Settled;
        stakingContract.decrementActiveSessions(session.seller);

        _recordStatsAndEmissions(session, delta, metadata, 0); // session complete

        emit SessionClosed(channelId, session.seller, finalAmount, platformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REQUEST CLOSE + WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request session close. Buyer-only, callable anytime.
     *         Starts a grace period during which the seller can still
     *         call settle() or close() with the latest SpendingAuth.
     *         After the grace period, the buyer can withdraw remaining funds.
     */
    function requestClose(bytes32 channelId) external {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        _requireOperator(session.buyer);
        if (session.closeRequestedAt != 0) revert CloseAlreadyRequested();

        session.closeRequestedAt = block.timestamp;
        emit CloseRequested(channelId, session.buyer);
    }

    /**
     * @notice Withdraw remaining funds after close grace period.
     *         Returns unspent USDC to buyer's Deposits balance.
     *         Buyer-only, after TIMEOUT_GRACE_PERIOD has elapsed since requestClose.
     */
    function withdraw(bytes32 channelId) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        _requireOperator(session.buyer);
        if (session.closeRequestedAt == 0) revert CloseNotReady();
        if (block.timestamp < session.closeRequestedAt + TIMEOUT_GRACE_PERIOD) revert CloseNotReady();

        // Release all remaining reserved back to buyer's available balance
        uint128 remainingReserved = session.deposit - session.settled;
        if (remainingReserved > 0) {
            depositsContract.releaseLock(session.buyer, remainingReserved);
        }

        session.status = SessionStatus.TimedOut;
        stakingContract.decrementActiveSessions(session.seller);

        // Record ghost only if seller never settled anything (true abandonment)
        if (session.settled == 0) {
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
        }

        emit SessionWithdrawn(channelId, session.buyer);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OPERATOR MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set the initial operator for a buyer. Anyone can submit
     *         this tx — authorization comes from the buyer's EIP-712 signature.
     *         Can only be called when no operator is set yet.
     *
     * @param buyer     The buyer address (hot wallet)
     * @param operator  The operator address (funded wallet)
     * @param nonce     Must match buyer's current operatorNonce (replay protection)
     * @param buyerSig  Buyer's EIP-712 SetOperator signature
     */
    function setOperator(
        address buyer,
        address operator,
        uint256 nonce,
        bytes calldata buyerSig
    ) external {
        if (buyer == address(0)) revert InvalidAddress();
        if (operators[buyer] != address(0)) revert OperatorAlreadySet();
        if (nonce != operatorNonces[buyer]) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(SET_OPERATOR_TYPEHASH, operator, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, buyerSig);
        if (recovered != buyer) revert InvalidSignature();

        operatorNonces[buyer] = nonce + 1;
        operators[buyer] = operator;

        emit OperatorSet(buyer, operator);
    }

    /**
     * @notice Transfer operator to a new address. Only the current operator
     *         can call this — like ownership transfer. No buyer signature needed.
     *
     * @param buyer       The buyer whose operator is being transferred
     * @param newOperator The new operator address (address(0) to revoke)
     */
    function transferOperator(
        address buyer,
        address newOperator
    ) external {
        if (msg.sender != operators[buyer]) revert NotAuthorized();

        operators[buyer] = newOperator;

        emit OperatorSet(buyer, newOperator);
    }

    /// @dev Check that msg.sender is the buyer's authorized operator.
    ///      The buyer (hot wallet) is a signer only — it cannot call these functions directly.
    function _requireOperator(address buyer) internal view {
        if (msg.sender != operators[buyer]) revert NotAuthorized();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Charge buyer via Deposits and credit seller earnings.
     * @param delta          USDC amount to charge
     * @param reservedToFree How much of the buyer's reservation to release
     * @return platformFee   The platform fee deducted
     */
    function _chargeAndSettle(
        Session storage session,
        uint128 delta,
        uint128 reservedToFree
    ) internal returns (uint256 platformFee) {
        if (delta == 0 && reservedToFree > 0) {
            // No charge but release lock (e.g., close with no additional spend)
            depositsContract.releaseLock(session.buyer, reservedToFree);
            return 0;
        }
        if (delta == 0) return 0;

        platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;
        if (protocolReserve == address(0)) platformFee = 0;

        depositsContract.chargeAndCreditEarnings(
            session.buyer,
            session.seller,
            delta,
            reservedToFree,
            platformFee,
            protocolReserve
        );
    }

    /// @param statsUpdateType 0 = session complete (close), 1 = ghost, 2 = partial settlement
    function _recordStatsAndEmissions(
        Session storage session,
        uint128 delta,
        bytes calldata metadata,
        uint8 statsUpdateType
    ) internal {
        uint256 agentId = stakingContract.getAgentId(session.seller);
        if (agentId != 0) {
            (uint256 inputTokens, uint256 outputTokens, uint256 latencyMs, uint256 requestCount) =
                abi.decode(metadata, (uint256, uint256, uint256, uint256));
            statsContract.updateStats(agentId, IAntseedStats.StatsUpdate({
                updateType: statsUpdateType,
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

    function _verifyReserveAuth(
        bytes32 channelId,
        uint128 maxAmount,
        uint256 deadline,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                RESERVE_AUTH_TYPEHASH,
                channelId,
                maxAmount,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != buyer) revert InvalidSignature();
    }

    function _verifySpendingAuth(
        bytes32 channelId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
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

    function setFirstSignCap(uint256 value) external onlyOwner {
        FIRST_SIGN_CAP = value;
    }

    function setPlatformFeeBps(uint256 value) external onlyOwner {
        if (value > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
        PLATFORM_FEE_BPS = value;
    }

    function setTopUpSettledThresholdBps(uint256 value) external onlyOwner {
        if (value > 10000) revert InvalidAmount();
        TOP_UP_SETTLED_THRESHOLD_BPS = value;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
