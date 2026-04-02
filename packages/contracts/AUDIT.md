# AntSeed Smart Contract Audit

**Date:** 2026-04-02
**Scope:** All contracts in `packages/contracts/`
**Status:** Findings documented, no fixes applied yet

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Critical Findings](#critical-findings)
- [High Severity](#high-severity)
- [Medium Severity](#medium-severity)
- [Low Severity](#low-severity)
- [Gas Optimizations](#gas-optimizations)
- [Design Observations](#design-observations)

---

## Architecture Overview

The protocol uses a separation pattern:

| Contract | Role | Holds Funds? |
|---|---|---|
| AntseedDeposits | Buyer USDC custody, operator management, seller payouts | Yes (USDC) |
| AntseedStaking | Seller staking, slashing | Yes (USDC) |
| AntseedChannels | Channel lifecycle, EIP-712 verification, settlement | No (swappable) |
| AntseedEmissions | Epoch-based ANTS token emissions | No (mints via ANTSToken) |
| AntseedSubPool | Subscription tiers, revenue distribution to peers | Yes (USDC) |
| ANTSToken | ERC-20 with transfer lock, emissions-only minting | N/A |
| AntseedRegistry | Central address book | No |

All contracts reference the Registry for sibling addresses. Channels is designed to be swappable (holds no funds). Deposits and Staking are stable (hold funds).

---

## Critical Findings

### ~~C1. Platform fee silently zeroed when `protocolReserve` is unset~~ — WONTFIX

Intentional behavior. No protocol reserve = no fee.

---

### ~~C2. Deposit should require operator to be set first~~ — FIXED

**File:** `AntseedDeposits.sol:113-124`

Currently anyone can call `deposit(buyer, amount)` before an operator is set. Without an operator, the deposited funds cannot be withdrawn (withdraw requires operator), channels cannot be closed by the buyer side (requestClose requires operator), and emissions cannot be claimed.

**Impact:** Funds deposited without an operator are effectively locked until an operator is set. If the buyer loses their signing key before setting an operator, funds are permanently locked.

**Recommendation:** Require `buyers[buyer].operator != address(0)` before accepting deposits, ensuring the operator authorization flow completes first.

**Fix:** `deposit()` now checks `_isOperator(buyer)` — msg.sender must be the buyer's authorized operator. Updated tests and `setup-local-test.sh` to set operator before depositing.

---

## High Severity

### ~~H1. Emissions lets owner rewrite historical rewards for finished epochs~~ — FIXED

**File:** `AntseedEmissions.sol:137-169, 175-200, 266-271`

`claimSellerEmissions`, `claimBuyerEmissions`, and `_accountReserve` all calculate epoch payouts using the **current** values of `SELLER_SHARE_PCT`, `BUYER_SHARE_PCT`, `RESERVE_SHARE_PCT`, and `MAX_SELLER_SHARE_PCT` at claim time. These values are mutable via `setSharePercentages` and `setMaxSellerSharePct`, and there is no per-epoch snapshot.

The owner can change reward splits after an epoch has finished but before users claim, effectively changing historical seller, buyer, and reserve allocations retroactively.

**Impact:** Users cannot rely on finalized epoch economics. Governance or owner action can silently reduce seller/buyer rewards for past epochs, or redirect more issuance into reserve.

**Recommendation:** Snapshot all emission parameters per epoch when the epoch becomes claimable, or store them lazily on first accounting for that epoch and never allow later mutation for the same epoch.

**Fix:** Added `EpochParams` struct with lazy snapshot via `_snapshotEpoch()` on first `accrueSellerPoints`/`accrueBuyerPoints` call per epoch. All claim and reserve logic now reads from the snapshotted values instead of current storage.

---

### ~~H2. No permissionless channel timeout — liveness/fund-lock risk~~ — PARTIALLY FIXED

**File:** `AntseedChannels.sol`

The `deadline` field is correctly used as a **reserve authorization limit** — the buyer signs a ReserveAuth valid until the deadline, and `reserve()`/`topUp()` enforce it. It is intentionally NOT checked on `settle()`/`close()` because the seller should always be able to collect earned funds regardless of time.

Previously, closing a channel required either a buyer-signed SpendingAuth or the buyer's operator. If the buyer operator disappeared and the seller had no SpendingAuth, funds were locked indefinitely.

**Fix:** Added `abandon(channelId)` — seller can close any channel without a SpendingAuth. No additional charge; remaining reserved USDC is released back to the buyer. This unblocks the seller's `activeChannelCount` so they can unstake.

**Remaining risk:** If the buyer's operator is lost and the seller also disappears, buyer funds stay locked. A fully permissionless timeout (callable by anyone after a long period) would address this edge case.

---

### H3. Operator cannot be revoked — only transferred

**File:** `AntseedDeposits.sol:230-259`

Once `setOperator` is called, there is no way to remove the operator (set back to `address(0)`). `transferOperator` requires the current operator to call it, and `setOperator` reverts if an operator already exists (`OperatorAlreadySet`). If the operator key is compromised:

- Operator can drain all unreserved buyer funds via `withdraw()`
- Operator can claim buyer emissions via `claimBuyerEmissions()`
- Operator can `requestCloseAll` + `withdrawAll` on all buyer channels
- Buyer has **no recourse** — no revocation path exists

**Recommendation:** Add `revokeOperator(buyer, nonce, buyerSig)` using EIP-712 that lets the buyer sign a revocation, resetting operator to `address(0)`.

---

### H4. `transferOperator` has no buyer consent

**File:** `AntseedDeposits.sol:255-260`

The current operator can unilaterally transfer control to any address without the buyer's signature. A compromised operator can transfer to another compromised address, making social recovery harder.

**Recommendation:** Require buyer's EIP-712 signature for operator transfers, or add a timelock.

---

### H5. Unbounded `optedInPeers` array in SubPool — DoS risk

**File:** `AntseedSubPool.sol:54, 261-267, 296-322`

`optedInPeers` is an unbounded dynamic array iterated in:
- `distributeRevenue()` — O(n) loop with external calls to `getAgentStats` per peer
- `optOut()` — O(n) search to find and remove
- `getProjectedRevenue()` — O(n) loop

If hundreds or thousands of peers opt in, `distributeRevenue()` will exceed the block gas limit and become uncallable, permanently locking subscription revenue.

**Recommendation:** Use a pull-based pattern or cap the array size. Consider an enumerable set with O(1) removal.

---

### H6. `_recordCloseStats` double-counts volume

**File:** `AntseedChannels.sol:486`

```solidity
s.totalVolumeUsdc += cumulativeUsdc;
```

On `close()`, `totalVolumeUsdc` is incremented by the **full** `cumulativeUsdc` (which includes already-settled amounts from prior `settle()` calls). While `_agentStats.totalVolumeUsdc` is used for reputation (not payments), it inflates the seller's apparent volume, affecting SubPool revenue distribution weights.

**Recommendation:** Track only the delta: `s.totalVolumeUsdc += delta` (finalAmount - previouslySettled).

---

## Medium Severity

### M1. Channel lifecycle is not state-machine safe

**File:** `AntseedChannels.sol`

Channel transitions are implicit, not formally enforced via a state machine. The status enum is `{ None, Active, Settled, TimedOut }` but there is no explicit `Closing` state between `requestClose` and `withdraw`. Enforcement relies on checking individual fields (`closeRequestedAt != 0`, `status == Active`, etc.) rather than a strict transition table.

**Risks:**
- Potential for unexpected state combinations (e.g., closeRequested + settle in same block)
- No formal invariant that settled <= deposit at all times (enforced by checks but not by type)
- `settle()` is still callable after `requestClose` during the grace period (intentional, but makes reasoning harder)

**Recommendation:** Document the intended state machine explicitly. Consider adding a `Closing` status and enforcing transitions in a single modifier.

---

### M2. Missing replay protection / weak nonce discipline in off-chain signatures

**File:** `AntseedChannels.sol:516-554`

EIP-712 signatures (`SpendingAuth`, `ReserveAuth`) bind to `channelId` but:
- `SpendingAuth` has no nonce — relies solely on `cumulativeAmount` being monotonically increasing
- `ReserveAuth` has no nonce — binds to `channelId + maxAmount + deadline`
- Signatures are not invalidated on channel close — a closed channel can't be reopened (good), but the signature could theoretically be used if the same `channelId` were somehow reusable

The cumulative model provides implicit replay protection for `SpendingAuth` (can't go backwards), and `channelId` uniqueness prevents cross-channel replay. However:
- A buyer who signs a `ReserveAuth` for a future channel (same buyer+seller+salt) before the first one closes could have that signature used prematurely
- No explicit chainId binding beyond what EIP-712 domain separator provides (which does include chainId — this is adequate)

**Recommendation:** Document the replay protection model explicitly. Consider adding a nonce to `ReserveAuth` for defense in depth.

---

### M3. Seller griefing via minimal channels

**File:** `AntseedChannels.sol:157-193`, `AntseedStaking.sol:93`

Because `unstake()` is blocked when `activeChannelCount > 0`, an attacker can:
1. Deposit a small amount as buyer
2. Open many channels with a target seller (requires buyer signature, so this is a buyer-initiated attack)
3. Never close them

The seller's staked funds are locked until the channels are resolved.

**Impact:** Seller fund lock via griefing. The seller cannot unstake, and the only resolution paths require the buyer's operator to act (requestClose) or the seller to settle/close (which requires buyer's SpendingAuth signature).

**Recommendation:**
- Add a seller-initiated force-close after a long timeout (e.g., 30 days past deadline)
- Or add a minimum reserve threshold to make griefing expensive
- Or allow the seller to reject/cancel channels that have never been settled

---

### M4. Emissions: unclaimed seller rewards beyond `maxReward` cap leak to reserve

**File:** `AntseedEmissions.sol:156-159`

```solidity
if (reward > maxReward) {
    reserveAccumulated += reward - maxReward;
    reward = maxReward;
}
```

When a seller's share exceeds `MAX_SELLER_SHARE_PCT` (15% of seller budget), the excess goes to `reserveAccumulated`. This excess came from the seller budget, not the reserve budget. The effective seller allocation is always less than the documented 65%.

**Recommendation:** Document this behavior explicitly, or redistribute excess proportionally among other sellers.

---

### M5. SubPool `distributeRevenue` carries revenue forward if no peers have weight

**File:** `AntseedSubPool.sol:324-333`

If `totalWeight == 0` (all opted-in peers have zero `channelCount`), revenue is NOT reset but the epoch still advances. A peer who later gains `channelCount` would receive the accumulated revenue of multiple epochs in a single distribution — potentially a windfall.

**Recommendation:** Send undistributed revenue to protocol reserve, or cap carry-forward to 1 epoch.

---

### M6. Staking: `stakedAt` resets on additional staking

**File:** `AntseedStaking.sol:84`

Every call to `stake()` or `stakeFor()` resets `stakedAt` to `block.timestamp`. A seller staked for 1 year who adds 1 USDC looks newly staked. While `stakedAt` isn't used in slashing calculations currently (inactivity uses `lastSettledAt`), it's misleading for any future logic or off-chain systems that rely on it.

**Recommendation:** Only set `stakedAt` on first stake, or track cumulative stake duration.

---

## Low Severity

### L1. No circuit breaker / pause on Deposits critical flows

**File:** `AntseedDeposits.sol`

Unlike Channels and Emissions which have `Pausable`, Deposits has no pause mechanism. In an exploit scenario, `deposit()`, `withdraw()`, `claimPayouts()`, and the privileged `chargeAndCreditPayouts()` cannot be halted.

**Recommendation:** Add `Pausable` to Deposits with `whenNotPaused` on `deposit`, `withdraw`, and `claimPayouts`.

---

### L2. Cross-contract dead state from lost hot wallet

If the buyer's hot wallet (signing key) is lost/rotated while channels are active:
- No one can produce new `SpendingAuth` signatures
- Seller cannot `settle()` or `close()` without buyer signature
- Operator can `requestClose` + `withdraw` (good), but this requires waiting for grace period
- Seller's `activeChannelCount` remains > 0 until withdrawal completes, blocking unstake

If the operator is also lost, this becomes a permanent lock for both sides.

**Recommendation:** Document the recovery flow clearly. Consider a permissionless deadline-based timeout as a last resort (see H2).

---

### L3. `requestCloseAll` and `withdrawAll` skip without error

**File:** `AntseedChannels.sol:383-420`

Batch functions silently skip channels that don't match criteria. If a channelId is wrong or the buyer doesn't match, there's no revert or event — it's just skipped. Makes debugging difficult.

**Recommendation:** Emit a skip event, or return an array of booleans indicating success/skip per channel.

---

### L4. `computeChannelId` is predictable

**File:** `AntseedChannels.sol:131-137`

Channel IDs are `keccak256(buyer, seller, salt)`. If salt is predictable, front-running is possible. However, the buyer's `ReserveAuth` signature prevents unauthorized channels, so exploitation requires buyer collusion. Low risk.

---

### L5. ANTSToken `registry` can be unset

**File:** `ANTSToken.sol:31`

If `setRegistry` is never called, `registry` is the zero address. `mint()` would revert with a confusing error trying to call `registry.emissions()` on address(0).

**Recommendation:** Check `address(registry) != address(0)` in `mint()` with a clear error.

---

### L6. No minimum unstake cooldown

**File:** `AntseedStaking.sol:90-113`

A seller can stake, open channels, close them all, and unstake in the same block with no slashing. The slashing mechanism only catches persistent bad behavior, not flash-stake-and-dump.

**Recommendation:** Add a minimum stake duration (e.g., 7 days).

---

### L7. Payment channel safety rails

The system behaves like a Lightning-style payment channel (off-chain state updates, on-chain settlement). Mature payment channel systems always include:
- Strict nonce ordering
- Dispute windows
- Timeout-based resolution (permissionless)

The current implementation has a partial version of this. The cumulative SpendingAuth model provides implicit ordering, but the timeout/dispute mechanism is incomplete (see H2).

---

## Gas Optimizations

| Issue | Location | Impact |
|---|---|---|
| SubPool `optOut` O(n) removal | `AntseedSubPool.sol:261-267` | Gas scales with peer count |
| SubPool `distributeRevenue` N external calls | `AntseedSubPool.sol:296-322` | Gas scales with peer count, DoS risk |
| SubPool `getProjectedRevenue` iterates all peers | `AntseedSubPool.sol:376-384` | Unbounded gas for view function |
| Configurable "constants" are storage vars | All contracts | ~2100 gas per SLOAD vs ~3 for immutable |

---

## Design Observations

These are not bugs but architectural notes for future iterations:

1. **This is a payment channel system.** The cumulative SpendingAuth model is sound, but the lack of permissionless timeout resolution (H2) is a gap compared to mature channel designs.

2. **Operator pattern is powerful but brittle.** The operator controls all buyer-side actions (withdraw, close channels, claim emissions). No revocation, no multisig, no timelock. A single compromised key = full fund loss.

3. **Registry is a single point of trust.** All contracts delegate authorization to registry lookups (`onlyChannels`, `onlyEmissions`). If the registry owner is compromised, all contracts can be pointed to malicious implementations. Consider a timelock or multisig on registry updates.

4. **SubPool needs a fundamentally different distribution model.** The current model (unbounded array + per-peer external calls) will not scale. Consider a Merkle-based distribution or a staking-rewards pattern (Synthetix-style) that doesn't iterate.

---

## Fix Priority

| Priority | Issues | Theme |
|---|---|---|
| **P0 — Fix before mainnet** | C2, H1, H2, H3 | Fund safety, liveness |
| **P1 — Fix before scale** | H4, H5, H6, M1, M3 | Griefing, DoS, correctness |
| **P2 — Fix before governance** | M2, M4, M5, L1 | Trust assumptions, economics |
| **P3 — Improve** | M6, L2-L7, gas opts | Quality of life |
