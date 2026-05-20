// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";
import {IAntseedUsageVerification} from "./interfaces/IAntseedUsageVerification.sol";

interface IAntseedChannelsUsageView {
    function channels(bytes32 channelId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint128 deposit,
            uint128 settled,
            bytes32 metadataHash,
            uint256 deadline,
            uint256 settledAt,
            uint256 closeRequestedAt,
            uint8 status
        );
}

/**
 * @title AntseedUsageVerification
 * @notice No-funds service-scoped usage fact layer for AntSeed requests.
 *         Buyers and sellers commit to hidden reveal packages for a cumulative
 *         channel/service snapshot in the current epoch, then either party can
 *         reveal once enough payment has settled on AntseedChannels.
 */
contract AntseedUsageVerification is IAntseedUsageVerification, EIP712, Pausable, Ownable, ReentrancyGuard {
    uint256 public constant CLAIM_VERSION = 1;
    uint8 public constant PARTY_BUYER = 1;
    uint8 public constant PARTY_SELLER = 2;

    bytes32 public constant USAGE_COMMIT_TYPEHASH = keccak256(
        "UsageCommit(bytes32 claimHash,bytes32 revealHash,uint256 expectedEpoch,uint8 party)"
    );

    bytes32 public constant USAGE_CLAIM_TYPEHASH = keccak256(
        "UsageClaim(uint256 version,bytes32 channelId,address buyer,address seller,uint256 sellerAgentId,bytes32 serviceKey,string providerName,string serviceName,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeFreshInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeCostUsdc,uint256 paymentCumulativeAmount)"
    );

    struct CommitPairInput {
        bytes32 claimHash;
        bytes32 channelId;
        address buyer;
        address seller;
        uint256 sellerAgentId;
        bytes32 serviceKey;
        bytes32 buyerRevealHash;
        bytes32 sellerRevealHash;
        uint256 expectedEpoch;
        bytes buyerSig;
        bytes sellerSig;
    }

    struct UsageSnapshot {
        uint256 inputTokens;
        uint256 cachedInputTokens;
        uint256 freshInputTokens;
        uint256 outputTokens;
        uint256 requestCount;
        uint256 costUsdc;
    }

    struct StoredCommit {
        uint256 epoch;
        bytes32 channelId;
        address buyer;
        address seller;
        uint256 sellerAgentId;
        bytes32 serviceKey;
        bytes32 buyerRevealHash;
        bytes32 sellerRevealHash;
        bool revealed;
        bool buyerPartiallyRevealed;
        bool sellerPartiallyRevealed;
    }

    IAntseedRegistry public registry;
    uint256 public immutable genesis;
    uint256 public immutable EPOCH_DURATION;

    mapping(bytes32 => StoredCommit) public commits;
    mapping(bytes32 => UsageSnapshot) private _snapshots;
    mapping(uint256 => mapping(bytes32 => mapping(uint256 => UsageStats))) private _sellerServiceStats;
    mapping(address => mapping(bytes32 => mapping(uint256 => UsageStats))) private _buyerServiceStats;
    mapping(uint256 => mapping(bytes32 => UsageStats)) private _sellerServiceLifetimeStats;
    mapping(address => mapping(bytes32 => UsageStats)) private _buyerServiceLifetimeStats;

    event UsageCommitted(
        bytes32 indexed claimHash,
        bytes32 indexed channelId,
        bytes32 indexed serviceKey,
        uint256 epoch,
        address buyer,
        address seller,
        uint256 sellerAgentId
    );
    event UsageRevealed(
        bytes32 indexed claimHash,
        bytes32 indexed channelId,
        bytes32 indexed serviceKey,
        uint256 epoch,
        address buyer,
        address seller,
        uint256 sellerAgentId,
        string providerName,
        string serviceName,
        uint256 inputTokensDelta,
        uint256 cachedInputTokensDelta,
        uint256 freshInputTokensDelta,
        uint256 outputTokensDelta,
        uint256 requestCountDelta,
        uint256 costUsdcDelta,
        uint256 paymentCumulativeAmount
    );
    event UsagePartialReveal(
        bytes32 indexed claimHash,
        bytes32 indexed channelId,
        bytes32 indexed serviceKey,
        uint256 epoch,
        uint8 party
    );

    error InvalidAddress();
    error InvalidValue();
    error InvalidEpoch();
    error InvalidSignature();
    error InvalidCommit();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error NonMonotonicClaim();
    error PaymentNotCovered();
    error ChannelMismatch();
    error SellerAgentMismatch();

    constructor(address _registry, uint256 _genesis, uint256 _epochDuration)
        EIP712("AntseedUsageVerification", "1")
        Ownable(msg.sender)
    {
        if (_registry == address(0)) revert InvalidAddress();
        if (_epochDuration == 0) revert InvalidValue();
        registry = IAntseedRegistry(_registry);
        genesis = _genesis;
        EPOCH_DURATION = _epochDuration;
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp < genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashUsageClaim(UsageClaim calldata claim) public pure returns (bytes32) {
        return keccak256(abi.encode(
            USAGE_CLAIM_TYPEHASH,
            claim.version,
            claim.channelId,
            claim.buyer,
            claim.seller,
            claim.sellerAgentId,
            claim.serviceKey,
            keccak256(bytes(claim.providerName)),
            keccak256(bytes(claim.serviceName)),
            claim.cumulativeInputTokens,
            claim.cumulativeCachedInputTokens,
            claim.cumulativeFreshInputTokens,
            claim.cumulativeOutputTokens,
            claim.cumulativeRequestCount,
            claim.cumulativeCostUsdc,
            claim.paymentCumulativeAmount
        ));
    }

    function revealHash(bytes32 claimHash, bytes32 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(claimHash, nonce));
    }

    function getSellerServiceStats(uint256 sellerAgentId, bytes32 serviceKey, uint256 epoch)
        external
        view
        returns (UsageStats memory)
    {
        return _sellerServiceStats[sellerAgentId][serviceKey][epoch];
    }

    function getBuyerServiceStats(address buyer, bytes32 serviceKey, uint256 epoch)
        external
        view
        returns (UsageStats memory)
    {
        return _buyerServiceStats[buyer][serviceKey][epoch];
    }

    function getSellerServiceLifetimeStats(uint256 sellerAgentId, bytes32 serviceKey)
        external
        view
        returns (UsageStats memory)
    {
        return _sellerServiceLifetimeStats[sellerAgentId][serviceKey];
    }

    function getBuyerServiceLifetimeStats(address buyer, bytes32 serviceKey)
        external
        view
        returns (UsageStats memory)
    {
        return _buyerServiceLifetimeStats[buyer][serviceKey];
    }

    function commitPair(CommitPairInput calldata input) external whenNotPaused {
        if (input.buyer == address(0) || input.seller == address(0)) revert InvalidAddress();
        if (input.claimHash == bytes32(0) || input.serviceKey == bytes32(0)) revert InvalidValue();
        if (input.expectedEpoch != currentEpoch()) revert InvalidEpoch();
        if (commits[input.claimHash].epoch != 0 || commits[input.claimHash].buyer != address(0)) revert AlreadyCommitted();

        _verifyCommit(input.claimHash, input.buyerRevealHash, input.expectedEpoch, PARTY_BUYER, input.buyer, input.buyerSig);
        _verifyCommit(input.claimHash, input.sellerRevealHash, input.expectedEpoch, PARTY_SELLER, input.seller, input.sellerSig);

        commits[input.claimHash] = StoredCommit({
            epoch: input.expectedEpoch,
            channelId: input.channelId,
            buyer: input.buyer,
            seller: input.seller,
            sellerAgentId: input.sellerAgentId,
            serviceKey: input.serviceKey,
            buyerRevealHash: input.buyerRevealHash,
            sellerRevealHash: input.sellerRevealHash,
            revealed: false,
            buyerPartiallyRevealed: false,
            sellerPartiallyRevealed: false
        });

        emit UsageCommitted(
            input.claimHash,
            input.channelId,
            input.serviceKey,
            input.expectedEpoch,
            input.buyer,
            input.seller,
            input.sellerAgentId
        );
    }

    function revealPair(UsageClaim calldata claim, bytes32 buyerNonce, bytes32 sellerNonce)
        external
        nonReentrant
        whenNotPaused
    {
        bytes32 claimHash = hashUsageClaim(claim);
        StoredCommit storage stored = commits[claimHash];
        _validateReveal(stored, claim, claimHash, buyerNonce, sellerNonce);
        stored.revealed = true;

        _verifyPaymentCoverage(claim);
        UsageSnapshot memory delta = _applySnapshotDelta(stored.epoch, claim);
        _addStats(_sellerServiceStats[claim.sellerAgentId][claim.serviceKey][stored.epoch], delta, 2, 0);
        _addStats(_buyerServiceStats[claim.buyer][claim.serviceKey][stored.epoch], delta, 2, 0);
        _addStats(_sellerServiceLifetimeStats[claim.sellerAgentId][claim.serviceKey], delta, 2, 0);
        _addStats(_buyerServiceLifetimeStats[claim.buyer][claim.serviceKey], delta, 2, 0);

        emit UsageRevealed(
            claimHash,
            claim.channelId,
            claim.serviceKey,
            stored.epoch,
            claim.buyer,
            claim.seller,
            claim.sellerAgentId,
            claim.providerName,
            claim.serviceName,
            delta.inputTokens,
            delta.cachedInputTokens,
            delta.freshInputTokens,
            delta.outputTokens,
            delta.requestCount,
            delta.costUsdc,
            claim.paymentCumulativeAmount
        );
    }

    function revealPartial(UsageClaim calldata claim, bytes32 nonce, uint8 party) external whenNotPaused {
        bytes32 claimHash = hashUsageClaim(claim);
        StoredCommit storage stored = commits[claimHash];
        if (stored.buyer == address(0)) revert InvalidCommit();
        if (stored.revealed) revert AlreadyRevealed();
        if (!_claimMatchesCommit(stored, claim)) revert InvalidCommit();

        if (party == PARTY_BUYER) {
            if (stored.buyerPartiallyRevealed) revert AlreadyRevealed();
            if (revealHash(claimHash, nonce) != stored.buyerRevealHash) revert InvalidCommit();
            stored.buyerPartiallyRevealed = true;
        } else if (party == PARTY_SELLER) {
            if (stored.sellerPartiallyRevealed) revert AlreadyRevealed();
            if (revealHash(claimHash, nonce) != stored.sellerRevealHash) revert InvalidCommit();
            stored.sellerPartiallyRevealed = true;
        } else {
            revert InvalidValue();
        }

        UsageSnapshot memory zeroDelta;
        _addStats(_sellerServiceStats[claim.sellerAgentId][claim.serviceKey][stored.epoch], zeroDelta, 0, 1);
        _addStats(_buyerServiceStats[claim.buyer][claim.serviceKey][stored.epoch], zeroDelta, 0, 1);
        _addStats(_sellerServiceLifetimeStats[claim.sellerAgentId][claim.serviceKey], zeroDelta, 0, 1);
        _addStats(_buyerServiceLifetimeStats[claim.buyer][claim.serviceKey], zeroDelta, 0, 1);

        emit UsagePartialReveal(claimHash, claim.channelId, claim.serviceKey, stored.epoch, party);
    }

    function _validateReveal(
        StoredCommit storage stored,
        UsageClaim calldata claim,
        bytes32 claimHash,
        bytes32 buyerNonce,
        bytes32 sellerNonce
    ) internal view {
        if (stored.buyer == address(0)) revert InvalidCommit();
        if (stored.revealed) revert AlreadyRevealed();
        if (!_claimMatchesCommit(stored, claim)) revert InvalidCommit();
        if (claim.version != CLAIM_VERSION) revert InvalidValue();
        if (revealHash(claimHash, buyerNonce) != stored.buyerRevealHash) revert InvalidCommit();
        if (revealHash(claimHash, sellerNonce) != stored.sellerRevealHash) revert InvalidCommit();
    }

    function _claimMatchesCommit(StoredCommit storage stored, UsageClaim calldata claim) internal view returns (bool) {
        return stored.channelId == claim.channelId
            && stored.buyer == claim.buyer
            && stored.seller == claim.seller
            && stored.sellerAgentId == claim.sellerAgentId
            && stored.serviceKey == claim.serviceKey;
    }

    function _verifyPaymentCoverage(UsageClaim calldata claim) internal view {
        address channelsAddress = registry.channels();
        if (channelsAddress == address(0)) revert InvalidAddress();
        (address buyer, address seller,, uint128 settled,,,,,) = IAntseedChannelsUsageView(channelsAddress).channels(claim.channelId);
        if (buyer != claim.buyer || seller != claim.seller) revert ChannelMismatch();
        if (uint256(settled) < claim.paymentCumulativeAmount) revert PaymentNotCovered();

        address stakingAddress = registry.staking();
        if (stakingAddress != address(0)) {
            uint256 actualAgentId = IAntseedStaking(stakingAddress).getAgentId(claim.seller);
            if (actualAgentId != claim.sellerAgentId) revert SellerAgentMismatch();
        }
    }

    function _applySnapshotDelta(uint256 epoch, UsageClaim calldata claim) internal returns (UsageSnapshot memory delta) {
        bytes32 snapshotKey = keccak256(abi.encode(epoch, claim.channelId, claim.serviceKey));
        UsageSnapshot storage previous = _snapshots[snapshotKey];
        if (
            claim.cumulativeInputTokens < previous.inputTokens
                || claim.cumulativeCachedInputTokens < previous.cachedInputTokens
                || claim.cumulativeFreshInputTokens < previous.freshInputTokens
                || claim.cumulativeOutputTokens < previous.outputTokens
                || claim.cumulativeRequestCount < previous.requestCount
                || claim.cumulativeCostUsdc < previous.costUsdc
        ) revert NonMonotonicClaim();

        delta = UsageSnapshot({
            inputTokens: claim.cumulativeInputTokens - previous.inputTokens,
            cachedInputTokens: claim.cumulativeCachedInputTokens - previous.cachedInputTokens,
            freshInputTokens: claim.cumulativeFreshInputTokens - previous.freshInputTokens,
            outputTokens: claim.cumulativeOutputTokens - previous.outputTokens,
            requestCount: claim.cumulativeRequestCount - previous.requestCount,
            costUsdc: claim.cumulativeCostUsdc - previous.costUsdc
        });

        previous.inputTokens = claim.cumulativeInputTokens;
        previous.cachedInputTokens = claim.cumulativeCachedInputTokens;
        previous.freshInputTokens = claim.cumulativeFreshInputTokens;
        previous.outputTokens = claim.cumulativeOutputTokens;
        previous.requestCount = claim.cumulativeRequestCount;
        previous.costUsdc = claim.cumulativeCostUsdc;
    }

    function _addStats(UsageStats storage stats, UsageSnapshot memory delta, uint256 attestations, uint256 partials) internal {
        stats.inputTokens += delta.inputTokens;
        stats.cachedInputTokens += delta.cachedInputTokens;
        stats.freshInputTokens += delta.freshInputTokens;
        stats.outputTokens += delta.outputTokens;
        stats.requestCount += delta.requestCount;
        stats.costUsdc += delta.costUsdc;
        stats.attestationCount += attestations;
        stats.partialRevealCount += partials;
        stats.lastUpdatedAt = uint64(block.timestamp);
    }

    function _verifyCommit(
        bytes32 claimHash,
        bytes32 _revealHash,
        uint256 expectedEpoch,
        uint8 party,
        address signer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(USAGE_COMMIT_TYPEHASH, claimHash, _revealHash, expectedEpoch, party));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered != signer) revert InvalidSignature();
    }

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
