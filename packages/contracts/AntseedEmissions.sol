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

    // Budget rollover from empty epochs
    uint256 public sellerBudgetRollover;
    uint256 public buyerBudgetRollover;

    // ─── Per-Epoch Snapshots (set when epoch finalizes) ───
    mapping(uint256 => uint256) public epochTotalSellerPoints;
    mapping(uint256 => uint256) public epochTotalBuyerPoints;
    mapping(uint256 => uint256) public epochSellerBudget;
    mapping(uint256 => uint256) public epochBuyerBudget;
    mapping(uint256 => bool) public epochFinalized;

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
    error EpochNotFinalized();
    error EpochAlreadyClaimed();
    error EpochIsCurrentOrFuture();
    error InvalidShareSum();
    error NoReserveDestination();
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
     *         Finalizes each completed epoch: snapshots budgets (with rollovers),
     *         accumulates reserve, advances emission rate on halving boundaries.
     */
    function advanceEpoch() public {
        if (block.timestamp < epochStart + EPOCH_DURATION) revert EpochNotEnded();

        uint256 maxIterations = 52;
        while (block.timestamp >= epochStart + EPOCH_DURATION && maxIterations > 0) {
            maxIterations--;
            _finalizeEpoch(currentEpoch);
            currentEpoch++;
            epochStart += EPOCH_DURATION;
        }

        emit EpochAdvanced(currentEpoch, _calcEpochEmission(currentEpoch));
    }

    /**
     * @dev Lazily advance epochs if needed. Called before any state mutation.
     */
    function _tryAdvanceEpoch() internal {
        if (block.timestamp >= epochStart + EPOCH_DURATION) {
            uint256 maxIterations = 52;
            while (block.timestamp >= epochStart + EPOCH_DURATION && maxIterations > 0) {
                maxIterations--;
                _finalizeEpoch(currentEpoch);
                currentEpoch++;
                epochStart += EPOCH_DURATION;
            }
        }
    }

    /**
     * @dev Finalize a completed epoch: compute budgets with rollovers,
     *      handle empty epochs, accumulate reserve.
     */
    function _finalizeEpoch(uint256 epoch) internal {
        if (epochFinalized[epoch]) return;

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

        epochFinalized[epoch] = true;
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
     *         Caller specifies which epochs to claim — no automatic looping.
     *         Each epoch can only be claimed once per address.
     *         Reverts if any epoch is not finalized or already claimed.
     *
     * @param epochs  Array of epoch numbers to claim
     */
    function claimEmissions(uint256[] calldata epochs) external nonReentrant {
        _tryAdvanceEpoch();

        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= currentEpoch) revert EpochIsCurrentOrFuture();
            if (!epochFinalized[epoch]) revert EpochNotFinalized();
            if (userEpochClaimed[msg.sender][epoch]) revert EpochAlreadyClaimed();

            userEpochClaimed[msg.sender][epoch] = true;

            // Seller reward
            uint256 userSP = userSellerPoints[msg.sender][epoch];
            uint256 totalSP = epochTotalSellerPoints[epoch];
            if (userSP > 0 && totalSP > 0) {
                uint256 sellerReward = (userSP * epochSellerBudget[epoch]) / totalSP;

                // Per-seller cap
                uint256 maxSellerReward = (epochSellerBudget[epoch] * MAX_SELLER_SHARE_PCT) / 100;
                if (sellerReward > maxSellerReward) {
                    reserveAccumulated += sellerReward - maxSellerReward;
                    sellerReward = maxSellerReward;
                }

                totalReward += sellerReward;
            }

            // Buyer reward
            uint256 userBP = userBuyerPoints[msg.sender][epoch];
            uint256 totalBP = epochTotalBuyerPoints[epoch];
            if (userBP > 0 && totalBP > 0) {
                totalReward += (userBP * epochBuyerBudget[epoch]) / totalBP;
            }
        }

        if (totalReward > 0) {
            IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
        }

        emit EmissionsClaimed(msg.sender, totalReward, epochs);
    }

    /**
     * @notice View pending (unclaimed) emissions for an account across specific epochs.
     */
    function pendingEmissions(
        address account,
        uint256[] calldata epochs
    ) external view returns (uint256 totalSeller, uint256 totalBuyer) {
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (!epochFinalized[epoch]) continue;
            if (userEpochClaimed[account][epoch]) continue;

            uint256 userSP = userSellerPoints[account][epoch];
            uint256 totalSP = epochTotalSellerPoints[epoch];
            if (userSP > 0 && totalSP > 0) {
                uint256 sellerReward = (userSP * epochSellerBudget[epoch]) / totalSP;
                uint256 maxSellerReward = (epochSellerBudget[epoch] * MAX_SELLER_SHARE_PCT) / 100;
                if (sellerReward > maxSellerReward) {
                    sellerReward = maxSellerReward;
                }
                totalSeller += sellerReward;
            }

            uint256 userBP = userBuyerPoints[account][epoch];
            uint256 totalBP = epochTotalBuyerPoints[epoch];
            if (userBP > 0 && totalBP > 0) {
                totalBuyer += (userBP * epochBuyerBudget[epoch]) / totalBP;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        RESERVE
    // ═══════════════════════════════════════════════════════════════════

    function flushReserve() external onlyOwner nonReentrant {
        if (reserveDestination == address(0)) revert NoReserveDestination();
        uint256 amount = reserveAccumulated;
        if (amount == 0) revert NoReserve();
        reserveAccumulated = 0;
        IANTSToken(registry.antsToken()).mint(reserveDestination, amount);
        emit ReserveFlushed(reserveDestination, amount);
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

    function setReserveDestination(address _dest) external onlyOwner {
        if (_dest == address(0)) revert InvalidAddress();
        reserveDestination = _dest;
    }

    function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external onlyOwner {
        if (sellerPct + buyerPct + reservePct != 100) revert InvalidShareSum();
        SELLER_SHARE_PCT = sellerPct;
        BUYER_SHARE_PCT = buyerPct;
        RESERVE_SHARE_PCT = reservePct;
    }

    function setMaxSellerSharePct(uint256 value) external onlyOwner {
        MAX_SELLER_SHARE_PCT = value;
    }

    function setEpochDuration(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidValue();
        EPOCH_DURATION = value;
    }

    function setHalvingInterval(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidValue();
        HALVING_INTERVAL = value;
    }
}
