// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedStaking} from "../interfaces/IAntseedStaking.sol";
import {IAntseedStats} from "../interfaces/IAntseedStats.sol";
import {IAntseedFreeUsage} from "../interfaces/IAntseedFreeUsage.sol";

/**
 * @title AntseedFreeUsage
 * @notice Free usage channel lifecycle with buyer-signed EIP-712 usage proofs.
 *         This contract holds no funds and never charges the buyer. It records
 *         signed usage metadata for seller/buyer auditability and can
 *         optionally forward metadata into AntseedStats when authorized there.
 *         Metadata is opaque to this contract; indexers parse the raw bytes.
 */
contract AntseedFreeUsage is IAntseedFreeUsage, EIP712, Pausable, Ownable, ReentrancyGuard {
    // ─── EIP-712 ─────────────────────────────────────────────────────
    bytes32 public constant FREE_USAGE_CHANNEL_DOMAIN = keccak256("ANTSEED_FREE_USAGE_CHANNEL");

    bytes32 public constant FREE_USAGE_OPEN_TYPEHASH = keccak256(
        "FreeUsageOpen(bytes32 channelId,uint256 deadline)"
    );

    bytes32 public constant FREE_USAGE_AUTH_TYPEHASH = keccak256(
        "FreeUsageAuth(bytes32 channelId,uint256 sequence,bytes32 metadataHash,uint256 deadline)"
    );

    // ─── Structs ────────────────────────────────────────────────────
    struct Channel {
        address buyer;
        address seller;
        uint256 latestSequence;
        bytes32 metadataHash;
        uint256 deadline;
        uint256 updatedAt;
        uint256 closedAt;
        ChannelStatus status;
    }

    // ─── State ──────────────────────────────────────────────────────
    IAntseedRegistry public registry;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public override activeChannelCount;
    mapping(uint256 => AgentStats) private _agentStats;

    // ─── Events ─────────────────────────────────────────────────────
    event FreeUsageOpened(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 deadline);
    event FreeUsageRecorded(
        bytes32 indexed channelId,
        address indexed buyer,
        address indexed seller,
        uint256 sequence,
        bytes metadata
    );
    event FreeUsageClosed(bytes32 indexed channelId, address indexed buyer, address indexed seller);

    // ─── Errors ─────────────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error ChannelExists();
    error ChannelNotActive();
    error ChannelExpired();
    error NotAuthorized();
    error SellerNotStaked();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(address _registry)
        EIP712("AntseedFreeUsage", "1")
        Ownable(msg.sender)
    {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    // ─── Views ──────────────────────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function computeChannelId(address buyer, address seller, bytes32 salt) public pure override returns (bytes32) {
        return keccak256(abi.encode(FREE_USAGE_CHANNEL_DOMAIN, buyer, seller, salt));
    }

    function getAgentStats(uint256 agentId) external view override returns (AgentStats memory) {
        return _agentStats[agentId];
    }

    // ─── Core ───────────────────────────────────────────────────────
    function open(
        address buyer,
        bytes32 salt,
        uint256 deadline,
        bytes calldata buyerSig
    ) external override nonReentrant whenNotPaused {
        if (buyer == address(0)) revert InvalidAddress();
        if (block.timestamp > deadline) revert ChannelExpired();
        if (!IAntseedStaking(registry.staking()).isStakedAboveMin(msg.sender)) revert SellerNotStaked();

        bytes32 channelId = computeChannelId(buyer, msg.sender, salt);
        if (channels[channelId].status != ChannelStatus.None) revert ChannelExists();

        _verifyOpenAuth(channelId, deadline, buyer, buyerSig);

        channels[channelId] = Channel({
            buyer: buyer,
            seller: msg.sender,
            latestSequence: 0,
            metadataHash: bytes32(0),
            deadline: deadline,
            updatedAt: 0,
            closedAt: 0,
            status: ChannelStatus.Active
        });

        activeChannelCount[msg.sender]++;

        emit FreeUsageOpened(channelId, buyer, msg.sender, deadline);
    }

    function record(
        bytes32 channelId,
        uint256 sequence,
        bytes calldata metadata,
        uint256 deadline,
        bytes calldata buyerSig
    ) external override nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();

        _recordUsage(channelId, channel, sequence, metadata, deadline, buyerSig, false);
    }

    function close(
        bytes32 channelId,
        uint256 sequence,
        bytes calldata metadata,
        uint256 deadline,
        bytes calldata buyerSig
    ) external override nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();

        _recordUsage(channelId, channel, sequence, metadata, deadline, buyerSig, true);

        channel.status = ChannelStatus.Closed;
        channel.closedAt = block.timestamp;
        activeChannelCount[channel.seller]--;

        emit FreeUsageClosed(channelId, channel.buyer, channel.seller);
    }

    // ─── Internal Helpers ───────────────────────────────────────────
    function _recordUsage(
        bytes32 channelId,
        Channel storage channel,
        uint256 sequence,
        bytes calldata metadata,
        uint256 deadline,
        bytes calldata buyerSig,
        bool allowSameSequence
    ) internal {
        if (block.timestamp > channel.deadline || block.timestamp > deadline) revert ChannelExpired();

        if (sequence < channel.latestSequence) revert InvalidAmount();
        if (!allowSameSequence && sequence == channel.latestSequence) revert InvalidAmount();

        bytes32 metadataHash = keccak256(metadata);
        _verifyUsageAuth(channelId, sequence, metadataHash, deadline, channel.buyer, buyerSig);

        uint256 sequenceDelta = sequence - channel.latestSequence;
        bool firstUsage = channel.updatedAt == 0 && sequence > 0;

        channel.latestSequence = sequence;
        channel.metadataHash = metadataHash;
        channel.updatedAt = block.timestamp;

        if (sequenceDelta > 0) {
            uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
            if (agentId > 0) {
                AgentStats storage s = _agentStats[agentId];
                if (firstUsage) {
                    s.channelCount++;
                }
                s.lastSettledAt = uint64(block.timestamp);
                _syncExternalMetadata(agentId, channel.buyer, channelId, metadata);
            }
        }

        emit FreeUsageRecorded(
            channelId,
            channel.buyer,
            channel.seller,
            sequence,
            metadata
        );
    }

    function _syncExternalMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        bytes calldata metadata
    ) internal {
        address statsContract = registry.stats();
        if (statsContract == address(0)) return;
        try IAntseedStats(statsContract).recordMetadata(agentId, buyer, channelId, metadata) {}
        catch {}
    }

    function _verifyOpenAuth(
        bytes32 channelId,
        uint256 deadline,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(FREE_USAGE_OPEN_TYPEHASH, channelId, deadline));
        _verifySignature(structHash, signature, buyer);
    }

    function _verifyUsageAuth(
        bytes32 channelId,
        uint256 sequence,
        bytes32 metadataHash,
        uint256 deadline,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(FREE_USAGE_AUTH_TYPEHASH, channelId, sequence, metadataHash, deadline)
        );
        _verifySignature(structHash, signature, buyer);
    }

    function _verifySignature(
        bytes32 structHash,
        bytes calldata signature,
        address signer
    ) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer) revert InvalidSignature();
    }

    // ─── Admin ──────────────────────────────────────────────────────
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
