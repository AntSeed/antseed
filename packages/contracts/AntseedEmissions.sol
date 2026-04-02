// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedDeposits} from "./interfaces/IAntseedDeposits.sol";
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
contract AntseedEmissions is Ownable, Pausable, ReentrancyGuard {
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

    // ─── Per-Epoch Params (snapshotted on first touch) ───
    struct EpochParams {
        uint256 sellerSharePct;
        uint256 buyerSharePct;
        uint256 reserveSharePct;
        uint256 maxSellerSharePct;
        bool initialized;
    }
    mapping(uint256 => EpochParams) public epochParams;

    // ─── Per-Epoch Totals ───
    mapping(uint256 => uint256) public epochTotalSellerPoints;
    mapping(uint256 => uint256) public epochTotalBuyerPoints;

    // ─── Per-User State ───
    mapping(address => mapping(uint256 => uint256)) public userSellerPoints;
    mapping(address => mapping(uint256 => uint256)) public userBuyerPoints;
    mapping(address => mapping(uint256 => bool)) public sellerEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public buyerEpochClaimed;

    // ─── Reserve ───
    uint256 public reserveAccumulated;
    mapping(uint256 => bool) public epochReserveAccounted;

    // ─── Events ───
    event SellerPointsAccrued(address indexed seller, uint256 indexed epoch, uint256 pointsDelta);
    event BuyerPointsAccrued(address indexed buyer, uint256 indexed epoch, uint256 pointsDelta);
    event EmissionsClaimed(address indexed account, address indexed recipient, uint256 amount, uint256[] epochs);
    event ReserveFlushed(address indexed destination, uint256 amount);

    // ─── Custom Errors ───
    error NotAuthorized();
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

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlyChannels whenNotPaused {
        uint256 epoch = currentEpoch();
        _snapshotEpoch(epoch);
        userSellerPoints[seller][epoch] += pointsDelta;
        epochTotalSellerPoints[epoch] += pointsDelta;
        emit SellerPointsAccrued(seller, epoch, pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlyChannels whenNotPaused {
        uint256 epoch = currentEpoch();
        _snapshotEpoch(epoch);
        userBuyerPoints[buyer][epoch] += pointsDelta;
        epochTotalBuyerPoints[epoch] += pointsDelta;
        emit BuyerPointsAccrued(buyer, epoch, pointsDelta);
    }

    /// @dev Snapshot current share percentages on first touch for an epoch.
    function _snapshotEpoch(uint256 epoch) internal {
        if (!epochParams[epoch].initialized) {
            epochParams[epoch] = EpochParams({
                sellerSharePct: SELLER_SHARE_PCT,
                buyerSharePct: BUYER_SHARE_PCT,
                reserveSharePct: RESERVE_SHARE_PCT,
                maxSellerSharePct: MAX_SELLER_SHARE_PCT,
                initialized: true
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim seller emissions. Seller calls directly, tokens mint to msg.sender.
     */
    function claimSellerEmissions(uint256[] calldata epochs) external nonReentrant whenNotPaused {
        uint256 _currentEpoch = currentEpoch();
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) revert EpochNotFinalized();
            if (sellerEpochClaimed[msg.sender][epoch]) continue;
            if (userSellerPoints[msg.sender][epoch] == 0) continue;

            sellerEpochClaimed[msg.sender][epoch] = true;
            _accountReserve(epoch);

            EpochParams storage params = epochParams[epoch];
            uint256 userSP = userSellerPoints[msg.sender][epoch];
            uint256 totalSP = epochTotalSellerPoints[epoch];
            uint256 sBudget = (getEpochEmission(epoch) * params.sellerSharePct) / 100;
            uint256 reward = (userSP * sBudget) / totalSP;

            uint256 maxReward = (sBudget * params.maxSellerSharePct) / 100;
            if (reward > maxReward) {
                reserveAccumulated += reward - maxReward;
                reward = maxReward;
            }

            totalReward += reward;
        }

        if (totalReward > 0) {
            IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
            emit EmissionsClaimed(msg.sender, msg.sender, totalReward, epochs);
        }
    }

    /**
     * @notice Claim buyer emissions. Operator-only — tokens mint to operator (msg.sender).
     *         Buyer address never receives tokens directly.
     */
    function claimBuyerEmissions(address buyer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        if (IAntseedDeposits(registry.deposits()).getOperator(buyer) != msg.sender) revert NotAuthorized();

        uint256 _currentEpoch = currentEpoch();
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) revert EpochNotFinalized();
            if (buyerEpochClaimed[buyer][epoch]) continue;
            if (userBuyerPoints[buyer][epoch] == 0) continue;

            buyerEpochClaimed[buyer][epoch] = true;
            _accountReserve(epoch);

            EpochParams storage params = epochParams[epoch];
            uint256 userBP = userBuyerPoints[buyer][epoch];
            uint256 totalBP = epochTotalBuyerPoints[epoch];
            uint256 bBudget = (getEpochEmission(epoch) * params.buyerSharePct) / 100;
            totalReward += (userBP * bBudget) / totalBP;
        }

        if (totalReward > 0) {
            IANTSToken(registry.antsToken()).mint(msg.sender, totalReward);
            emit EmissionsClaimed(buyer, msg.sender, totalReward, epochs);
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

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= _currentEpoch) continue;
            if (!epochParams[epoch].initialized) continue;

            EpochParams storage params = epochParams[epoch];

            if (!sellerEpochClaimed[account][epoch] && userSellerPoints[account][epoch] > 0) {
                uint256 totalSP = epochTotalSellerPoints[epoch];
                if (totalSP > 0) {
                    uint256 sBudget = (getEpochEmission(epoch) * params.sellerSharePct) / 100;
                    uint256 reward = (userSellerPoints[account][epoch] * sBudget) / totalSP;
                    uint256 maxReward = (sBudget * params.maxSellerSharePct) / 100;
                    totalSeller += reward > maxReward ? maxReward : reward;
                }
            }

            if (!buyerEpochClaimed[account][epoch] && userBuyerPoints[account][epoch] > 0) {
                uint256 totalBP = epochTotalBuyerPoints[epoch];
                if (totalBP > 0) {
                    uint256 bBudget = (getEpochEmission(epoch) * params.buyerSharePct) / 100;
                    totalBuyer += (userBuyerPoints[account][epoch] * bBudget) / totalBP;
                }
            }
        }
    }

    function _accountReserve(uint256 epoch) internal {
        if (!epochReserveAccounted[epoch]) {
            epochReserveAccounted[epoch] = true;
            reserveAccumulated += (getEpochEmission(epoch) * epochParams[epoch].reserveSharePct) / 100;
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
