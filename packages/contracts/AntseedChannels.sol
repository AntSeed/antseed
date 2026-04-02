// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";
import {IAntseedEmissions} from "./interfaces/IAntseedEmissions.sol";

/**
 * @title AntseedChannels
 * @notice Channel lifecycle with built-in cumulative payment channels.
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
contract AntseedChannels is EIP712, Pausable, Ownable, ReentrancyGuard {

    // ─── EIP-712 ─────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    bytes32 public constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );

    // ─── Configurable Constants ─────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;
    uint256 public TIMEOUT_GRACE_PERIOD = 15 minutes;

    // ─── Enums & Structs ────────────────────────────────────────────
    enum ChannelStatus { None, Active, Settled, TimedOut }

    struct Channel {
        address buyer;
        address seller;
        uint128 deposit;              // total USDC locked in Deposits for this channel
        uint128 settled;              // last settled cumulative amount
        bytes32 metadataHash;         // latest metadata hash (for auditability)
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;     // timestamp when timeout was requested (0 = not requested)
        ChannelStatus status;
    }

    // ─── Agent Stats ─────────────────────────────────────────────────
    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint64 lastSettledAt;
    }

    uint8 public constant METADATA_VERSION = 1;

    // ─── State Variables ────────────────────────────────────────────
    IAntseedRegistry public registry;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public activeChannelCount;
    mapping(uint256 => AgentStats) private _agentStats;

    // ─── Events ─────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event ChannelSettled(bytes32 indexed channelId, address indexed seller, uint128 cumulativeAmount, uint256 platformFee);
    event ChannelClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee);
    event ChannelTopUp(bytes32 indexed channelId, address indexed buyer, uint128 newMaxAmount);
    event CloseRequested(bytes32 indexed channelId, address indexed buyer);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer);
    /// @notice Per-channel cumulative metrics for off-chain indexing.
    ///         Emitted on every settle and close. metadata is raw bytes —
    ///         decode off-chain based on metadataVersion.
    ///         Buyer-reported (unverifiable) — indexers should filter anomalies.
    event ChannelMetrics(
        bytes32 indexed channelId,
        uint256 indexed agentId,
        address indexed buyer,
        uint8 metadataVersion,
        uint128 cumulativeUsdc,
        bytes metadata
    );

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error ChannelExists();
    error ChannelNotActive();
    error ChannelExpired();
    error NotAuthorized();
    error InvalidFee();
    error FirstSignCapExceeded();
    error SellerNotStaked();
    error FinalAmountBelowSettled();
    error CloseNotReady();
    error CloseAlreadyRequested();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(address _registry)
        EIP712("AntseedChannels", "1")
        Ownable(msg.sender)
    {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
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

    function getAgentStats(uint256 agentId) external view returns (AgentStats memory) {
        return _agentStats[agentId];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESERVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Open a payment channel. Seller calls this.
     *         USDC is pulled from buyer's Deposits balance into this contract.
     *
     * @param buyer        The buyer's address (signs SpendingAuth off-chain)
     * @param salt         Random salt for deterministic channel ID
     * @param maxAmount    USDC amount to lock
     * @param deadline     Channel deadline (for timeout protection)
     * @param buyerSig     Buyer's SpendingAuth signature (cumAmount=0) as reserve proof
     */
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert ChannelExpired();
        if (!IAntseedStaking(registry.staking()).isStakedAboveMin(msg.sender)) revert SellerNotStaked();
        if (maxAmount == 0) revert InvalidAmount();

        bytes32 channelId = computeChannelId(buyer, msg.sender, salt);

        if (channels[channelId].status != ChannelStatus.None) revert ChannelExists();
        if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();

        // Verify buyer's ReserveAuth signature — binds channelId, maxAmount, deadline
        _verifyReserveAuth(channelId, maxAmount, deadline, buyer, buyerSig);

        // Lock buyer's USDC in Deposits (stays there, no transfer)
        IAntseedDeposits(registry.deposits()).lockForChannel(buyer, maxAmount);

        channels[channelId] = Channel({
            buyer: buyer,
            seller: msg.sender,
            deposit: maxAmount,
            settled: 0,
            metadataHash: bytes32(0),
            deadline: deadline,
            settledAt: 0,
            closeRequestedAt: 0,
            status: ChannelStatus.Active
        });

        activeChannelCount[msg.sender]++;
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
     * @notice Top up an active channel by increasing the reserve ceiling.
     *         Seller calls this when the buyer's cumulative spending approaches
     *         the current deposit. Requires at least 85% of the current deposit
     *         to be settled (proven via SpendingAuth) before allowing more funds.
     *
     * @param channelId    Existing channel ID
     * @param newMaxAmount New total reserve ceiling (must be > current deposit)
     * @param deadline     New channel deadline
     * @param buyerSig     Buyer's ReserveAuth signature for (channelId, newMaxAmount, deadline)
     */
    function topUp(
        bytes32 channelId,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (block.timestamp > deadline) revert ChannelExpired();
        if (newMaxAmount <= channel.deposit) revert TopUpAmountTooLow();

        // Require at least 85% of current deposit to be settled
        uint256 threshold = (uint256(channel.deposit) * TOP_UP_SETTLED_THRESHOLD_BPS) / 10000;
        if (channel.settled < threshold) revert TopUpThresholdNotMet();

        // Verify buyer's ReserveAuth signature for the new ceiling
        _verifyReserveAuth(channelId, newMaxAmount, deadline, channel.buyer, buyerSig);

        // Lock the additional amount in Deposits
        uint128 additionalAmount = newMaxAmount - channel.deposit;
        IAntseedDeposits(registry.deposits()).lockForChannel(channel.buyer, additionalAmount);

        // Update channel
        channel.deposit = newMaxAmount;
        channel.deadline = deadline;

        emit ChannelTopUp(channelId, channel.buyer, newMaxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE (mid-channel checkpoint)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Settle partial payment. Seller submits buyer's SpendingAuth signature.
     *         The delta USDC is distributed to seller (minus platform fee).
     *         Channel stays active for more requests.
     *
     * @param channelId        Channel ID
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
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (cumulativeAmount <= channel.settled) revert InvalidAmount();
        if (cumulativeAmount > channel.deposit) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifySpendingAuth(channelId, cumulativeAmount, metadataHash, channel.buyer, buyerSig);

        uint128 delta = cumulativeAmount - channel.settled;
        uint256 platformFee = _chargeAndSettle(channel, delta, delta);

        channel.settled = cumulativeAmount;
        channel.metadataHash = metadataHash;
        channel.settledAt = block.timestamp;

        _emitChannelMetrics(channelId, channel, cumulativeAmount, metadata);
        _recordEmissions(channel, delta);

        emit ChannelSettled(channelId, channel.seller, cumulativeAmount, platformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLOSE (final settle + refund)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Close the channel with a final settlement.
     *         Seller earnings and buyer refund are sent to Deposits.
     *
     * @param channelId    Channel ID
     * @param finalAmount  Final cumulative USDC amount
     * @param metadata     ABI-encoded (inputTokens, outputTokens, latencyMs, requestCount)
     * @param buyerSig     Buyer's SpendingAuth EIP-712 signature
     */
    /**
     * @notice Close the channel with a final settlement.
     *         If finalAmount == channel.settled, no signature is required —
     *         the seller can close without a new SpendingAuth (forfeiting
     *         any unproven spend). Otherwise a buyer SpendingAuth is verified.
     */
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (finalAmount < channel.settled) revert FinalAmountBelowSettled();
        if (finalAmount > channel.deposit) revert InvalidAmount();

        uint128 delta = finalAmount - channel.settled;

        // Only verify signature if there's a new amount to prove
        if (delta > 0) {
            bytes32 metadataHash = keccak256(metadata);
            _verifySpendingAuth(channelId, finalAmount, metadataHash, channel.buyer, buyerSig);
            channel.metadataHash = metadataHash;
        }

        // Release all remaining reserved: charge delta, un-reserve everything
        uint128 remainingReserved = channel.deposit - channel.settled;
        uint256 platformFee = _chargeAndSettle(channel, delta, remainingReserved);

        channel.settled = finalAmount;
        channel.settledAt = block.timestamp;
        channel.status = ChannelStatus.Settled;
        activeChannelCount[channel.seller]--;

        _recordCloseStats(channelId, channel, finalAmount, metadata);
        _recordEmissions(channel, delta);

        emit ChannelClosed(channelId, channel.seller, finalAmount, platformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REQUEST CLOSE + WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request channel close. Buyer-only, callable anytime.
     *         Starts a grace period during which the seller can still
     *         call settle() or close() with the latest SpendingAuth.
     *         After the grace period, the buyer can withdraw remaining funds.
     */
    function requestClose(bytes32 channelId) external {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        _requireOperator(channel.buyer);
        if (channel.closeRequestedAt != 0) revert CloseAlreadyRequested();

        channel.closeRequestedAt = block.timestamp;
        emit CloseRequested(channelId, channel.buyer);
    }

    /**
     * @notice Withdraw remaining funds after close grace period.
     *         Returns unspent USDC to buyer's Deposits balance.
     *         Buyer-only, after TIMEOUT_GRACE_PERIOD has elapsed since requestClose.
     */
    function withdraw(bytes32 channelId) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        _requireOperator(channel.buyer);
        if (channel.closeRequestedAt == 0) revert CloseNotReady();
        if (block.timestamp < channel.closeRequestedAt + TIMEOUT_GRACE_PERIOD) revert CloseNotReady();

        // Release all remaining reserved back to buyer's available balance
        uint128 remainingReserved = channel.deposit - channel.settled;
        if (remainingReserved > 0) {
            IAntseedDeposits(registry.deposits()).releaseLock(channel.buyer, remainingReserved);
        }

        channel.status = ChannelStatus.TimedOut;
        activeChannelCount[channel.seller]--;

        _recordWithdrawStats(channel);

        emit ChannelWithdrawn(channelId, channel.buyer);
    }

    /**
     * @notice Batch request close on multiple channels for a single buyer.
     *         Operator-only. Skips channels that are not active or already closing.
     */
    function requestCloseAll(address buyer, bytes32[] calldata channelIds) external {
        _requireOperator(buyer);
        for (uint256 i = 0; i < channelIds.length; i++) {
            Channel storage channel = channels[channelIds[i]];
            if (channel.buyer != buyer) continue;
            if (channel.status != ChannelStatus.Active) continue;
            if (channel.closeRequestedAt != 0) continue;
            channel.closeRequestedAt = block.timestamp;
            emit CloseRequested(channelIds[i], buyer);
        }
    }

    /**
     * @notice Batch withdraw from multiple channels for a single buyer.
     *         Operator-only. Skips channels not ready for withdrawal.
     */
    function withdrawAll(address buyer, bytes32[] calldata channelIds) external nonReentrant {
        _requireOperator(buyer);
        for (uint256 i = 0; i < channelIds.length; i++) {
            Channel storage channel = channels[channelIds[i]];
            if (channel.buyer != buyer) continue;
            if (channel.status != ChannelStatus.Active) continue;
            if (channel.closeRequestedAt == 0) continue;
            if (block.timestamp < channel.closeRequestedAt + TIMEOUT_GRACE_PERIOD) continue;

            uint128 remainingReserved = channel.deposit - channel.settled;
            if (remainingReserved > 0) {
                IAntseedDeposits(registry.deposits()).releaseLock(buyer, remainingReserved);
            }

            channel.status = ChannelStatus.TimedOut;
            activeChannelCount[channel.seller]--;

            _recordWithdrawStats(channel);

            emit ChannelWithdrawn(channelIds[i], buyer);
        }
    }

    /// @dev Check that msg.sender is the buyer's authorized operator (stored in Deposits).
    function _requireOperator(address buyer) internal view {
        if (msg.sender != IAntseedDeposits(registry.deposits()).getOperator(buyer)) revert NotAuthorized();
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
        Channel storage channel,
        uint128 delta,
        uint128 reservedToFree
    ) internal returns (uint256 platformFee) {
        if (delta == 0 && reservedToFree > 0) {
            // No charge but release lock (e.g., close with no additional spend)
            IAntseedDeposits(registry.deposits()).releaseLock(channel.buyer, reservedToFree);
            return 0;
        }
        if (delta == 0) return 0;

        address _protocolReserve = registry.protocolReserve();
        platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;
        if (_protocolReserve == address(0)) platformFee = 0;

        IAntseedDeposits(registry.deposits()).chargeAndCreditPayouts(
            channel.buyer,
            channel.seller,
            delta,
            reservedToFree,
            platformFee,
            _protocolReserve
        );
    }

    function _emitChannelMetrics(
        bytes32 channelId,
        Channel storage channel,
        uint128 cumulativeUsdc,
        bytes calldata metadata
    ) internal {
        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId != 0) {
            emit ChannelMetrics(channelId, agentId, channel.buyer, METADATA_VERSION, cumulativeUsdc, metadata);
        }
    }

    function _recordCloseStats(
        bytes32 channelId,
        Channel storage channel,
        uint128 cumulativeUsdc,
        bytes calldata metadata
    ) internal {
        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId == 0) return;

        AgentStats storage s = _agentStats[agentId];
        s.channelCount++;
        s.totalVolumeUsdc += cumulativeUsdc;
        s.lastSettledAt = uint64(block.timestamp);

        emit ChannelMetrics(channelId, agentId, channel.buyer, METADATA_VERSION, cumulativeUsdc, metadata);
    }

    function _recordWithdrawStats(Channel storage channel) internal {
        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId == 0) return;

        AgentStats storage s = _agentStats[agentId];
        if (channel.settled == 0) {
            // True ghost — seller never settled
            s.ghostCount++;
        } else {
            // Partial-settled timeout — count as completed, record volume
            s.channelCount++;
            s.totalVolumeUsdc += channel.settled;
            s.lastSettledAt = uint64(block.timestamp);
        }
    }

    function _recordEmissions(Channel storage channel, uint128 delta) internal {
        address _emissions = registry.emissions();
        if (delta > 0 && _emissions != address(0)) {
            IAntseedEmissions(_emissions).accrueSellerPoints(channel.seller, delta);
            IAntseedEmissions(_emissions).accrueBuyerPoints(channel.buyer, delta);
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

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
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
