// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
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
 *         verifier pool. Budget, split AND both credit totals (the pro-rata
 *         denominators) are frozen at first touch of an epoch (claim or
 *         remainder settlement): a later gate or share config change cannot
 *         resize a finalized epoch's pots under remaining claimants, and
 *         every share already PAID is final. Credits landing late in an
 *         already-touched epoch are possible only under misconfigured
 *         epoch-clock wiring — the registry's swappable emissions clock
 *         lagging the gate's; production wiring runs both on one clock. The
 *         guarantees for that case are deliberately narrow: the gate's
 *         bucket budget can never be overdrawn, and late credits are
 *         rejected outright (`NothingToClaim`) only when the epoch froze
 *         with a ZERO total. Against a nonzero frozen total a late claimant
 *         claims first-come-first-served like everyone else and can exhaust
 *         the pool, so a pre-freeze claimant who has not yet claimed may
 *         later revert `BucketBudgetExceeded` — freezing pins denominators,
 *         it does not reserve per-claimant shares. Epochs with no
 *         verifier credits route the verifier pool through the gate's
 *         burn/reserve remainder path; pro-rata rounding dust of credited
 *         pools stays unminted by design.
 *
 *         This contract holds no funds: the gate mints ANTS directly to the
 *         claiming verifier or delegate.
 */
contract AntseedVerifierRewards is IAntseedVerifierRewards, ReentrancyGuard {
    using Math for uint256;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable gate;
    IAntseedVerifierRegistry public immutable verifierRegistry;
    /// @notice First epoch the gate will ever mint (its immutable
    ///         `effectiveEpoch`), cached at construction — same pattern as
    ///         AntseedUsageAccounting's `firstRewardedEpoch`.
    uint256 public immutable firstRewardedEpoch;

    // ─── Claim State ─────────────────────────────────────────────────
    /// @dev Budget frozen at first epoch touch (stored as budget + 1 so a
    ///      frozen zero is distinguishable from unset), mirroring the sibling
    ///      gate controllers.
    mapping(uint256 epoch => uint256 budgetPlusOne) private _frozenBudgets;
    /// @dev Delegate pool frozen together with the budget (pool + 1 sentinel)
    ///      so a delegateShareBps change never resizes a touched epoch.
    mapping(uint256 epoch => uint256 poolPlusOne) private _frozenDelegatePools;
    /// @dev Verifier-credit total frozen with the pools (total + 1 sentinel):
    ///      the pro-rata denominator for every claim in the epoch. Credits
    ///      landing after the freeze are outside the frozen claim set.
    mapping(uint256 epoch => uint256 totalPlusOne) private _frozenTotalCredits;
    /// @dev Delegate-credit total frozen with the pools (total + 1 sentinel).
    mapping(uint256 epoch => uint256 totalPlusOne) private _frozenTotalDelegateCredits;
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
        firstRewardedEpoch = IAntseedEmissionsGate(_gate).effectiveEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM VERIFIER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claim the caller's pro-rata share of the finalized epoch's
    ///         verification bucket. A zero-budget epoch still marks the claim
    ///         as spent without minting.
    function claimVerifierReward(uint256 epoch) external nonReentrant {
        uint256 amount = _claimPoolReward(epoch, epochRewardClaimed, false);
        emit VerifierRewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Claim the caller's pro-rata share of the finalized epoch's
    ///         delegate pool. The caller is a delegate PAYOUT address —
    ///         verifiers credit the operator address each delegate reported,
    ///         never the delegate's buyer hot wallet.
    function claimDelegateReward(uint256 epoch) external nonReentrant {
        uint256 amount = _claimPoolReward(epoch, epochDelegateRewardClaimed, true);
        emit DelegateRewardClaimed(epoch, msg.sender, amount);
    }

    /// @dev Shared claim spine for the verifier and delegate pools:
    ///      epoch-window checks, freeze-at-first-touch, zero-total handling,
    ///      pro-rata amount, claim mark and gate mint. `delegateSide` picks
    ///      which credits, pool and frozen total apply; the caller emits its
    ///      own event.
    function _claimPoolReward(
        uint256 epoch,
        mapping(uint256 epoch_ => mapping(address account => bool spent)) storage claimed,
        bool delegateSide
    ) private returns (uint256 amount) {
        if (epoch < firstRewardedEpoch) revert PreEffectiveEpoch();
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();

        uint256 credits = delegateSide
            ? verifierRegistry.epochDelegateCredits(epoch, msg.sender)
            : verifierRegistry.epochCredits(epoch, msg.sender);
        if (credits == 0) revert NothingToClaim();

        (uint256 verifierPool, uint256 delegatePool, uint256 totalCredits, uint256 totalDelegateCredits) =
            _freezeEpochPools(epoch);
        uint256 pool = delegateSide ? delegatePool : verifierPool;
        uint256 total = delegateSide ? totalDelegateCredits : totalCredits;
        // The epoch froze with a ZERO total, so the caller's credits landed
        // after the freeze (a lagging registry epoch clock): unclaimable.
        // A NONZERO frozen total does not filter late credits — they claim
        // against it first-come-first-served (see the contract natspec).
        if (total == 0) revert NothingToClaim();
        amount = Math.mulDiv(pool, credits, total);

        claimed[epoch][msg.sender] = true;
        if (amount != 0) gate.claim(epoch, msg.sender, amount);
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

        (uint256 verifierPool,, uint256 totalCredits,) = _freezeEpochPools(epoch);
        // The frozen total defines the claim set: an epoch frozen with
        // verifier credits stays claimable even if a lagging registry clock
        // could no longer credit it, and one frozen without credits is
        // settleable even if late credits land afterwards.
        if (totalCredits != 0) revert NothingToSettle();
        if (verifierPool == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, _emissionsReserve(), verifierPool);
        emit VerifierEpochRemainderSettled(epoch, verifierPool);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256) {
        return _pendingPoolReward(epoch, verifier, epochRewardClaimed, false);
    }

    function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256) {
        return _pendingPoolReward(epoch, delegate, epochDelegateRewardClaimed, true);
    }

    /// @dev View twin of `_claimPoolReward`: same window/claimed/zero-total
    ///      filters, returning 0 instead of reverting.
    function _pendingPoolReward(
        uint256 epoch,
        address account,
        mapping(uint256 epoch_ => mapping(address account_ => bool spent)) storage claimed,
        bool delegateSide
    ) private view returns (uint256) {
        if (epoch < firstRewardedEpoch || epoch >= gate.currentEpoch()) return 0;
        if (claimed[epoch][account]) return 0;

        uint256 credits = delegateSide
            ? verifierRegistry.epochDelegateCredits(epoch, account)
            : verifierRegistry.epochCredits(epoch, account);
        if (credits == 0) return 0;

        // Credits that landed after a ZERO-total freeze are unclaimable.
        uint256 totalCredits = delegateSide ? delegateEpochTotalCredits(epoch) : verifierEpochTotalCredits(epoch);
        if (totalCredits == 0) return 0;

        uint256 pool = delegateSide
            ? delegateEpochPool(epoch)
            : verifierEpochBudget(epoch) - delegateEpochPool(epoch);
        return Math.mulDiv(pool, credits, totalCredits);
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

    /// @notice Verifier-credit total used as the epoch's pro-rata claim
    ///         denominator: the snapshot frozen at first epoch touch, live
    ///         registry values before, exactly like `verifierEpochBudget`.
    function verifierEpochTotalCredits(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenTotalCredits[epoch];
        if (frozen != 0) return frozen - 1;
        return verifierRegistry.epochTotalCredits(epoch);
    }

    /// @notice Delegate-credit total used as the epoch's delegate-pool claim
    ///         denominator, frozen and read like `verifierEpochTotalCredits`.
    function delegateEpochTotalCredits(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenTotalDelegateCredits[epoch];
        if (frozen != 0) return frozen - 1;
        return verifierRegistry.epochTotalDelegateCredits(epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Freeze the epoch's budget, its verifier/delegate split AND both
    ///      credit totals at first touch. Crediting always lands in the
    ///      registry's CURRENT epoch, but that clock is swappable wiring
    ///      (`registry.emissions()`): were it ever to lag the gate's clock,
    ///      credits could land in an already-claimable epoch. Snapshotting
    ///      the totals — the pro-rata denominators — alongside the pools
    ///      keeps every already-paid share final and caps total minting at
    ///      the gate budget. It does NOT reserve shares for claimants who
    ///      have not claimed yet: a late credit against a nonzero frozen
    ///      total competes first-come-first-served for what remains (see the
    ///      contract natspec).
    function _freezeEpochPools(uint256 epoch)
        internal
        returns (uint256 verifierPool, uint256 delegatePool, uint256 totalCredits, uint256 totalDelegateCredits)
    {
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
            totalCredits = _frozenTotalCredits[epoch] - 1;
            totalDelegateCredits = _frozenTotalDelegateCredits[epoch] - 1;
        } else {
            totalCredits = verifierRegistry.epochTotalCredits(epoch);
            totalDelegateCredits = verifierRegistry.epochTotalDelegateCredits(epoch);
            delegatePool =
                totalDelegateCredits == 0 ? 0 : Math.mulDiv(budget, verifierRegistry.delegateShareBps(), 10_000);
            _frozenDelegatePools[epoch] = delegatePool + 1;
            _frozenTotalCredits[epoch] = totalCredits + 1;
            _frozenTotalDelegateCredits[epoch] = totalDelegateCredits + 1;
            emit VerifierEpochPoolsFrozen(epoch, budget - delegatePool, delegatePool);
        }
        verifierPool = budget - delegatePool;
    }

    /// @dev The gate owns reserve routing for every emissions bucket, so the
    ///      verifier controller must use the same resolved destination.
    function _emissionsReserve() internal view returns (address reserve) {
        reserve = gate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }
}
