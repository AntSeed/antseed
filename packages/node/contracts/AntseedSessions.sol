// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITempoStreamChannel} from "./vendor/ITempoStreamChannel.sol";
import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
import {IAntseedIdentity} from "./interfaces/IAntseedIdentity.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";

/**
 * @title AntseedSessions
 * @notice Session lifecycle wrapping Tempo's StreamChannel for payments.
 *         All USDC flows through Tempo's audited escrow contract.
 *         This contract adds AntSeed metadata signing + reputation on top.
 *
 *         Architecture:
 *         - This contract is the **payer** on all Tempo channels (deposits USDC into Tempo).
 *         - This contract is also the **payee** on all Tempo channels (receives settled USDC).
 *         - The buyer's EVM address is set as the `authorizedSigner` (signs Tempo vouchers off-chain).
 *         - On settle/close, USDC arrives here and is forwarded to seller (via Deposits earnings)
 *           and refunded to buyer (via Deposits creditBuyerRefund).
 *
 *         Money flow:
 *           reserve:  Deposits → Sessions → Tempo channel (escrow)
 *           settle:   Tempo channel → Sessions → Deposits (seller earnings)
 *           close:    Tempo channel → Sessions → Deposits (seller earnings + buyer refund)
 *           withdraw: Tempo channel → Sessions → Deposits (buyer refund)
 *
 *         The buyer also signs an AntSeed MetadataAuth (separate EIP-712 domain) that
 *         attests to token counts for reputation tracking.
 *
 *         Contract is swappable: deploy a new version and re-point Deposits + Identity.
 */
contract AntseedSessions is EIP712, Pausable, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── EIP-712 (AntSeed metadata domain) ────────────────────────────
    bytes32 public constant METADATA_AUTH_TYPEHASH = keccak256(
        "MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    // ─── Constant Keys for setConstant ────────────────────────────────
    bytes32 private constant KEY_FIRST_SIGN_CAP = keccak256("FIRST_SIGN_CAP");
    bytes32 private constant KEY_PLATFORM_FEE_BPS = keccak256("PLATFORM_FEE_BPS");

    // ─── Configurable Constants ───────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public PLATFORM_FEE_BPS = 500;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;

    // ─── Enums & Structs ──────────────────────────────────────────────
    enum SessionStatus { None, Active, Settled, TimedOut }

    struct Session {
        address buyer;
        address seller;
        uint128 deposit;              // total USDC locked from Deposits into Tempo
        uint128 settled;              // last settled cumulative amount
        bytes32 metadataHash;         // latest metadata hash (for auditability)
        uint256 deadline;
        uint256 settledAt;
        SessionStatus status;
    }

    // ─── State Variables ──────────────────────────────────────────────
    ITempoStreamChannel public streamChannel;
    IAntseedDeposits public depositsContract;
    IAntseedIdentity public identityContract;
    IAntseedStaking public stakingContract;
    IERC20 public usdc;
    address public protocolReserve;

    mapping(bytes32 => Session) public sessions;

    // ─── Events ───────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event SessionSettled(bytes32 indexed channelId, address indexed seller, uint128 cumulativeAmount, uint256 platformFee);
    event SessionClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee);
    event SessionCloseRequested(bytes32 indexed channelId);
    event SessionWithdrawn(bytes32 indexed channelId, address indexed buyer);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ────────────────────────────────────────────────
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

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(
        address _streamChannel,
        address _deposits,
        address _identity,
        address _staking,
        address _usdc
    )
        EIP712("AntseedSessions", "5")
        Ownable(msg.sender)
    {
        if (_streamChannel == address(0) || _deposits == address(0) ||
            _identity == address(0) || _staking == address(0) || _usdc == address(0))
            revert InvalidAddress();

        streamChannel = ITempoStreamChannel(_streamChannel);
        depositsContract = IAntseedDeposits(_deposits);
        identityContract = IAntseedIdentity(_identity);
        stakingContract = IAntseedStaking(_staking);
        usdc = IERC20(_usdc);
    }

    // ─── Domain Separator Helper ──────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESERVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Open a Tempo payment channel for a session.
     *         Seller calls this. USDC is pulled from Deposits → Sessions → Tempo.
     *
     *         On the Tempo channel:
     *         - payer = this contract (deposits USDC into escrow)
     *         - payee = this contract (receives USDC on settle/close)
     *         - authorizedSigner = buyer (signs Tempo vouchers off-chain)
     *
     * @param buyer          The buyer's address (authorizedSigner on Tempo channel)
     * @param salt           Random salt for deterministic channel ID
     * @param maxAmount      USDC amount to lock (pulled from buyer's Deposits balance)
     * @param deadline       Session deadline (for timeout protection)
     * @param buyerMetaSig   Buyer's MetadataAuth signature (cumAmount=0) as reserve proof
     */
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerMetaSig
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert SessionExpired();
        if (!stakingContract.isStakedAboveMin(msg.sender)) revert SellerNotStaked();
        if (maxAmount == 0) revert InvalidAmount();

        // Compute the channel ID that Tempo will produce
        // payer = this, payee = this, token = usdc, authorizedSigner = buyer
        bytes32 channelId = streamChannel.computeChannelId(
            address(this),
            address(this),
            address(usdc),
            salt,
            buyer
        );

        if (sessions[channelId].status != SessionStatus.None) revert SessionExists();
        if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();

        // Verify buyer MetadataAuth signature (cumulativeAmount=0, empty metadata = reserve proof)
        bytes32 zeroMetadataHash = keccak256(abi.encode(uint256(0), uint256(0), uint256(0), uint256(0)));
        _verifyMetadataAuth(channelId, 0, zeroMetadataHash, buyer, buyerMetaSig);

        // Pull USDC from Deposits → this contract
        depositsContract.lockForSession(buyer, maxAmount);
        depositsContract.transferToSessions(buyer, address(this), maxAmount);

        // Approve Tempo and open channel (this contract is both payer and payee)
        usdc.approve(address(streamChannel), maxAmount);
        streamChannel.open(address(this), address(usdc), maxAmount, salt, buyer);

        // Store session (seller tracked here, not on Tempo)
        sessions[channelId] = Session({
            buyer: buyer,
            seller: msg.sender,
            deposit: maxAmount,
            settled: 0,
            metadataHash: bytes32(0),
            deadline: deadline,
            settledAt: 0,
            status: SessionStatus.Active
        });

        stakingContract.incrementActiveSessions(msg.sender);
        emit Reserved(channelId, buyer, msg.sender, maxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — TOP UP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Add more USDC to an existing Tempo channel.
     * @param channelId         The Tempo channel ID (also our session key)
     * @param additionalAmount  Additional USDC to lock
     */
    function topUp(bytes32 channelId, uint128 additionalAmount) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();
        if (block.timestamp > session.deadline) revert SessionExpired();
        if (additionalAmount == 0) revert InvalidAmount();

        depositsContract.lockForSession(session.buyer, additionalAmount);
        depositsContract.transferToSessions(session.buyer, address(this), additionalAmount);

        usdc.approve(address(streamChannel), additionalAmount);
        streamChannel.topUp(channelId, additionalAmount);

        session.deposit += additionalAmount;
        emit Reserved(channelId, session.buyer, session.seller, session.deposit);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE (mid-session checkpoint)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Settle partial payment via Tempo + update AntSeed reputation.
     *         Seller submits two buyer signatures:
     *         1. Tempo voucher sig (authorizes USDC transfer via Tempo)
     *         2. AntSeed MetadataAuth sig (attests to token counts for reputation)
     *
     *         Tempo's settle() transfers the delta to this contract (we are payee).
     *         We then forward seller payout to Deposits as earnings.
     *         Channel stays open for more requests.
     *
     * @param channelId        The Tempo channel / session ID
     * @param cumulativeAmount Cumulative USDC amount (Tempo voucher)
     * @param metadata         ABI-encoded (inputTokens, outputTokens, 0, 0)
     * @param tempoVoucherSig  Buyer's Tempo Voucher EIP-712 signature
     * @param metadataAuthSig  Buyer's AntSeed MetadataAuth EIP-712 signature
     */
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata tempoVoucherSig,
        bytes calldata metadataAuthSig
    ) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();

        // Verify AntSeed MetadataAuth signature
        bytes32 metadataHash = keccak256(metadata);
        _verifyMetadataAuth(channelId, cumulativeAmount, metadataHash, session.buyer, metadataAuthSig);

        // Cache pre-settle amount for delta computation
        uint128 prevSettled = session.settled;

        // Call Tempo settle — delta USDC is transferred to this contract (we are payee)
        streamChannel.settle(channelId, cumulativeAmount, tempoVoucherSig);

        // Compute delta and distribute
        uint128 delta = cumulativeAmount - prevSettled;
        uint256 platformFee = 0;
        if (delta > 0) {
            platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;
            uint256 sellerPayout = uint256(delta) - platformFee;

            // Send platform fee to protocol reserve
            if (platformFee > 0 && protocolReserve != address(0)) {
                usdc.safeTransfer(protocolReserve, platformFee);
            }

            // Forward seller payout to Deposits and credit earnings
            if (sellerPayout > 0) {
                usdc.safeTransfer(address(depositsContract), sellerPayout);
                depositsContract.creditEarnings(session.seller, sellerPayout);
            }
        }

        // Update session state
        session.settled = cumulativeAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;

        // Update Identity reputation — decode tokens from metadata
        uint256 sellerTokenId = identityContract.getTokenId(session.seller);
        if (sellerTokenId != 0) {
            (uint256 inputTokens, uint256 outputTokens,,) = abi.decode(metadata, (uint256, uint256, uint256, uint256));
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({
                    updateType: 0,
                    settledVolume: delta,
                    inputTokens: uint128(inputTokens),
                    outputTokens: uint128(outputTokens)
                })
            );
        }

        emit SessionSettled(channelId, session.seller, cumulativeAmount, platformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLOSE (final settle)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Close the Tempo channel with a final settlement.
     *         Tempo sends settled USDC + refund back to this contract.
     *         We distribute: seller earnings → Deposits, buyer refund → Deposits.
     *
     * @param channelId        The Tempo channel / session ID
     * @param finalAmount      Final cumulative USDC amount
     * @param metadata         ABI-encoded (inputTokens, outputTokens, 0, 0)
     * @param tempoVoucherSig  Buyer's Tempo Voucher EIP-712 signature
     * @param metadataAuthSig  Buyer's AntSeed MetadataAuth EIP-712 signature
     */
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata tempoVoucherSig,
        bytes calldata metadataAuthSig
    ) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (msg.sender != session.seller) revert NotAuthorized();

        // Verify AntSeed MetadataAuth signature
        bytes32 metadataHash = keccak256(metadata);
        _verifyMetadataAuth(channelId, finalAmount, metadataHash, session.buyer, metadataAuthSig);

        // Decode metadata for reputation
        // Call Tempo close — all USDC (settled delta + refund) comes back to this contract
        streamChannel.close(channelId, finalAmount, tempoVoucherSig);

        // Compute amounts
        uint128 delta = finalAmount > session.settled ? finalAmount - session.settled : 0;
        uint128 refund = session.deposit - finalAmount;

        // Distribute seller payout from delta
        uint256 platformFee = 0;
        if (delta > 0) {
            platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;
            uint256 sellerPayout = uint256(delta) - platformFee;

            if (platformFee > 0 && protocolReserve != address(0)) {
                usdc.safeTransfer(protocolReserve, platformFee);
            }

            if (sellerPayout > 0) {
                usdc.safeTransfer(address(depositsContract), sellerPayout);
                depositsContract.creditEarnings(session.seller, sellerPayout);
            }
        }

        // Return refund to buyer's Deposits balance
        if (refund > 0) {
            usdc.safeTransfer(address(depositsContract), refund);
            depositsContract.creditBuyerRefund(session.buyer, refund);
        }

        // Update session state
        session.settled = finalAmount;
        session.metadataHash = metadataHash;
        session.settledAt = block.timestamp;
        session.status = SessionStatus.Settled;
        stakingContract.decrementActiveSessions(session.seller);

        // Update Identity reputation — decode tokens from metadata
        uint256 sellerTokenId = identityContract.getTokenId(session.seller);
        if (sellerTokenId != 0) {
            (uint256 inputTokens, uint256 outputTokens,,) = abi.decode(metadata, (uint256, uint256, uint256, uint256));
            identityContract.updateReputation(
                sellerTokenId,
                IAntseedIdentity.ReputationUpdate({
                    updateType: 0,
                    settledVolume: finalAmount,
                    inputTokens: uint128(inputTokens),
                    outputTokens: uint128(outputTokens)
                })
            );
        }

        emit SessionClosed(channelId, session.seller, finalAmount, platformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  TIMEOUT — REQUEST CLOSE + WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request Tempo channel closure. Starts Tempo's 15-min grace period.
     *         Permissionless after session deadline — anyone can call.
     *         This contract is the payer on Tempo, so requestClose() works.
     */
    function requestClose(bytes32 channelId) external {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();
        if (block.timestamp <= session.deadline) revert NotAuthorized();

        streamChannel.requestClose(channelId);
        emit SessionCloseRequested(channelId);
    }

    /**
     * @notice Withdraw remaining funds after Tempo's grace period expires.
     *         Returns all unspent USDC to buyer's Deposits balance.
     *         Permissionless — anyone can call once Tempo allows withdrawal.
     */
    function withdraw(bytes32 channelId) external nonReentrant {
        Session storage session = sessions[channelId];
        if (session.status != SessionStatus.Active) revert SessionNotActive();

        uint128 deposit = session.deposit;
        uint128 settled = session.settled;
        address buyer = session.buyer;

        // Call Tempo withdraw — unspent USDC returns to this contract (payer)
        streamChannel.withdraw(channelId);

        uint128 refund = deposit - settled;

        // Return refund to buyer's Deposits balance
        if (refund > 0) {
            usdc.safeTransfer(address(depositsContract), refund);
            depositsContract.creditBuyerRefund(buyer, refund);
        }

        session.status = SessionStatus.TimedOut;
        stakingContract.decrementActiveSessions(session.seller);

        emit SessionWithdrawn(channelId, buyer);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

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

    function setStreamChannel(address _streamChannel) external onlyOwner {
        if (_streamChannel == address(0)) revert InvalidAddress();
        streamChannel = ITempoStreamChannel(_streamChannel);
    }

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
