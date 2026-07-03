// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedVerifierRegistry } from "../interfaces/IAntseedVerifierRegistry.sol";

/**
 * @title AntseedVerifierPointsPolicy
 * @notice Recognized-usage points policy that shapes seller points by the
 *         seller's model-verification standing in AntseedVerifierRegistry.
 *
 *         A seller whose agent has ever been flagged DIFF (served a different
 *         model than advertised) has its seller points cut by
 *         `diffPenaltyBps` (default 100% — zero seller emissions). Buyer
 *         points always pass through unchanged: buyers are not responsible
 *         for a seller's model fraud.
 *
 *         Sellers that cannot be resolved to an agentId (unstaked, unknown,
 *         or misconfigured staking wiring) pass through unchanged — absence
 *         of an audit is not a penalty.
 *
 *         NEVER-REVERT INVARIANT: `points` must not revert on any input.
 *         AntseedUsageAccounting wraps the policy call in try/catch, but a
 *         reverting policy zeroes the whole usage record, so every external
 *         read here is code-size guarded and try/catch wrapped, falling back
 *         to pass-through `(rawPoints, rawPoints)`. This contract holds no
 *         funds and writes no state on the points path.
 */
contract AntseedVerifierPointsPolicy is IAntseedPointsPolicy, Ownable2Step {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedRegistry public immutable registry;
    IAntseedVerifierRegistry public immutable verifierRegistry;

    // ─── Config ──────────────────────────────────────────────────────
    /// @notice Seller-points penalty applied when the seller's agent is
    ///         DIFF-flagged, in basis points. 10_000 = seller earns nothing.
    uint16 public diffPenaltyBps = 10_000;

    // ─── Events ──────────────────────────────────────────────────────
    event DiffPenaltyBpsSet(uint16 diffPenaltyBps);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry, address _verifierRegistry) Ownable(msg.sender) {
        if (_registry == address(0) || _verifierRegistry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        verifierRegistry = IAntseedVerifierRegistry(_verifierRegistry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OWNER CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════

    function setDiffPenaltyBps(uint16 _diffPenaltyBps) external onlyOwner {
        if (_diffPenaltyBps > BPS_DENOMINATOR) revert InvalidValue();
        diffPenaltyBps = _diffPenaltyBps;
        emit DiffPenaltyBpsSet(_diffPenaltyBps);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINTS POLICY
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IAntseedPointsPolicy
    /// @dev Buyer points always equal `rawPoints`. Seller points equal
    ///      `rawPoints` unless the seller's agent-level verification stats
    ///      carry a DIFF flag, in which case `diffPenaltyBps` is shaved off.
    ///      Any failure to resolve the seller or its stats passes through
    ///      unchanged — this function never reverts.
    function points(bytes32, /* channelId */ address, /* buyer */ address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        buyerPoints = rawPoints;
        sellerPoints = rawPoints;

        uint256 agentId = _resolveAgentId(seller);
        if (agentId == 0) return (sellerPoints, buyerPoints);

        if (address(verifierRegistry).code.length == 0) return (sellerPoints, buyerPoints);
        try verifierRegistry.agentVerificationStats(agentId) returns (
            IAntseedVerifierRegistry.ServiceVerificationStats memory stats
        ) {
            bool diffFlagged =
                stats.diffCount > 0 || stats.lastVerdict == uint8(IAntseedVerifierRegistry.Verdict.DIFF);
            if (diffFlagged) {
                sellerPoints = _applyKeepBps(rawPoints, BPS_DENOMINATOR - diffPenaltyBps);
            }
        } catch {
            // Misconfigured verifier registry: pass through unchanged.
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Resolve `seller` to its staked agentId via `registry.staking()`.
    ///      Returns 0 (pass-through sentinel) on any failure: registry or
    ///      staking without code, unset staking address, or a reverting
    ///      `getAgentId`. Code-size checks are required in addition to
    ///      try/catch — a code-less target returns empty returndata and the
    ///      resulting decode failure would NOT be caught by the catch clause.
    function _resolveAgentId(address seller) internal view returns (uint256) {
        if (address(registry).code.length == 0) return 0;
        address staking;
        try registry.staking() returns (address stakingAddress) {
            staking = stakingAddress;
        } catch {
            return 0;
        }
        if (staking == address(0) || staking.code.length == 0) return 0;
        try IAntseedStaking(staking).getAgentId(seller) returns (uint256 agentId) {
            return agentId;
        } catch {
            return 0;
        }
    }

    /// @dev floor(amount * keepBps / BPS_DENOMINATOR) without overflow for
    ///      any `amount` (splitting quotient and remainder keeps every
    ///      intermediate product below 1e8) — `amount * keepBps` could wrap
    ///      for extreme raw points and this function must never revert.
    function _applyKeepBps(uint256 amount, uint256 keepBps) internal pure returns (uint256) {
        return (amount / BPS_DENOMINATOR) * keepBps + ((amount % BPS_DENOMINATOR) * keepBps) / BPS_DENOMINATOR;
    }
}
