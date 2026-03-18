// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external returns (uint256);
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

    function getReputation(uint256 tokenId) external view returns (ProvenReputation memory);
    function isRegistered(address addr) external view returns (bool);
    function getTokenId(address addr) external view returns (uint256);
}

/**
 * @title AntseedSubPool
 * @notice Subscription pool contract managing monthly subscriptions, daily token
 *         budgets, and epoch-based revenue distribution to opted-in peers
 *         proportional to their proven reputation.
 */
contract AntseedSubPool {
    // ─── Structs ─────────────────────────────────────────────────────────
    struct Tier {
        uint256 monthlyFee; // USDC base units
        uint256 dailyTokenBudget; // tokens per day
        bool active;
    }

    struct Subscription {
        uint256 tierId;
        uint256 startedAt;
        uint256 expiresAt;
        uint256 tokensUsedToday;
        uint256 lastResetDay; // day number (block.timestamp / 1 days)
    }

    struct PeerOpt {
        bool optedIn;
        uint256 tokenId; // AntseedIdentity token
        uint256 lastClaimedEpoch;
        uint256 pendingRevenue;
    }

    // ─── State Variables ─────────────────────────────────────────────────
    IERC20 public immutable usdc;
    IAntseedIdentity public identityContract;
    address public owner;
    address public escrowContract;
    bool private _locked;

    mapping(uint256 => Tier) public tiers;
    uint256 public tierCount;
    mapping(address => Subscription) public subscriptions;
    mapping(address => PeerOpt) public peerOpts; // seller address → opt-in state
    address[] public optedInPeers;

    uint256 public currentEpochRevenue; // USDC accumulated this epoch
    uint256 public epochDuration; // default 1 week
    uint256 public epochStart;
    uint256 public currentEpoch;

    // ─── Events ──────────────────────────────────────────────────────────
    event TierSet(uint256 indexed tierId, uint256 monthlyFee, uint256 dailyTokenBudget);
    event Subscribed(address indexed buyer, uint256 indexed tierId, uint256 expiresAt);
    event Renewed(address indexed buyer, uint256 newExpiresAt);
    event Cancelled(address indexed buyer);
    event PeerOptedIn(address indexed peer, uint256 indexed tokenId);
    event PeerOptedOut(address indexed peer, uint256 indexed tokenId);
    event RevenueDistributed(uint256 indexed epoch, uint256 totalRevenue, uint256 peerCount);
    event RevenueClaimed(address indexed peer, uint256 amount);
    event TokenUsageRecorded(address indexed buyer, uint256 tokens);

    // ─── Custom Errors ───────────────────────────────────────────────────
    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTier();
    error TierNotActive();
    error NotRegistered();
    error NotSubscribed();
    error SubscriptionExpired();
    error AlreadyOptedIn();
    error NotOptedIn();
    error EpochNotEnded();
    error NothingToClaim();
    error DailyBudgetExceeded();
    error Reentrancy();
    error TransferFailed();
    error AlreadySubscribed();
    error NotAuthorized();

    // ─── Modifiers ───────────────────────────────────────────────────────
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

    // ─── Constructor ─────────────────────────────────────────────────────
    constructor(address _usdc, address _identity) {
        if (_usdc == address(0)) revert InvalidAddress();
        if (_identity == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        identityContract = IAntseedIdentity(_identity);
        owner = msg.sender;
        epochDuration = 7 days;
        epochStart = block.timestamp;
        currentEpoch = 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TIER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    function setTier(uint256 tierId, uint256 monthlyFee, uint256 dailyTokenBudget) external onlyOwner {
        if (monthlyFee == 0) revert InvalidAmount();
        if (dailyTokenBudget == 0) revert InvalidAmount();

        tiers[tierId] = Tier({ monthlyFee: monthlyFee, dailyTokenBudget: dailyTokenBudget, active: true });

        if (tierId >= tierCount) {
            tierCount = tierId + 1;
        }

        emit TierSet(tierId, monthlyFee, dailyTokenBudget);
    }

    function deactivateTier(uint256 tierId) external onlyOwner {
        if (!tiers[tierId].active) revert TierNotActive();
        tiers[tierId].active = false;
    }

    function getTier(uint256 tierId) external view returns (uint256 monthlyFee, uint256 dailyTokenBudget, bool active) {
        Tier storage t = tiers[tierId];
        return (t.monthlyFee, t.dailyTokenBudget, t.active);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SUBSCRIPTIONS
    // ═══════════════════════════════════════════════════════════════════

    function subscribe(uint256 tierId) external nonReentrant {
        Tier storage tier = tiers[tierId];
        if (!tier.active) revert TierNotActive();

        Subscription storage sub = subscriptions[msg.sender];
        if (sub.expiresAt > block.timestamp) revert AlreadySubscribed();

        _safeTransferFrom(msg.sender, address(this), tier.monthlyFee);
        currentEpochRevenue += tier.monthlyFee;

        sub.tierId = tierId;
        sub.startedAt = block.timestamp;
        sub.expiresAt = block.timestamp + 30 days;
        sub.tokensUsedToday = 0;
        sub.lastResetDay = block.timestamp / 1 days;

        emit Subscribed(msg.sender, tierId, sub.expiresAt);
    }

    function renewSubscription() external nonReentrant {
        Subscription storage sub = subscriptions[msg.sender];
        if (sub.expiresAt == 0) revert NotSubscribed();
        if (sub.expiresAt < block.timestamp) revert SubscriptionExpired();

        Tier storage tier = tiers[sub.tierId];
        if (!tier.active) revert TierNotActive();

        _safeTransferFrom(msg.sender, address(this), tier.monthlyFee);
        currentEpochRevenue += tier.monthlyFee;

        sub.expiresAt += 30 days;

        emit Renewed(msg.sender, sub.expiresAt);
    }

    function cancelSubscription() external {
        Subscription storage sub = subscriptions[msg.sender];
        if (sub.expiresAt == 0 || sub.expiresAt < block.timestamp) revert NotSubscribed();
        // No refund, subscription remains active until expiresAt
        emit Cancelled(msg.sender);
    }

    function isSubscriptionActive(address buyer) external view returns (bool) {
        return subscriptions[buyer].expiresAt > block.timestamp;
    }

    function getRemainingDailyBudget(address buyer) external view returns (uint256) {
        Subscription storage sub = subscriptions[buyer];
        if (sub.expiresAt <= block.timestamp) return 0;

        Tier storage tier = tiers[sub.tierId];
        uint256 today = block.timestamp / 1 days;

        if (today > sub.lastResetDay) {
            // New day — full budget available
            return tier.dailyTokenBudget;
        }

        if (sub.tokensUsedToday >= tier.dailyTokenBudget) return 0;
        return tier.dailyTokenBudget - sub.tokensUsedToday;
    }

    function recordTokenUsage(address buyer, uint256 tokens) external {
        if (msg.sender != escrowContract && msg.sender != owner) revert NotAuthorized();
        Subscription storage sub = subscriptions[buyer];
        if (sub.expiresAt <= block.timestamp) revert SubscriptionExpired();

        Tier storage tier = tiers[sub.tierId];
        uint256 today = block.timestamp / 1 days;

        // Reset daily counter if new day
        if (today > sub.lastResetDay) {
            sub.tokensUsedToday = 0;
            sub.lastResetDay = today;
        }

        if (sub.tokensUsedToday + tokens > tier.dailyTokenBudget) revert DailyBudgetExceeded();

        sub.tokensUsedToday += tokens;
        emit TokenUsageRecorded(buyer, tokens);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        PEER OPT-IN / OPT-OUT
    // ═══════════════════════════════════════════════════════════════════

    function optIn(uint256 tokenId) external {
        if (!identityContract.isRegistered(msg.sender)) revert NotRegistered();
        if (identityContract.getTokenId(msg.sender) != tokenId) revert InvalidAmount();
        if (peerOpts[msg.sender].optedIn) revert AlreadyOptedIn();

        peerOpts[msg.sender] = PeerOpt({
            optedIn: true,
            tokenId: tokenId,
            lastClaimedEpoch: currentEpoch,
            pendingRevenue: 0
        });
        peerRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;
        // Snapshot initial weight from current reputation
        IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(tokenId);
        peerSnapshotWeight[msg.sender] = uint256(rep.qualifiedProvenSignCount);

        optedInPeers.push(msg.sender);
        emit PeerOptedIn(msg.sender, tokenId);
    }

    function optOut(uint256 tokenId) external nonReentrant {
        PeerOpt storage opt = peerOpts[msg.sender];
        if (!opt.optedIn) revert NotOptedIn();
        if (opt.tokenId != tokenId) revert InvalidAmount();

        // Auto-claim any pending revenue before opting out (use snapshot weight)
        uint256 weight = peerSnapshotWeight[msg.sender];
        uint256 earned = (weight * (rewardPerTokenStored - peerRewardPerTokenPaid[msg.sender])) / 1e18;
        uint256 claimable = opt.pendingRevenue + earned;
        if (claimable > 0) {
            opt.pendingRevenue = 0;
            peerRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;
            _safeTransfer(msg.sender, claimable);
        }

        opt.optedIn = false;

        // Remove from optedInPeers array
        uint256 len = optedInPeers.length;
        for (uint256 i = 0; i < len; i++) {
            if (optedInPeers[i] == msg.sender) {
                optedInPeers[i] = optedInPeers[len - 1];
                optedInPeers.pop();
                break;
            }
        }

        emit PeerOptedOut(msg.sender, tokenId);
    }

    function getOptedInPeerCount() external view returns (uint256) {
        return optedInPeers.length;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REVENUE DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════

    // Accumulated reward-per-token for the current epoch (scaled by 1e18)
    uint256 public rewardPerTokenStored;
    // Snapshot of rewardPerToken at last claim per peer
    mapping(address => uint256) public peerRewardPerTokenPaid;
    // Weight snapshot: locked at distributeRevenue() to prevent retroactive over-claims
    mapping(address => uint256) public peerSnapshotWeight;

    function distributeRevenue() external nonReentrant {
        if (block.timestamp < epochStart + epochDuration) revert EpochNotEnded();

        uint256 revenue = currentEpochRevenue;
        uint256 peerCount = optedInPeers.length;
        bool distributed = false;

        if (revenue > 0 && peerCount > 0) {
            // Settle all peers using their CURRENT weight before changing rewardPerTokenStored
            uint256 totalWeight = 0;
            for (uint256 i = 0; i < peerCount; i++) {
                address peer = optedInPeers[i];
                uint256 w = peerSnapshotWeight[peer];
                if (w > 0) {
                    // Settle earned with old snapshot weight before updating
                    uint256 earned = (w * (rewardPerTokenStored - peerRewardPerTokenPaid[peer])) / 1e18;
                    peerOpts[peer].pendingRevenue += earned;
                    peerRewardPerTokenPaid[peer] = rewardPerTokenStored;
                }
                // Snapshot current reputation as weight for the new epoch
                PeerOpt storage opt = peerOpts[peer];
                IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(opt.tokenId);
                uint256 newWeight = uint256(rep.qualifiedProvenSignCount);
                peerSnapshotWeight[peer] = newWeight;
                totalWeight += newWeight;
            }

            if (totalWeight > 0) {
                rewardPerTokenStored += (revenue * 1e18) / totalWeight;
                distributed = true;
            }
        }

        // Only reset revenue if distributed; otherwise carry forward to next epoch
        if (distributed) {
            currentEpochRevenue = 0;
        }

        emit RevenueDistributed(currentEpoch, distributed ? revenue : 0, peerCount);

        // Advance epoch
        epochStart = block.timestamp;
        currentEpoch++;
    }

    function claimRevenue() external nonReentrant {
        PeerOpt storage opt = peerOpts[msg.sender];
        if (!opt.optedIn) revert NotOptedIn();

        // Use snapshotted weight (locked at distribution time), not live reputation
        uint256 weight = peerSnapshotWeight[msg.sender];
        uint256 earned = (weight * (rewardPerTokenStored - peerRewardPerTokenPaid[msg.sender])) / 1e18;
        uint256 amount = opt.pendingRevenue + earned;
        if (amount == 0) revert NothingToClaim();

        opt.pendingRevenue = 0;
        opt.lastClaimedEpoch = currentEpoch;
        peerRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        _safeTransfer(msg.sender, amount);
        emit RevenueClaimed(msg.sender, amount);
    }

    function getProjectedRevenue(address seller) external view returns (uint256) {
        PeerOpt storage opt = peerOpts[seller];
        if (!opt.optedIn) return 0;

        // Already-earned from previous epochs (use snapshot weight)
        uint256 weight = peerSnapshotWeight[seller];
        uint256 earned = (weight * (rewardPerTokenStored - peerRewardPerTokenPaid[seller])) / 1e18;
        uint256 pending = opt.pendingRevenue + earned;

        // Project current epoch share (use live reputation for projection)
        IAntseedIdentity.ProvenReputation memory rep = identityContract.getReputation(opt.tokenId);
        uint256 liveWeight = uint256(rep.qualifiedProvenSignCount);
        uint256 revenue = currentEpochRevenue;
        uint256 peerCount = optedInPeers.length;
        if (revenue == 0 || peerCount == 0 || liveWeight == 0) return pending;

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < peerCount; i++) {
            PeerOpt storage p = peerOpts[optedInPeers[i]];
            IAntseedIdentity.ProvenReputation memory r = identityContract.getReputation(p.tokenId);
            totalWeight += uint256(r.qualifiedProvenSignCount);
        }

        if (totalWeight == 0) return pending;
        return pending + (revenue * liveWeight) / totalWeight;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setEscrowContract(address _escrow) external onlyOwner {
        escrowContract = _escrow;
    }

    function setEpochDuration(uint256 duration) external onlyOwner {
        if (duration == 0) revert InvalidAmount();
        epochDuration = duration;
    }

    function setIdentityContract(address _identity) external onlyOwner {
        if (_identity == address(0)) revert InvalidAddress();
        identityContract = IAntseedIdentity(_identity);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _safeTransferFrom(address from, address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransfer(address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert TransferFailed();
        }
    }
}
