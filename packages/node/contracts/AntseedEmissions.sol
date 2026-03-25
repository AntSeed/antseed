// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IANTSToken {
    function mint(address to, uint256 amount) external;
}

/**
 * @title AntseedEmissions
 * @notice ANTS token emission controller using Synthetix reward-per-point pattern.
 *         Epoch-based emission with halving, O(1) gas per interaction,
 *         configurable seller/buyer/reserve split.
 */
contract AntseedEmissions is Ownable, ReentrancyGuard {
    // ─── Configuration (all owner-settable) ───
    IANTSToken public antsToken;
    address public sessionsContract;
    address public reserveDestination;

    uint256 public EPOCH_DURATION;
    uint256 public HALVING_INTERVAL;
    uint256 public INITIAL_EMISSION;
    uint256 public SELLER_SHARE_PCT;
    uint256 public BUYER_SHARE_PCT;
    uint256 public RESERVE_SHARE_PCT;
    uint256 public MAX_SELLER_SHARE_PCT;

    // ─── Epoch State ───
    uint256 public currentEpoch;
    uint256 public epochStart;
    uint256 public currentEmissionRate; // tokens per second for current epoch

    // ─── Seller Reward Accumulator (Synthetix pattern) ───
    uint256 public sellerRewardPerPointStored;
    uint256 public totalSellerPoints;
    uint256 public sellerLastUpdateTime;

    struct SellerReward {
        uint256 points;
        uint256 rewardPerPointPaid;
        uint256 pendingReward;
    }
    mapping(address => SellerReward) public sellerRewards;

    // ─── Buyer Reward Accumulator ───
    uint256 public buyerRewardPerPointStored;
    uint256 public totalBuyerPoints;
    uint256 public buyerLastUpdateTime;

    struct BuyerReward {
        uint256 points;
        uint256 rewardPerPointPaid;
        uint256 pendingReward;
    }
    mapping(address => BuyerReward) public buyerRewards;

    // ─── Reserve ───
    uint256 public reserveAccumulated;

    // ─── setConstant key constants ───
    bytes32 private constant KEY_EPOCH_DURATION = keccak256("EPOCH_DURATION");
    bytes32 private constant KEY_HALVING_INTERVAL = keccak256("HALVING_INTERVAL");
    bytes32 private constant KEY_MAX_SELLER_SHARE_PCT = keccak256("MAX_SELLER_SHARE_PCT");

    // ─── Events ───
    event EpochAdvanced(uint256 indexed epoch, uint256 emission);
    event SellerPointsAccrued(address indexed seller, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 pointsDelta);
    event EmissionsClaimed(address indexed claimer, uint256 amount);
    event ReserveFlushed(address indexed destination, uint256 amount);
    event ConstantUpdated(bytes32 indexed key, uint256 value);

    // ─── Custom Errors ───
    error NotAuthorized();
    error EpochNotEnded();
    error InvalidShareSum();
    error NoReserveDestination();
    error NoReserve();
    error InvalidAddress();
    error InvalidValue();
    error InvalidSharePercentages();

    // ─── Modifiers ───
    modifier onlySessions() {
        if (msg.sender != sessionsContract) revert NotAuthorized();
        _;
    }

    // ─── Constructor ───
    constructor(address _antsToken, uint256 _initialEmission, uint256 _epochDuration)
        Ownable(msg.sender)
        ReentrancyGuard()
    {
        if (_antsToken == address(0)) revert InvalidAddress();
        if (_initialEmission == 0) revert InvalidValue();
        if (_epochDuration == 0) revert InvalidValue();
        antsToken = IANTSToken(_antsToken);
        INITIAL_EMISSION = _initialEmission;
        EPOCH_DURATION = _epochDuration;
        HALVING_INTERVAL = 26;
        SELLER_SHARE_PCT = 65;
        BUYER_SHARE_PCT = 25;
        RESERVE_SHARE_PCT = 10;
        MAX_SELLER_SHARE_PCT = 15;

        if (SELLER_SHARE_PCT + BUYER_SHARE_PCT + RESERVE_SHARE_PCT != 100) revert InvalidSharePercentages();

        epochStart = block.timestamp;
        currentEmissionRate = _calcEmissionRate(0);
        sellerLastUpdateTime = block.timestamp;
        buyerLastUpdateTime = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    function advanceEpoch() external {
        if (block.timestamp < epochStart + EPOCH_DURATION) revert EpochNotEnded();

        // Process all missed epochs (not just one) to prevent over-accrual
        // at a stale emission rate when epochs are skipped
        uint256 maxIterations = 52; // cap to prevent gas exhaustion
        while (block.timestamp >= epochStart + EPOCH_DURATION && maxIterations > 0) {
            maxIterations--;

            uint256 epochEnd = epochStart + EPOCH_DURATION;

            // Clamp accrual to epoch boundary (not block.timestamp)
            _updateSellerRewardTo(epochEnd);
            _updateBuyerRewardTo(epochEnd);

            // Accumulate reserve for this epoch
            uint256 epochEmission = _calcEpochEmission(currentEpoch);
            reserveAccumulated += (epochEmission * RESERVE_SHARE_PCT) / 100;

            currentEpoch++;
            currentEmissionRate = _calcEmissionRate(currentEpoch);
            epochStart = epochEnd;
        }

        // Accrue any remaining time in the new current epoch
        _updateSellerReward();
        _updateBuyerReward();

        emit EpochAdvanced(currentEpoch, _calcEpochEmission(currentEpoch));
    }

    function _calcEpochEmission(uint256 epoch) internal view returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function _calcEmissionRate(uint256 epoch) internal view returns (uint256) {
        return _calcEpochEmission(epoch) / EPOCH_DURATION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   SYNTHETIX REWARD ACCUMULATORS
    // ═══════════════════════════════════════════════════════════════════

    function _clampedNow() private view returns (uint256) {
        uint256 epochEnd = epochStart + EPOCH_DURATION;
        return block.timestamp < epochEnd ? block.timestamp : epochEnd;
    }

    function _updateSellerReward() internal {
        _updateSellerRewardTo(_clampedNow());
    }

    function _updateSellerRewardTo(uint256 timestamp) internal {
        if (totalSellerPoints > 0 && timestamp > sellerLastUpdateTime) {
            uint256 elapsed = timestamp - sellerLastUpdateTime;
            uint256 sellerEmissionRate = (currentEmissionRate * SELLER_SHARE_PCT) / 100;
            sellerRewardPerPointStored += (sellerEmissionRate * elapsed * 1e18) / totalSellerPoints;
        }
        sellerLastUpdateTime = timestamp;
    }

    function _updateSellerAccount(address seller) internal {
        _updateSellerReward();
        SellerReward storage sr = sellerRewards[seller];
        sr.pendingReward += (sr.points * (sellerRewardPerPointStored - sr.rewardPerPointPaid)) / 1e18;
        sr.rewardPerPointPaid = sellerRewardPerPointStored;
    }

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlySessions {
        _updateSellerAccount(seller);
        sellerRewards[seller].points += pointsDelta;
        totalSellerPoints += pointsDelta;
        emit SellerPointsAccrued(seller, pointsDelta);
    }

    function _updateBuyerReward() internal {
        _updateBuyerRewardTo(_clampedNow());
    }

    function _updateBuyerRewardTo(uint256 timestamp) internal {
        if (totalBuyerPoints > 0 && timestamp > buyerLastUpdateTime) {
            uint256 elapsed = timestamp - buyerLastUpdateTime;
            uint256 buyerEmissionRate = (currentEmissionRate * BUYER_SHARE_PCT) / 100;
            buyerRewardPerPointStored += (buyerEmissionRate * elapsed * 1e18) / totalBuyerPoints;
        }
        buyerLastUpdateTime = timestamp;
    }

    function _updateBuyerAccount(address buyer) internal {
        _updateBuyerReward();
        BuyerReward storage br = buyerRewards[buyer];
        br.pendingReward += (br.points * (buyerRewardPerPointStored - br.rewardPerPointPaid)) / 1e18;
        br.rewardPerPointPaid = buyerRewardPerPointStored;
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlySessions {
        _updateBuyerAccount(buyer);
        buyerRewards[buyer].points += pointsDelta;
        totalBuyerPoints += pointsDelta;
        emit BuyerPointsAccrued(buyer, pointsDelta);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING & RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function claimEmissions() external nonReentrant {
        _updateSellerAccount(msg.sender);
        _updateBuyerAccount(msg.sender);

        uint256 sellerReward = sellerRewards[msg.sender].pendingReward;
        uint256 buyerReward = buyerRewards[msg.sender].pendingReward;

        // Enforce per-seller cap (MAX_SELLER_SHARE_PCT of seller pool).
        // Use INITIAL_EMISSION (not current epoch) so the cap doesn't shrink
        // after halvings — otherwise infrequent claimers who accumulate across
        // a halving boundary lose rewards to the reserve unfairly.
        uint256 maxSellerReward =
            (INITIAL_EMISSION * SELLER_SHARE_PCT * MAX_SELLER_SHARE_PCT) / 10000;
        if (sellerReward > maxSellerReward) {
            uint256 excess = sellerReward - maxSellerReward;
            sellerReward = maxSellerReward;
            reserveAccumulated += excess;
        }

        uint256 total = sellerReward + buyerReward;
        if (total == 0) return;

        sellerRewards[msg.sender].pendingReward = 0;
        buyerRewards[msg.sender].pendingReward = 0;

        antsToken.mint(msg.sender, total);
        emit EmissionsClaimed(msg.sender, total);
    }

    function pendingEmissions(address account) external view returns (uint256 seller, uint256 buyer) {
        // Calculate without mutating state (view-safe)
        uint256 clampedTime = _clampedNow();

        SellerReward memory sr = sellerRewards[account];
        uint256 sellerRPP = sellerRewardPerPointStored;
        if (totalSellerPoints > 0 && clampedTime > sellerLastUpdateTime) {
            uint256 elapsed = clampedTime - sellerLastUpdateTime;
            uint256 sellerEmRate = (currentEmissionRate * SELLER_SHARE_PCT) / 100;
            sellerRPP += (sellerEmRate * elapsed * 1e18) / totalSellerPoints;
        }
        seller = sr.pendingReward + (sr.points * (sellerRPP - sr.rewardPerPointPaid)) / 1e18;

        // Apply per-seller cap (mirrors claimEmissions logic)
        uint256 maxSellerReward =
            (INITIAL_EMISSION * SELLER_SHARE_PCT * MAX_SELLER_SHARE_PCT) / 10000;
        if (seller > maxSellerReward) {
            seller = maxSellerReward;
        }

        // Same for buyer
        BuyerReward memory br = buyerRewards[account];
        uint256 buyerRPP = buyerRewardPerPointStored;
        if (totalBuyerPoints > 0 && clampedTime > buyerLastUpdateTime) {
            uint256 elapsed = clampedTime - buyerLastUpdateTime;
            uint256 buyerEmRate = (currentEmissionRate * BUYER_SHARE_PCT) / 100;
            buyerRPP += (buyerEmRate * elapsed * 1e18) / totalBuyerPoints;
        }
        buyer = br.pendingReward + (br.points * (buyerRPP - br.rewardPerPointPaid)) / 1e18;
    }

    function flushReserve() external onlyOwner nonReentrant {
        if (reserveDestination == address(0)) revert NoReserveDestination();
        uint256 amount = reserveAccumulated;
        if (amount == 0) revert NoReserve();
        reserveAccumulated = 0;
        antsToken.mint(reserveDestination, amount);
        emit ReserveFlushed(reserveDestination, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSessionsContract(address _sessions) external onlyOwner {
        if (_sessions == address(0)) revert InvalidAddress();
        sessionsContract = _sessions;
    }

    function setReserveDestination(address _dest) external onlyOwner {
        if (_dest == address(0)) revert InvalidAddress();
        reserveDestination = _dest;
    }

    function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external onlyOwner {
        if (sellerPct + buyerPct + reservePct != 100) revert InvalidShareSum();
        _updateSellerReward();
        _updateBuyerReward();
        SELLER_SHARE_PCT = sellerPct;
        BUYER_SHARE_PCT = buyerPct;
        RESERVE_SHARE_PCT = reservePct;
    }

    function setConstant(bytes32 key, uint256 value) external onlyOwner {
        if (key == KEY_EPOCH_DURATION) {
            if (value == 0) revert InvalidValue();
            EPOCH_DURATION = value;
        }
        else if (key == KEY_HALVING_INTERVAL) {
            if (value == 0) revert InvalidValue();
            HALVING_INTERVAL = value;
        }
        else if (key == KEY_MAX_SELLER_SHARE_PCT) MAX_SELLER_SHARE_PCT = value;
        else revert NotAuthorized();

        emit ConstantUpdated(key, value);
    }
}
