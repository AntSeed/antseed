// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistryV2 } from "../interfaces/IAntseedRegistryV2.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";
import { IAntseedVerifierRewards } from "../interfaces/IAntseedVerifierRewards.sol";

/**
 * @title AntseedVerifierRewards
 * @notice Emissions-gate bucket controller for the verification bucket
 *         (`keccak256("antseed.emissions.verification.v1")`).
 *
 *         Verifiers earn per-epoch credits in AntseedVerifierRegistry by
 *         submitting audit attestations; delegate buyers (the organic peers
 *         that carry probe traffic) earn delegate credits granted by the
 *         verifiers they served. For epochs with delegate credits the bucket
 *         splits into two pools by `registry.delegateShareBps()`:
 *
 *         delegatePool  = budget * delegateShareBps / 10_000
 *         verifierPool  = budget - delegatePool
 *
 *         verifier reward = verifierPool * credits / totalCredits
 *         delegate reward = delegatePool * delegateCredits / totalDelegateCredits
 *
 *         Epochs with no delegate credits keep the whole budget in the
 *         verifier pool. Budget AND split are frozen at first touch of an
 *         epoch (claim or remainder settlement) so a later gate or share
 *         config change cannot resize a finalized epoch's pots under
 *         remaining claimants. Epochs with no verifier credits route the
 *         verifier pool through the gate's burn/reserve remainder path;
 *         pro-rata rounding dust of credited pools stays unminted by design.
 *
 *         This contract holds no funds: the gate mints ANTS directly to the
 *         claiming verifier or delegate.
 */
contract AntseedVerifierRewards is IAntseedVerifierRewards, ReentrancyGuard {
    using Math for uint256;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable gate;
    IAntseedVerifierRegistry public immutable verifierRegistry;

    // ─── Claim State ─────────────────────────────────────────────────
    /// @dev Budget frozen at first epoch touch (stored as budget + 1 so a
    ///      frozen zero is distinguishable from unset), mirroring the sibling
    ///      gate controllers.
    mapping(uint256 epoch => uint256 budgetPlusOne) private _frozenBudgets;
    /// @dev Delegate pool frozen together with the budget (pool + 1 sentinel)
    ///      so a delegateShareBps change never resizes a touched epoch.
    mapping(uint256 epoch => uint256 poolPlusOne) private _frozenDelegatePools;
    mapping(uint256 epoch => mapping(address verifier => bool claimed)) public epochRewardClaimed;
    mapping(uint256 epoch => mapping(address delegate => bool claimed)) public epochDelegateRewardClaimed;
    mapping(uint256 epoch => bool settled) public epochRemainderSettled;

    // ─── Events ──────────────────────────────────────────────────────
    event VerifierEpochBudgetFrozen(uint256 indexed epoch, uint256 budget);
    event VerifierEpochPoolsFrozen(uint256 indexed epoch, uint256 verifierPool, uint256 delegatePool);
    event VerifierRewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);
    event DelegateRewardClaimed(uint256 indexed epoch, address indexed delegate, uint256 amount);
    event VerifierEpochRemainderSettled(uint256 indexed epoch, uint256 amount);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error PreEffectiveEpoch();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();
    error NothingToSettle();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _gate, address _verifierRegistry) {
        if (_gate == address(0) || _verifierRegistry == address(0)) revert InvalidAddress();
        gate = IAntseedEmissionsGate(_gate);
        verifierRegistry = IAntseedVerifierRegistry(_verifierRegistry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM VERIFIER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claim the caller's pro-rata share of the finalized epoch's
    ///         verification bucket. A zero-budget epoch still marks the claim
    ///         as spent without minting.
    function claimVerifierReward(uint256 epoch) external nonReentrant {
        if (epoch < gate.effectiveEpoch()) revert PreEffectiveEpoch();
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        if (epochRewardClaimed[epoch][msg.sender]) revert AlreadyClaimed();

        uint256 credits = verifierRegistry.epochCredits(epoch, msg.sender);
        if (credits == 0) revert NothingToClaim();
        uint256 totalCredits = verifierRegistry.epochTotalCredits(epoch);

        (uint256 verifierPool,) = _freezeEpochPools(epoch);
        uint256 amount = Math.mulDiv(verifierPool, credits, totalCredits);

        epochRewardClaimed[epoch][msg.sender] = true;
        if (amount != 0) gate.claim(epoch, msg.sender, amount);
        emit VerifierRewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Claim the caller's pro-rata share of the finalized epoch's
    ///         delegate pool. The caller is a delegate PAYOUT address —
    ///         verifiers credit the operator address each delegate reported,
    ///         never the delegate's buyer hot wallet.
    function claimDelegateReward(uint256 epoch) external nonReentrant {
        if (epoch < gate.effectiveEpoch()) revert PreEffectiveEpoch();
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        if (epochDelegateRewardClaimed[epoch][msg.sender]) revert AlreadyClaimed();

        uint256 credits = verifierRegistry.epochDelegateCredits(epoch, msg.sender);
        if (credits == 0) revert NothingToClaim();
        uint256 totalCredits = verifierRegistry.epochTotalDelegateCredits(epoch);

        (, uint256 delegatePool) = _freezeEpochPools(epoch);
        uint256 amount = Math.mulDiv(delegatePool, credits, totalCredits);

        epochDelegateRewardClaimed[epoch][msg.sender] = true;
        if (amount != 0) gate.claim(epoch, msg.sender, amount);
        emit DelegateRewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Route a finalized epoch's unclaimable verifier pool through
    ///         the gate's burn/reserve remainder path. Only the verifier pool
    ///         can be unclaimable (no verifier credits): the delegate pool is
    ///         zero by construction when the epoch has no delegate credits.
    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();
        if (verifierRegistry.epochTotalCredits(epoch) != 0) revert NothingToSettle();

        (uint256 verifierPool,) = _freezeEpochPools(epoch);
        if (verifierPool == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, _emissionsReserve(), verifierPool);
        emit VerifierEpochRemainderSettled(epoch, verifierPool);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256) {
        if (epoch < gate.effectiveEpoch() || epoch >= gate.currentEpoch()) return 0;
        if (epochRewardClaimed[epoch][verifier]) return 0;

        uint256 credits = verifierRegistry.epochCredits(epoch, verifier);
        if (credits == 0) return 0;

        uint256 verifierPool = verifierEpochBudget(epoch) - delegateEpochPool(epoch);
        return Math.mulDiv(verifierPool, credits, verifierRegistry.epochTotalCredits(epoch));
    }

    function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256) {
        if (epoch < gate.effectiveEpoch() || epoch >= gate.currentEpoch()) return 0;
        if (epochDelegateRewardClaimed[epoch][delegate]) return 0;

        uint256 credits = verifierRegistry.epochDelegateCredits(epoch, delegate);
        if (credits == 0) return 0;

        return Math.mulDiv(delegateEpochPool(epoch), credits, verifierRegistry.epochTotalDelegateCredits(epoch));
    }

    function verifierEpochBudget(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        return gate.controllerEpochBudget(address(this), epoch);
    }

    /// @notice Delegate slice of the epoch's bucket. Zero when the epoch has
    ///         no delegate credits. Live values until the epoch's pools are
    ///         frozen, exactly like `verifierEpochBudget`.
    function delegateEpochPool(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenDelegatePools[epoch];
        if (frozen != 0) return frozen - 1;
        if (verifierRegistry.epochTotalDelegateCredits(epoch) == 0) return 0;
        return Math.mulDiv(verifierEpochBudget(epoch), verifierRegistry.delegateShareBps(), 10_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Freeze the epoch's budget and its verifier/delegate split at
    ///      first touch. Delegate credit totals are immutable once the epoch
    ///      is finalized (crediting always lands in the registry's current
    ///      epoch), so the split computed here is final.
    function _freezeEpochPools(uint256 epoch) internal returns (uint256 verifierPool, uint256 delegatePool) {
        uint256 frozenBudget = _frozenBudgets[epoch];
        uint256 budget;
        if (frozenBudget != 0) {
            budget = frozenBudget - 1;
        } else {
            budget = gate.controllerEpochBudget(address(this), epoch);
            _frozenBudgets[epoch] = budget + 1;
            emit VerifierEpochBudgetFrozen(epoch, budget);
        }

        uint256 frozenPool = _frozenDelegatePools[epoch];
        if (frozenPool != 0) {
            delegatePool = frozenPool - 1;
        } else {
            delegatePool = verifierRegistry.epochTotalDelegateCredits(epoch) == 0
                ? 0
                : Math.mulDiv(budget, verifierRegistry.delegateShareBps(), 10_000);
            _frozenDelegatePools[epoch] = delegatePool + 1;
            emit VerifierEpochPoolsFrozen(epoch, budget - delegatePool, delegatePool);
        }
        verifierPool = budget - delegatePool;
    }

    /// @dev ANTS reserve flows go to the registry's dedicated emissions
    ///      reserve; while the split is unset they fall back to the fee
    ///      reserve (`protocolReserve`). The verifier registry this controller
    ///      is wired to must live on a v2 registry.
    function _emissionsReserve() internal view returns (address reserve) {
        IAntseedRegistryV2 registry = IAntseedRegistryV2(address(verifierRegistry.registry()));
        reserve = registry.emissionsReserve();
        if (reserve == address(0)) reserve = registry.protocolReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }
}
