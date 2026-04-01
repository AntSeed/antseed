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
 *         Epoch number is derived from timestamp:
 *           epoch = (block.timestamp - genesis) / EPOCH_DURATION
 *
 *         No explicit epoch advancement — everything is a pure function of time.
 *         Empty epoch budgets go to reserve (no rollover).
 */
contract AntseedEmissions is Ownable, ReentrancyGuard {
    // ─── Configuration ───
    IAntseedRegistry public registry;

    uint256 public immutable EPOCH_DURATION;
    uint256 public immutable HALVING_INTERVAL;
    uint256 public immutable INITIAL_EMISSION;
    uint256 public immutable genesis;

    uint256 public SELLER_SHARE_PCT;
    uint256 public BUYER_SHARE_PCT;
    uint256 public RESERVE_SHARE_PCT;
    uint256 public MAX_SELLER_SHARE_PCT;

    // ─── Per-Epoch Totals ───
    mapping(uint256 => uint256) public epochTotalSellerPoints;
    mapping(uint256 => uint256) public epochTotalBuyerPoints;

    // ─── Per-User State ───
    mapping(address => mapping(uint256 => uint256)) public userSellerPoints;
    mapping(address => mapping(uint256 => uint256)) public userBuyerPoints;
    mapping(address => mapping(uint256 => bool)) public userEpochClaimed;

    // ─── Reserve ───
    uint256 public reserveAccumulated;

    // ─── Events ───
    event SellerPointsAccrued(address indexed seller, uint256 indexed epoch, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 indexed epoch, uint256 pointsDelta);
    event EmissionsClaimed(address indexed claimer, uint256 amount, uint256[] epochs);
    event ReserveFlushed(address indexed destination, uint256 amount);

    // ─── Custom Errors ───
    error NotAuthorized();
    error EpochNotFinalized();
    error EpochAlreadyClaimed();
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
        genesis = block.timestamp;

        SELLER_SHARE_PCT = 65;
        BUYER_SHARE_PCT = 25;
        RESERVE_SHARE_PCT = 10;
        MAX_SELLER_SHARE_PCT = 15;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        EPOCH HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public view returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINT ACCRUAL
    // ═══════════════════════════════════════════════════════════════════

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlyChannels {
        uint256 epoch = currentEpoch();
        userSellerPoints[seller][epoch] += pointsDelta;
        epochTotalSellerPoints[epoch] += pointsDelta;
        emit SellerPointsAccrued(seller, epoch, pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlyChannels {
        uint256 epoch = currentEpoch();
        userBuyerPoints[buyer][epoch] += pointsDelta;
        epochTotalBuyerPoints[epoch] += pointsDelta;
        emit BuyerPointsAccrued(buyer, epoch, pointsDelta);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim emissions for a list of past epochs.
     *         Each epoch can only be claimed once per address.
     *         Epochs with no user activity are skipped (not marked as claimed).
     *
     * @param epochs  Array of epoch numbers to claim
     */
    function claimEmissions(uint256[] calldata epochs) external nonReentrant {
        uint256 _currentEpoch = currentEpoch();
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
        uint256 _currentEpoch = currentEpoch();
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
     * @dev Calculate a user's reward for a single past epoch.
     */
    function _calcEpochReward(
        address account,
        uint256 epoch,
        uint256 maxSellerPct
    ) internal view returns (uint256 sellerReward, uint256 sellerExcess, uint256 buyerReward) {
        uint256 emission = getEpochEmission(epoch);

        uint256 userSP = userSellerPoints[account][epoch];
        uint256 totalSP = epochTotalSellerPoints[epoch];
        if (userSP > 0 && totalSP > 0) {
            uint256 sBudget = (emission * SELLER_SHARE_PCT) / 100;
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
            uint256 bBudget = (emission * BUYER_SHARE_PCT) / 100;
            buyerReward = (userBP * bBudget) / totalBP;
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
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external onlyOwner {
        if (sellerPct + buyerPct + reservePct != 100) revert InvalidShareSum();
        SELLER_SHARE_PCT = sellerPct;
        BUYER_SHARE_PCT = buyerPct;
        RESERVE_SHARE_PCT = reservePct;
    }

    function setMaxSellerSharePct(uint256 value) external onlyOwner {
        if (value == 0 || value > 100) revert InvalidValue();
        MAX_SELLER_SHARE_PCT = value;
    }
}
