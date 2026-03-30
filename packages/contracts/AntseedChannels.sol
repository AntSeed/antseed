// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";
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

    bytes32 public constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address operator,uint256 nonce)"
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
        uint128 deposit;              // total USDC escrowed in this contract
        uint128 settled;              // last settled cumulative amount
        bytes32 metadataHash;         // latest metadata hash (for auditability)
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;     // timestamp when timeout was requested (0 = not requested)
        ChannelStatus status;
    }

    // ─── State Variables ────────────────────────────────────────────
    IAntseedRegistry public registry;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public activeChannelCount;

    // ─── Events ─────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event ChannelSettled(bytes32 indexed channelId, address indexed seller, uint128 cumulativeAmount, uint256 platformFee);
    event ChannelClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee);
    event ChannelTopUp(bytes32 indexed channelId, address indexed buyer, uint128 newMaxAmount);
    event CloseRequested(bytes32 indexed channelId, address indexed buyer);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer);
    event OperatorSet(address indexed buyer, address indexed operator);


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
    error InvalidNonce();
    error OperatorAlreadySet();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(address _registry)
        EIP712("AntseedChannels", "7")
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

        _recordStatsAndEmissions(channel, delta, metadata, 2); // partial settlement

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

        bytes32 metadataHash = keccak256(metadata);
        _verifySpendingAuth(channelId, finalAmount, metadataHash, channel.buyer, buyerSig);

        uint128 delta = finalAmount - channel.settled;
        // Release all remaining reserved: charge delta, un-reserve everything
        uint128 remainingReserved = channel.deposit - channel.settled;
        uint256 platformFee = _chargeAndSettle(channel, delta, remainingReserved);

        channel.settled = finalAmount;
        channel.metadataHash = metadataHash;
        channel.settledAt = block.timestamp;
        channel.status = ChannelStatus.Settled;
        activeChannelCount[channel.seller]--;

        _recordStatsAndEmissions(channel, delta, metadata, 0); // channel complete

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

        // Record ghost only if seller never settled anything (true abandonment)
        if (channel.settled == 0) {
            uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
            if (agentId != 0) {
                IAntseedStats(registry.stats()).updateStats(agentId, IAntseedStats.StatsUpdate({
                    updateType: 1,
                    volumeUsdc: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    latencyMs: 0,
                    requestCount: 0
                }));
            }
        }

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

            if (channel.settled == 0) {
                uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
                if (agentId != 0) {
                    IAntseedStats(registry.stats()).updateStats(agentId, IAntseedStats.StatsUpdate({
                        updateType: 1, volumeUsdc: 0, inputTokens: 0,
                        outputTokens: 0, latencyMs: 0, requestCount: 0
                    }));
                }
            }

            emit ChannelWithdrawn(channelIds[i], buyer);
        }
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
        if (buyer == address(0) || operator == address(0)) revert InvalidAddress();
        address currentOp = IAntseedDeposits(registry.deposits()).getOperator(buyer);
        if (currentOp != address(0)) revert OperatorAlreadySet();
        uint256 currentNonce = IAntseedDeposits(registry.deposits()).getOperatorNonce(buyer);
        if (nonce != currentNonce) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(SET_OPERATOR_TYPEHASH, operator, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, buyerSig);
        if (recovered != buyer) revert InvalidSignature();

        IAntseedDeposits(registry.deposits()).setOperatorFor(buyer, operator);

        emit OperatorSet(buyer, operator);
    }

    /**
     * @notice Transfer operator to a new address. Only the current operator
     *         can call this — like ownership transfer. No buyer signature needed.
     */
    function transferOperator(
        address buyer,
        address newOperator
    ) external {
        if (msg.sender != IAntseedDeposits(registry.deposits()).getOperator(buyer)) revert NotAuthorized();

        IAntseedDeposits(registry.deposits()).setOperatorFor(buyer, newOperator);

        emit OperatorSet(buyer, newOperator);
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

    /// @param statsUpdateType 0 = channel complete (close), 1 = ghost, 2 = partial settlement
    function _recordStatsAndEmissions(
        Channel storage channel,
        uint128 delta,
        bytes calldata metadata,
        uint8 statsUpdateType
    ) internal {
        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId != 0) {
            (uint256 inputTokens, uint256 outputTokens, uint256 latencyMs, uint256 requestCount) =
                abi.decode(metadata, (uint256, uint256, uint256, uint256));
            IAntseedStats(registry.stats()).updateStats(agentId, IAntseedStats.StatsUpdate({
                updateType: statsUpdateType,
                volumeUsdc: delta,
                inputTokens: uint128(inputTokens),
                outputTokens: uint128(outputTokens),
                latencyMs: uint64(latencyMs),
                requestCount: uint64(requestCount)
            }));
        }
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
