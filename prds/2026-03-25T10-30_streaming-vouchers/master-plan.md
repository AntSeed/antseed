# Master Plan: Streaming SpendingAuth Payment Model

**Status:** RETRO_COMPLETE
**PRDs Generated:** 2026-03-25T11:30Z
**Created:** 2026-03-25T10:30Z
**Author:** Shahaf Antwarg

## Overview

Replace the current "one SpendingAuth per session → reserve → settle" payment flow with cumulative streaming SpendingAuths inspired by Tempo's StreamChannel model. The buyer signs a SpendingAuth on every request with updated cumulative amounts. The seller accumulates these off-chain and settles on-chain using the latest buyer-signed authorization.

### Goals
- Eliminate single-point-of-failure SpendingAuth (one signature gates entire session)
- Enable continuous payment authorization that tracks consumption in real time
- Provide stronger delivery proof via buyer-signed cumulative token counts
- Support gasless buyer experience (buyer never needs ETH for gas)
- Simplify reputation to settlement-derived metrics (drop first-sign/proven-sign classification)

### Non-Goals
- Rename contracts/clients (keep AntseedSessions, SessionsClient, etc.)
- MPP HTTP compatibility (we use WebRTC, not HTTP 402)
- Multi-token support (USDC only)

## Architectural Decisions

1. **Keep existing naming** — AntseedSessions, SessionsClient, `sessionsContractAddress`, `sessionId`. No rename.
2. **Adopt Tempo principles, not API** — cumulative pre-authorization, settlement with buyer-signed proof, grace period close. Keep our own function names.
3. **SpendingAuth on every request** — same EIP-712 SpendingAuth concept, sent on every request with updated cumulative values: `{seller, sessionId, cumulativeAmount, cumulativeInputTokens, cumulativeOutputTokens, nonce, deadline, signature}`. Not a new type — just more frequent signing of the same authorization.
4. **Session lifecycle** — `reserve()` opens or tops up a session. `settle()` is final (settlement + release remaining + reputation update). `settleTimeout()` is permissionless after grace period. No intermediate partial settlement — seller accumulates SpendingAuths off-chain and settles once when done.
5. **No tokenRate on-chain** — pricing agreed off-chain via peer metadata. Buyer signs the USDC amount directly. Remove `tokenRate` from contracts entirely.
6. **Seller pre-authorization model** — buyer authorizes ahead of consumption. Seller checks `available = cumulativeAmount - spent` before serving. Pauses if budget exhausted.
7. **First SpendingAuth is small** — cents (e.g. $0.01), not dollars. Reserve locks the full deposit (e.g. $1), but the first per-request auth pre-authorizes only a few cents.
8. **Buyer config** — `maxPerRequestUsdc` and `maxReserveAmountUsdc`. If seller's minimum exceeds buyer's max, refuse connection.
9. **Reputation on settle** — `settle()` is the final action: charges USDC, releases remaining reservation, and updates reputation on Identity. No `close()` — settle IS the close.
10. **Buyer reputation weight** — weighted by `totalSettledVolume * uniqueSellersCount`, not session count. A buyer who spent $500 across 10 sellers carries more weight than $1 across 100 sessions. Prevents gaming via many tiny sessions.
11. **Seller persists latest SpendingAuth to disk** — latest buyer-signed auth per session saved to SessionStore. Crash safety: persist before serving.

## Gasless Buyer Design

The buyer never has ETH for gas. All on-chain actions are either:
- **Seller-initiated with buyer signature** — `reserve()`, `settle()`
- **Permissionless** — `settleTimeout()` can be called by anyone after grace period
- **Third-party funded** — `depositFor(buyer, amount)` on AntseedDeposits, `stakeFor(seller, amount)` on AntseedStaking (new)

### Session Lifecycle (no buyer gas needed)

```
1. Seller sends PaymentRequired(minPerRequest=$0.01, ...)
   Buyer signs initial SpendingAuth(cumAmount=$0.01) — covers estimated first request
   Seller calls reserve(buyer, sessionId, maxAmount=$1.00, buyerSig)
   → Deposits.lockForSession(buyer, $1.00)
   → Session created: deposit=$1.00
   → Seller already has signed auth for $0.01 — can serve first request

2. SpendingAuths flow off-chain (per request):
   Buyer sends request 1 (auth already held by seller from step 1)
   Seller serves, responds with cost info in headers
   Buyer sends request 2 + SpendingAuth(cumAmount=$0.013, inTokens=500, outTokens=1200)
   Seller validates (cumulative covers prior charges), serves, persists latest auth
   ...buyer signs SpendingAuth on every request with updated cumulative...

3. Session ends (buyer disconnects or done):
   Seller calls settle(sessionId, cumAmount, cumIn, cumOut, buyerSig)
   using the latest SpendingAuth received
   → Deposits charges cumAmount from buyer, credits seller earnings
   → Releases remaining reservation (deposit - cumAmount) back to buyer available
   → Reputation updated on Identity with final token counts
   → Session marked SETTLED

4. If seller disappears:
   → After CLOSE_GRACE_PERIOD (2 hours), anyone calls settleTimeout(sessionId)
   → Full reservation released back to buyer's Deposits balance
   → Ghost mark logic applied
```

### Funds Release

Unused reservation funds are released in two ways:
- **`settle()`** — seller does final settlement, remaining `deposit - cumulativeAmount` is released to buyer's Deposits balance
- **`settleTimeout()`** — permissionless after grace period, full reservation released

The buyer never calls anything on-chain. Funds move between `reserved` and `available` within Deposits automatically.

### New: `stakeFor()` on AntseedStaking

Add `stakeFor(seller, amount)` — allows a third party to stake on behalf of a seller (same pattern as `depositFor`). `unstake()` remains seller-only.

### New: `withdrawFor()` consideration

Not needed — `executeWithdrawal()` on Deposits is already buyer-only (they requested the withdrawal). If needed, a third party can trigger it with the buyer's signature in a future iteration.

## Contract Functions

### AntseedSessions.sol

| Function | Caller | Description |
|---|---|---|
| `reserve(buyer, sessionId, maxAmount, nonce, deadline, buyerSig)` | Seller | Open new session or add more reserve to existing. Locks funds in Deposits. |
| `settle(sessionId, cumulativeAmount, cumulativeInputTokens, cumulativeOutputTokens, buyerSig)` | Seller | Final settlement with buyer's latest SpendingAuth. Charges amount, releases remaining reservation, updates reputation. |
| `settleTimeout(sessionId)` | Anyone | After CLOSE_GRACE_PERIOD. Releases full reservation. Ghost mark if pattern detected. |

### EIP-712 Types

**SpendingAuth (used for both reserve and settle):**
```
SpendingAuth(address seller, bytes32 sessionId, uint256 cumulativeAmount, uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 nonce, uint256 deadline)
```

For `reserve()`: `cumulativeAmount` = 0, `cumulativeInputTokens` = 0, `cumulativeOutputTokens` = 0 (initial authorization, `maxAmount` passed separately as function param).
For `settle()`: `cumulativeAmount` = total USDC consumed, token counts = total delivered.
For per-request: same signature, buyer signs updated cumulative values each time. Seller saves latest.

Note: `previousConsumption` and `previousSessionId` dropped — cumulative SpendingAuth chain replaces the proof chain. `maxAmount` dropped from typehash — it's a `reserve()` parameter only.

### Session Struct (replaces current)

```solidity
struct Session {
    address buyer;
    address seller;
    uint256 deposit;           // Total USDC reserved (can increase via additional reserve())
    uint256 settled;           // Cumulative USDC settled so far
    uint128 settledInputTokens;
    uint128 settledOutputTokens;
    uint256 nonce;
    uint256 deadline;
    uint256 settledAt;         // Timestamp of settlement (0 if not yet settled)
    SessionStatus status;      // None, Active, Settled, TimedOut
}
```

Drop: `maxAmount` (renamed to `deposit`), `tokenRate`, `previousConsumption`, `previousSessionId`, `reservedAt`, `settledAmount` (renamed to `settled`), `settledTokenCount` (split into input/output), `isFirstSign`, `isProvenSign`, `isQualifiedProvenSign`

## Off-Chain Protocol Flow

### WebRTC Message Types

| Type | Code | Direction | Description |
|---|---|---|---|
| PaymentRequired | 0x56 | Seller→Buyer | Session requirements: `minBudgetPerRequest`, `sellerEvmAddr`, pricing info |
| SpendingAuth | 0x50 | Buyer→Seller | EIP-712 signed authorization. Sent at session open (for `reserve()`) AND on every request (with updated cumulative amounts) |
| AuthAck | 0x51 | Seller→Buyer | Confirms session opened on-chain |
| NeedAuth | 0x58 | Seller→Buyer | Budget exhausted, need SpendingAuth with higher cumulative amount |

Drop: SellerReceipt (0x53), BuyerAck (0x54), TopUpRequest (0x55)

### Per-Request Flow

```
Session open:
  Seller → PaymentRequired(minPerRequest=$0.01, sellerEvmAddr=0x..., pricing=...)
  Buyer signs SpendingAuth(cumAmount=$0.01, inTokens=0, outTokens=0) for initial pre-auth
  Seller calls reserve() on-chain with buyer's SpendingAuth + maxAmount=$1.00
  Seller → AuthAck
  Seller now holds a signed auth for $0.01 — enough to serve the first request

Request 1:
  Buyer → request (SpendingAuth already sent during open — seller has it)
  Seller: available=$0.01, cost estimate=$0.005 → serve
  Seller → response (includes cost in headers: inputTokens=500, outputTokens=1200, cost=$0.003)

Request 2:
  Buyer → request + SpendingAuth(cumAmount=$0.013, inTokens=500, outTokens=1200)
  Seller: validates cumulative covers prior charges + estimate for next, available=$0.01 → serve
  Seller → response (inputTokens=300, outputTokens=800, cost=$0.002)

Request 3:
  Buyer → request + SpendingAuth(cumAmount=$0.015, inTokens=800, outTokens=2000)
  ...

Budget exhausted:
  Seller: available=$0.001, next request costs ~$0.003
  Seller → NeedAuth(requiredCumulative=$0.02)
  Buyer → SpendingAuth(cumAmount=$0.02, ...) or new reserve() if deposit exhausted
```

### Seller Batch Settlement

The seller calls `settle()` with the latest buyer-signed SpendingAuth when:
- Buyer disconnects (graceful or timeout)
- Session is done

The contract verifies the buyer's EIP-712 signature, charges `cumulativeAmount`, releases remaining reservation (`deposit - cumulativeAmount`), and updates reputation.

### Seller Receipt in Response

Instead of a separate SellerReceipt message, the seller includes metering info in the HTTP response headers:
- `x-antseed-input-tokens: 500`
- `x-antseed-output-tokens: 1200`
- `x-antseed-cost: 3000` (USDC base units)
- `x-antseed-cumulative-cost: 15000`

The buyer reads these to compute the next SpendingAuth's cumulative values.

## Reputation Model

### What Changes
- **Drop** first-sign / proven-sign / qualified-proven-sign classification
- **Drop** proof chain validation (`previousConsumption`, `previousSessionId`)
- **Drop** `PROVEN_SIGN_COOLDOWN`, `MIN_TOKEN_THRESHOLD`, `BUYER_DIVERSITY_THRESHOLD` constants

### What's Added
- **Reputation updated on `settle()`** — which is the final settlement action
- **Buyer reputation weight** — weighted by `totalSettledVolume * uniqueSellersCount`
- **Settlement-derived metrics**: total USDC volume, total input tokens, total output tokens, session count, unique counterparties

### Ghost Marks
- Not per-session — pattern-based only
- Seller gets a ghost mark when they have 40+ sessions that timed out with zero or minimal settlement
- This catches sellers that systematically take initial authorization without delivering
- Single session timeouts are normal (disconnects happen) and don't trigger ghost marks

### Identity ProvenReputation Struct (simplified)
```solidity
struct Reputation {
    uint64 sessionCount;          // Settled sessions
    uint64 ghostCount;            // Pattern-based ghost marks
    uint256 totalSettledVolume;   // Cumulative USDC from all settlements
    uint128 totalInputTokens;    // Cumulative input tokens from all settlements
    uint128 totalOutputTokens;   // Cumulative output tokens from all settlements
    uint64 lastSettledAt;         // Timestamp of last settlement
}
```

## Staking Changes

### AntseedStaking
- Remove `tokenRate` from `SellerAccount` struct
- Remove `setTokenRate()` and `getTokenRate()` functions
- `validateSeller()` → simplify to just check `isStakedAboveMin()`
- Add `stakeFor(seller, amount)` — third party can stake on behalf

### Pricing
- Sellers announce pricing in peer metadata (off-chain): `inputUsdPerMillion`, `outputUsdPerMillion`
- Buyer sees pricing before connecting
- No on-chain pricing — keeps the contract simple

## Current State (What Exists)

### On-Chain (AntseedSessions.sol)
- `reserve()` — seller calls with buyer's EIP-712 SpendingAuth to lock funds
- `settle(sessionId, tokenCount)` — seller settles with self-reported token count
- `settleTimeout(sessionId)` — releases funds after 24h timeout
- Session struct with `maxAmount`, `tokenRate`, `previousConsumption`, `previousSessionId`
- Proof chain: each session references previous session's `settledTokenCount`
- First-sign / proven-sign / qualified-proven-sign classification

### Off-Chain (TypeScript)
- `SellerPaymentManager` — handles SpendingAuth, sends receipts, manages settle-then-reserve flow
- `BuyerPaymentManager` — signs SpendingAuth, handles receipts, auto-acks
- `PaymentMux` — WebRTC message types: SpendingAuth, AuthAck, SellerReceipt, BuyerAck, TopUpRequest, PaymentRequired
- `SessionStore` (SQLite) — persists sessions and receipts

## PRD Dependency Graph

```
PRD-01 (Contract) ──┬── PRD-02 (Interfaces + Deploy)
                    ├── PRD-03 (TS Client + EIP-712) ──┐
                    │                                   │
PRD-04 (Protocol) ──┤                                   ├── PRD-05 (SellerManager) ──┐
                    │                                   ├── PRD-06 (BuyerManager)  ──├── PRD-07 (Node.ts)
                    │                                   │                            │
                    └───────────────────────────────────┘                            ├── PRD-08 (Apps + Config)
                                                                                    │
PRD-09 (Solidity tests) ── depends on PRD-01, PRD-02                                │
PRD-10 (TS tests) ── depends on PRD-05, PRD-06, PRD-07                              │
PRD-11 (Staking + Identity cleanup) ── depends on PRD-01                            │
```

## PRD Summary

| PRD | Description | Depends On | Est. Tasks |
|-----|-------------|------------|------------|
| 01 | AntseedSessions.sol rewrite — cumulative SpendingAuth model | — | 8 |
| 02 | IAntseedSessions interface update + Deploy.s.sol | 01 | 4 |
| 03 | EIP-712 SpendingAuth type update + SessionsClient TS | 01 | 5 |
| 04 | WebRTC protocol types + PaymentMux — SpendingAuth per-request + NeedAuth | — | 5 |
| 05 | SellerPaymentManager rewrite — auth tracking, settle, metering headers | 03, 04 | 8 |
| 06 | BuyerPaymentManager rewrite — per-request signing, budget tracking | 03, 04 | 7 |
| 07 | Node.ts wiring — new payment flow integration | 05, 06 | 6 |
| 08 | Desktop + CLI + config updates | 03, 07 | 5 |
| 09 | Solidity tests for new contract | 01, 02 | 6 |
| 10 | TypeScript unit tests | 05, 06, 07 | 6 |
| 11 | AntseedStaking (remove tokenRate, add stakeFor) + AntseedIdentity (simplify reputation) | 01 | 5 |
| **Total** | | | **~65** |

## Out of Scope

- MPP HTTP protocol compatibility
- Multi-chain deployment
- Contract proxy/upgrade pattern
- Website/blog documentation updates (follow-up)
- E2E test script rewrite (follow-up)
- Emissions integration changes (follow-up — needs new accrual points model)
- `withdrawFor()` with buyer signature (future iteration if needed)

## Resolved Questions

| Question | Decision |
|---|---|
| Rename to AntseedPayments? | No — keep AntseedSessions, keep `sessionId` |
| Adopt Tempo function names (open/topUp/requestClose/withdraw)? | No — keep `reserve()`/`settle()`/`settleTimeout()`. No `close()` — `settle()` is final. |
| topUp as separate function? | No — `reserve()` serves both open and top-up |
| tokenRate on-chain? | Remove entirely — pricing agreed off-chain, buyer signs USDC directly |
| Buyer calls on-chain? | Never — buyer has no gas. All on-chain actions are seller-initiated or permissionless. |
| How does buyer get funds released? | `settle()` (seller calls) releases remaining. `settleTimeout()` (anyone calls) as fallback. |
| `stakeFor()` on Staking? | Yes — same pattern as `depositFor()`. `unstake()` remains seller-only. |
| When does reputation update? | Only on `settle()` (which is the final settlement). |
| How are ghost marks calculated? | Pattern-based: 40+ sessions with zero/minimal settlement across the seller's history. |
| Buyer activity in reputation? | Yes — weighted by `totalSettledVolume * uniqueSellersCount`, not session count. Prevents gaming via tiny sessions. |
| Grace period duration? | Contract-level configurable constant `CLOSE_GRACE_PERIOD`, default 2 hours. |
| First per-request auth amount? | Cents (e.g. $0.01), not the full reserve amount. |
| Buyer max per request? | New config field `maxPerRequestUsdc` — refuse seller if min > max. |
| Where does cost info travel? | In HTTP response headers (`x-antseed-*`), not separate SellerReceipt message. |
| What replaces proof-of-prior-delivery? | Cumulative SpendingAuth chain — each increasing auth attests delivery of all prior work. Same concept, same name, just signed more frequently. |
