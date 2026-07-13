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
 *         A seller is penalized only while at least
 *         `minDistinctDiffVerifiers` distinct verifiers' LATEST verdicts for
 *         its agent are DIFF (`activeDiffVerifierCount`). This makes the
 *         penalty corroborated — one mistaken or malicious verifier cannot
 *         zero a seller alone — and reversible: a verifier re-attesting SAME
 *         retracts its own standing DIFF, unlike the monotonic historical
 *         `diffCount`. While flagged, seller points are cut by
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
 *         read here goes through a raw, code-size-guarded staticcall with an
 *         explicit returndata-length check, falling back to pass-through
 *         `(rawPoints, rawPoints)`. Solidity's try/catch does NOT catch
 *         returndata-decode failures — a target with a permissive
 *         non-reverting fallback (success, empty returndata) would revert the
 *         caller's decode uncaught — so try/catch alone cannot uphold the
 *         invariant. This contract holds no funds and writes no state on the
 *         points path.
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

    /// @notice Distinct verifiers whose standing verdict must be DIFF before
    ///         the penalty applies. Default 2: a single verifier — mistaken,
    ///         malicious, or fed by a colluding cohort — cannot zero a
    ///         seller's emissions on its own. Aligned with the buyer-side
    ///         routing score, which also requires two distinct verifiers for
    ///         corroboration.
    uint16 public minDistinctDiffVerifiers = 2;

    // ─── Events ──────────────────────────────────────────────────────
    event DiffPenaltyBpsSet(uint16 diffPenaltyBps);
    event MinDistinctDiffVerifiersSet(uint16 minDistinctDiffVerifiers);

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

    function setMinDistinctDiffVerifiers(uint16 _minDistinctDiffVerifiers) external onlyOwner {
        if (_minDistinctDiffVerifiers == 0) revert InvalidValue();
        minDistinctDiffVerifiers = _minDistinctDiffVerifiers;
        emit MinDistinctDiffVerifiersSet(_minDistinctDiffVerifiers);
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

        (bool ok, uint256 activeDiffVerifierCount) = _readActiveDiffVerifierCount(agentId);
        // Misconfigured verifier registry: pass through unchanged.
        if (!ok) return (sellerPoints, buyerPoints);

        // Standing, corroborated accusations only: `activeDiffVerifierCount`
        // tracks distinct verifiers whose latest verdict is DIFF, so the
        // flag clears when accusers retract — unlike the monotonic
        // `diffCount`, which would make one false positive permanent.
        bool diffFlagged = activeDiffVerifierCount >= minDistinctDiffVerifiers;
        if (diffFlagged) {
            sellerPoints = _applyKeepBps(rawPoints, BPS_DENOMINATOR - diffPenaltyBps);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Resolve `seller` to its staked agentId via `registry.staking()`.
    ///      Returns 0 (pass-through sentinel) on any failure: registry or
    ///      staking without code, unset staking address, or a reverting or
    ///      malformed `getAgentId`. Both hops use `_guardedStaticcall` — the
    ///      mutable staking pointer especially could be repointed at a
    ///      contract whose permissive fallback answers every call with empty
    ///      returndata, which try/catch cannot survive (see the contract
    ///      natspec).
    function _resolveAgentId(address seller) internal view returns (uint256) {
        (bool ok, bytes memory data) =
            _guardedStaticcall(address(registry), abi.encodeCall(IAntseedRegistry.staking, ()), 32);
        if (!ok) return 0;
        // Mask to 160 bits instead of abi.decode-ing an address: garbage in
        // the upper bits must degrade to "not a staking contract" (the
        // code-size guard on the next hop), never to a decode revert.
        address staking = address(uint160(abi.decode(data, (uint256))));
        if (staking == address(0)) return 0;

        (ok, data) = _guardedStaticcall(staking, abi.encodeCall(IAntseedStaking.getAgentId, (seller)), 32);
        if (!ok) return 0;
        return abi.decode(data, (uint256));
    }

    /// @dev Read `agentVerificationStats(agentId).activeDiffVerifierCount`
    ///      from the verifier registry. The struct ABI-encodes as seven
    ///      static 32-byte words with the count last; decoding the words as
    ///      raw uint256 keeps a malformed (but long-enough) response from
    ///      reverting the way typed decoding of uint32/address fields would.
    function _readActiveDiffVerifierCount(uint256 agentId) internal view returns (bool ok, uint256 count) {
        bytes memory data;
        (ok, data) = _guardedStaticcall(
            address(verifierRegistry),
            abi.encodeCall(IAntseedVerifierRegistry.agentVerificationStats, (agentId)),
            7 * 32
        );
        if (!ok) return (false, 0);
        (,,,,,, count) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    /// @dev Code-size-guarded raw staticcall that treats every anomaly —
    ///      code-less target, revert, or returndata shorter than
    ///      `minReturndataSize` — as failure instead of bubbling a revert.
    ///      This is the only safe shape for the never-revert invariant:
    ///      Solidity's try/catch catches the callee's revert but NOT the
    ///      caller-side returndata-decode failure a permissive non-reverting
    ///      fallback (success, empty returndata) produces.
    function _guardedStaticcall(address target, bytes memory callData, uint256 minReturndataSize)
        internal
        view
        returns (bool ok, bytes memory data)
    {
        if (target.code.length == 0) return (false, data);
        (ok, data) = target.staticcall(callData);
        if (data.length < minReturndataSize) ok = false;
    }

    /// @dev floor(amount * keepBps / BPS_DENOMINATOR) without overflow for
    ///      any `amount` (splitting quotient and remainder keeps every
    ///      intermediate product below 1e8) — `amount * keepBps` could wrap
    ///      for extreme raw points and this function must never revert.
    function _applyKeepBps(uint256 amount, uint256 keepBps) internal pure returns (uint256) {
        return (amount / BPS_DENOMINATOR) * keepBps + ((amount % BPS_DENOMINATOR) * keepBps) / BPS_DENOMINATOR;
    }
}
