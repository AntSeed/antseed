// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IANTSToken} from "./interfaces/IANTSToken.sol";

/**
 * @title AntseedEmissions
 * @notice Weekly epoch-based ANTS token emissions.
 *
 *         Points earned in epoch N only earn from epoch N's budget.
 *         If you stop working, you stop earning — points don't carry over.
 *         Earned rewards are claimable forever.
 *
 *         Each epoch's emission budget = INITIAL_EMISSION >> (epoch / HALVING_INTERVAL),
 *         split into seller / buyer / reserve shares.
 *
 *         Empty epochs: seller/buyer budget rolls forward to the next non-empty epoch.
 *         Reserve accumulates regardless.
 *
 *         Gas profile:
 *           accruePoints:    O(1) + lazy epoch advance (typically 0-1)
 *           claimEmissions:  O(claimed epochs) — caller passes epoch list
 *           advanceEpoch:    O(missed epochs), capped at 52
 */
contract AntseedEmissions is Ownable, ReentrancyGuard {
    // ─── Configuration ───
    IAntseedRegistry public registry;

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

    // Budget rollover from empty epochs
    uint256 public sellerBudgetRollover;
    uint256 public buyerBudgetRollover;

    // ─── Per-Epoch Snapshots (set when epoch finalizes) ───
    mapping(uint256 => uint256) public epochTotalSellerPoints;
    mapping(uint256 => uint256) public epochTotalBuyerPoints;
    mapping(uint256 => uint256) public epochSellerBudget;
    mapping(uint256 => uint256) public epochBuyerBudget;

    // ─── Per-User State ───
    mapping(address => mapping(uint256 => uint256)) public userSellerPoints;
    mapping(address => mapping(uint256 => uint256)) public userBuyerPoints;
    mapping(address => mapping(uint256 => bool)) public userEpochClaimed;

    // ─── Reserve ───
    uint256 public reserveAccumulated;

    // ─── Events ───
    event EpochAdvanced(uint256 indexed epoch, uint256 emission);
    event SellerPointsAccrued(address indexed seller, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 pointsDelta);
    event EmissionsClaimed(address indexed claimer, uint256 amount, uint256[] epochs);
    event ReserveFlushed(address indexed destination, uint256 amount);

    // ─── Custom Errors ───
    error NotAuthorized();
    error EpochNotEnded();
    error EpochAlreadyClaimed();
    error EpochNotFinalized();
    error InvalidShareSum();
    error NoProtocolReserve();
    error NoReserve();
    error InvalidAddress();
    error InvalidValue();

    // ─── Modifiers ───
    modifier onlyChannels() {
        if (msg.sender != registry.channels()) revert NotAuthorized();
        _;
    }

    // ─── Constructor ───
    constructor(address _registry, uint256 _initialEmission, uint256 _epochDuration)
        Ownable(msg.sender)
        ReentrancyGuard()
    {
        if (_registry == address(0)) revert InvalidAddress();
        if (_initialEmission == 0) revert InvalidValue();
        if (_epochDuration == 0) revert InvalidValue();

        registry = IAntseedRegistry(_registry);
        INITIAL_EMISSION = _initialEmission;
        EPOCH_DURATION = _epochDuration;
        HALVING_INTERVAL = 26;
        SELLER_SHARE_PCT = 65;
        BUYER_SHARE_PCT = 25;
        RESERVE_SHARE_PCT = 10;
        MAX_SELLER_SHARE_PCT = 15;

        epochStart = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Advance through all completed epochs. Permissionless.
     *         Reverts if the current epoch hasn't ended yet.
     */
    function advanceEpoch() public {
        if (block.timestamp < epochStart + EPOCH_DURATION) revert EpochNotEnded();
        _tryAdvanceEpoch();
    }

    /**
     * @dev Lazily advance epochs if needed. Called before any state mutation.
     *      Caches storage vars in memory for gas efficiency during multi-epoch catch-up.
     */
    function _tryAdvanceEpoch() internal {
        uint256 _epochStart = epochStart;
        uint256 _epochDuration = EPOCH_DURATION;
        if (block.timestamp < _epochStart + _epochDuration) return;

        uint256 _epoch = currentEpoch;
        uint256 maxIterations = 52;
        while (block.timestamp >= _epochStart + _epochDuration && maxIterations > 0) {
            maxIterations--;
            _finalizeEpoch(_epoch);
            _epoch++;
            _epochStart += _epochDuration;
        }
        currentEpoch = _epoch;
        epochStart = _epochStart;

        emit EpochAdvanced(_epoch, _calcEpochEmission(_epoch));
    }

    /**
     * @dev Finalize a completed epoch: compute budgets with rollovers,
     *      handle empty epochs, accumulate reserve.
     */
    function _finalizeEpoch(uint256 epoch) internal {
        uint256 emission = _calcEpochEmission(epoch);
        uint256 sellerBudget = (emission * SELLER_SHARE_PCT) / 100 + sellerBudgetRollover;
        uint256 buyerBudget = (emission * BUYER_SHARE_PCT) / 100 + buyerBudgetRollover;

        reserveAccumulated += (emission * RESERVE_SHARE_PCT) / 100;

        if (epochTotalSellerPoints[epoch] == 0) {
            sellerBudgetRollover = sellerBudget;
        } else {
            epochSellerBudget[epoch] = sellerBudget;
            sellerBudgetRollover = 0;
        }

        if (epochTotalBuyerPoints[epoch] == 0) {
            buyerBudgetRollover = buyerBudget;
        } else {
            epochBuyerBudget[epoch] = buyerBudget;
            buyerBudgetRollover = 0;
        }
    }

    function _calcEpochEmission(uint256 epoch) internal view returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINT ACCRUAL
    // ═══════════════════════════════════════════════════════════════════

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlyChannels {
        _tryAdvanceEpoch();
        userSellerPoints[seller][currentEpoch] += pointsDelta;
        epochTotalSellerPoints[currentEpoch] += pointsDelta;
        emit SellerPointsAccrued(seller, pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlyChannels {
        _tryAdvanceEpoch();
        userBuyerPoints[buyer][currentEpoch] += pointsDelta;
        epochTotalBuyerPoints[currentEpoch] += pointsDelta;
        emit BuyerPointsAccrued(buyer, pointsDelta);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim emissions for a list of finalized epochs.
     *         Each epoch can only be claimed once per address.
     *
     * @param epochs  Array of epoch numbers to claim
     */
    function claimEmissions(uint256[] calldata epochs) external nonReentrant {
        _tryAdvanceEpoch();

        uint256 _currentEpoch = currentEpoch;
        uint256 _maxSellerPct = MAX_SELLER_SHARE_PCT;
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) revert EpochNotFinalized();
            if (userEpochClaimed[msg.sender][epoch]) revert EpochAlreadyClaimed();
            if (userSellerPoints[msg.sender][epoch] == 0 && userBuyerPoints[msg.sender][epoch] == 0) continue;

            userEpochClaimed[msg.sender][epoch] = true;

            (uint256 sellerReward, uint256 sellerExcess, uint256 buyerReward) =
                _calcEpochReward(msg.sender, epoch, _maxSellerPct);

            reserveAccumulated += sellerExcess;
            totalReward += sellerReward + buyerReward;
        }

        if (totalReward > 0) {
            IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
            emit EmissionsClaimed(msg.sender, totalReward, epochs);
        }
    }

    /**
     * @notice View pending (unclaimed) emissions for an account across specific epochs.
     */
    function pendingEmissions(
        address account,
        uint256[] calldata epochs
    ) external view returns (uint256 totalSeller, uint256 totalBuyer) {
        uint256 _currentEpoch = currentEpoch;
        uint256 _maxSellerPct = MAX_SELLER_SHARE_PCT;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) continue;
            if (userEpochClaimed[account][epoch]) continue;

            (uint256 sellerReward,, uint256 buyerReward) =
                _calcEpochReward(account, epoch, _maxSellerPct);

            totalSeller += sellerReward;
            totalBuyer += buyerReward;
        }
    }

    /**
     * @dev Calculate a user's reward for a single finalized epoch.
     *      Returns capped seller reward, excess (for reserve), and buyer reward.
     */
    function _calcEpochReward(
        address account,
        uint256 epoch,
        uint256 maxSellerPct
    ) internal view returns (uint256 sellerReward, uint256 sellerExcess, uint256 buyerReward) {
        uint256 userSP = userSellerPoints[account][epoch];
        uint256 totalSP = epochTotalSellerPoints[epoch];
        if (userSP > 0 && totalSP > 0) {
            uint256 sBudget = epochSellerBudget[epoch];
            sellerReward = (userSP * sBudget) / totalSP;

            uint256 maxSellerReward = (sBudget * maxSellerPct) / 100;
            if (sellerReward > maxSellerReward) {
                sellerExcess = sellerReward - maxSellerReward;
                sellerReward = maxSellerReward;
            }
        }

        uint256 userBP = userBuyerPoints[account][epoch];
        uint256 totalBP = epochTotalBuyerPoints[epoch];
        if (userBP > 0 && totalBP > 0) {
            buyerReward = (userBP * epochBuyerBudget[epoch]) / totalBP;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function flushReserve() external onlyOwner nonReentrant {
        address dest = registry.protocolReserve();
        if (dest == address(0)) revert NoProtocolReserve();
        uint256 amount = reserveAccumulated;
        if (amount == 0) revert NoReserve();
        reserveAccumulated = 0;
        IANTSToken(registry.antsToken()).mint(dest, amount);
        emit ReserveFlushed(dest, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function currentEmissionRate() external view returns (uint256) {
        return _calcEpochEmission(currentEpoch) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) external view returns (uint256) {
        return _calcEpochEmission(epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external onlyOwner {
        if (sellerPct + buyerPct + reservePct != 100) revert InvalidShareSum();
        _tryAdvanceEpoch();
        SELLER_SHARE_PCT = sellerPct;
        BUYER_SHARE_PCT = buyerPct;
        RESERVE_SHARE_PCT = reservePct;
    }

    function setMaxSellerSharePct(uint256 value) external onlyOwner {
        if (value == 0 || value > 100) revert InvalidValue();
        MAX_SELLER_SHARE_PCT = value;
    }

    function setEpochDuration(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidValue();
        _tryAdvanceEpoch();
        EPOCH_DURATION = value;
    }

    function setHalvingInterval(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidValue();
        _tryAdvanceEpoch();
        HALVING_INTERVAL = value;
    }
}
