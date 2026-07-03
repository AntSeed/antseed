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
 *         submitting audit attestations. Once an epoch is finalized, each
 *         credited verifier claims:
 *
 *         reward = verifierEpochBudget(epoch) * credits / totalCredits
 *
 *         The bucket budget is frozen at first touch of an epoch (claim or
 *         remainder settlement) so a later gate config change cannot resize
 *         a finalized epoch's pot under remaining claimants. Epochs with no
 *         credits route their whole bucket through the gate's burn/reserve
 *         remainder path; pro-rata rounding dust of credited epochs stays
 *         unminted by design.
 *
 *         This contract holds no funds: the gate mints ANTS directly to the
 *         claiming verifier.
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
    mapping(uint256 epoch => mapping(address verifier => bool claimed)) public epochRewardClaimed;
    mapping(uint256 epoch => bool settled) public epochRemainderSettled;

    // ─── Events ──────────────────────────────────────────────────────
    event VerifierEpochBudgetFrozen(uint256 indexed epoch, uint256 budget);
    event VerifierRewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);
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

        uint256 budget = _freezeEpochBudget(epoch);
        uint256 amount = Math.mulDiv(budget, credits, totalCredits);

        epochRewardClaimed[epoch][msg.sender] = true;
        if (amount != 0) gate.claim(epoch, msg.sender, amount);
        emit VerifierRewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Route a finalized zero-credit epoch's whole bucket through the
    ///         gate's burn/reserve remainder path. Epochs with credits have
    ///         their entire frozen budget allocated pro-rata — nothing to
    ///         settle.
    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();
        if (verifierRegistry.epochTotalCredits(epoch) != 0) revert NothingToSettle();

        uint256 budget = _freezeEpochBudget(epoch);
        if (budget == 0) revert NothingToSettle();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, _emissionsReserve(), budget);
        emit VerifierEpochRemainderSettled(epoch, budget);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256) {
        if (epoch < gate.effectiveEpoch() || epoch >= gate.currentEpoch()) return 0;
        if (epochRewardClaimed[epoch][verifier]) return 0;

        uint256 credits = verifierRegistry.epochCredits(epoch, verifier);
        if (credits == 0) return 0;

        return Math.mulDiv(verifierEpochBudget(epoch), credits, verifierRegistry.epochTotalCredits(epoch));
    }

    function verifierEpochBudget(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        return gate.controllerEpochBudget(address(this), epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _freezeEpochBudget(uint256 epoch) internal returns (uint256 budget) {
        uint256 frozen = _frozenBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        budget = gate.controllerEpochBudget(address(this), epoch);
        _frozenBudgets[epoch] = budget + 1;
        emit VerifierEpochBudgetFrozen(epoch, budget);
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
