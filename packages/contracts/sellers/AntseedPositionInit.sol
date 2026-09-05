// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

/**
 * @title AntseedPositionInit
 * @notice One-shot ANTS starter positions that bootstrap seller-pool
 *         accounting.
 *
 *         Usage accounting ignores pools with zero power, so at cutover no
 *         recognized-usage reward can accrue until someone stakes ANTS — which
 *         nobody holds while transfers are disabled. This contract lets each
 *         existing legacy seller create one small pre-funded position in their
 *         own agent pool, turning their accounting on.
 *
 *         Eligibility is anchored to the legacy USDC staking contract: the
 *         caller must have an agent binding there and stake above the legacy
 *         minimum, so only sellers who put up real USDC stake can claim.
 *         Sellers the wash-trading registry has proven as wash traders are
 *         refused: a starter position is what switches their recognized-usage
 *         accounting on, and proven wash usage must never be recognized.
 *
 *         All starter positions share one fixed `initEndEpoch` instead of a
 *         fixed lock duration: a claim locks from its activation epoch until
 *         that end. Position power at epoch e is amount * (endEpoch - e), so
 *         every starter position has identical power at every epoch no matter
 *         when it was claimed — a late claim never outweighs an early one.
 *
 *         Deliberately unowned: no admin, no sweep, no pause, no setters. The
 *         faucet switches itself off two ways: when the funded pot runs out,
 *         and permanently once `initEndEpoch` is no longer a full epoch past
 *         the activation epoch. Leftover balance strands here forever, so
 *         fund it in small increments.
 */
contract AntseedPositionInit is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedSellerPools public immutable sellerPools;
    IAntseedStaking public immutable legacyStaking;
    IAntseedWashTradingStatus public immutable washTradingRegistry;
    IERC20 public immutable antsToken;

    // ─── Position Terms ──────────────────────────────────────────────
    uint256 public immutable initAmount;
    uint256 public immutable initEndEpoch;

    // ─── Claim Tracking ──────────────────────────────────────────────
    mapping(uint256 => bool) public agentInitialized;

    // ─── Events ──────────────────────────────────────────────────────
    event PositionInitialized(
        address indexed seller, uint256 indexed agentId, uint256 positionId, uint256 amount, uint256 stakeEpochs
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NotLegacySeller();
    error WashTrader();
    error AlreadyInitialized();
    error InitDepleted();
    error InitExpired();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _sellerPools,
        address _legacyStaking,
        address _washTradingRegistry,
        uint256 _initAmount,
        uint256 _initEndEpoch
    ) {
        if (_sellerPools == address(0) || _legacyStaking == address(0) || _washTradingRegistry == address(0)) {
            revert InvalidAddress();
        }
        if (_initAmount == 0) revert InvalidValue();
        if (_initEndEpoch <= IAntseedSellerPools(_sellerPools).currentEpoch()) revert InvalidValue();

        sellerPools = IAntseedSellerPools(_sellerPools);
        legacyStaking = IAntseedStaking(_legacyStaking);
        washTradingRegistry = IAntseedWashTradingStatus(_washTradingRegistry);
        initAmount = _initAmount;
        initEndEpoch = _initEndEpoch;

        // Approve the token pools actually pulls — its pinned immutable.
        IERC20 token = IAntseedSellerPools(_sellerPools).antsToken();
        if (address(token) == address(0)) revert InvalidAddress();
        antsToken = token;
        token.forceApprove(_sellerPools, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — INIT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Create one position of `initAmount` ANTS in the caller's own
     *         agent pool, locked from the next activation epoch until
     *         `initEndEpoch`. The lANTS position belongs to the caller.
     *         One starter position per agent id, forever. Proven wash traders
     *         are refused.
     */
    function initPosition() external nonReentrant returns (uint256 positionId) {
        uint256 agentId = legacyStaking.getAgentId(msg.sender);
        if (agentId == 0 || !legacyStaking.isStakedAboveMin(msg.sender)) revert NotLegacySeller();
        if (washTradingRegistry.isProvenWashTrader(msg.sender)) revert WashTrader();
        if (agentInitialized[agentId]) revert AlreadyInitialized();
        if (antsToken.balanceOf(address(this)) < initAmount) revert InitDepleted();

        // stakeFor recomputes the same activation epoch in this transaction,
        // so the created position ends exactly at initEndEpoch.
        uint256 startEpoch = sellerPools.currentEpoch() + sellerPools.stakeActivationDelay();
        if (startEpoch >= initEndEpoch) revert InitExpired();
        uint256 stakeEpochs = initEndEpoch - startEpoch;

        agentInitialized[agentId] = true;
        positionId = sellerPools.stakeFor(msg.sender, agentId, initAmount, stakeEpochs);
        emit PositionInitialized(msg.sender, agentId, positionId, initAmount, stakeEpochs);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Number of starter positions the current pot can still pay.
    function remainingInits() external view returns (uint256) {
        return antsToken.balanceOf(address(this)) / initAmount;
    }
}
