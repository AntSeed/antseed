# PRD-05: SellerPaymentManager Rewrite

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-03 (SessionStore changes), PRD-04 (protocol types + PaymentMux)
**Blocked by:** PRD-03, PRD-04

## Overview

Rewrite SellerPaymentManager to work with cumulative streaming vouchers instead
of the current receipt/ack round-trip model. The seller no longer sends receipts
or handles acks; instead it receives a SpendingAuth on every request with a
monotonically increasing `cumulativeAmount`, tracks spending locally, and settles
once when the session ends.

### Files touched

- `packages/node/src/payments/seller-payment-manager.ts`

---

## Tasks

### Task 1: Remove receipt-related code

**Goal:** Strip all receipt/ack/top-up machinery that is no longer part of the
protocol.

**Steps:**

1. Remove the `sendReceipt()` method entirely (lines 245-322).
2. Remove the `handleBuyerAck()` method entirely (lines 326-362).
3. Remove the `_topUpRequested` set field and all references to it (lines 56,
   159, 311-320, 403).
4. Remove Ed25519 receipt signing imports from `./evm/signatures.js`:
   - `buildReceiptMessage`
   - `buildAckMessage`
   - `signMessageEd25519`
   - `verifyMessageEd25519`
5. Remove the `createHash` import from `node:crypto` (only used for receipt
   response hashing).
6. Remove the `bytesToHex`, `hexToBytes` imports if no remaining usage after
   cleanup.
7. Remove the `BuyerAckPayload` import from `../types/protocol.js`.

**Verify:** `pnpm run typecheck` — expect errors in callers of the removed
methods (node.ts wiring) but the file itself should be clean.

---

### Task 2: Replace `_tokenRate` and `_firstSignCap` caching

**Goal:** Remove on-chain tokenRate/firstSignCap fetching. The seller no longer
needs tokenRate — pricing is off-chain via `inputUsdPerMillion` /
`outputUsdPerMillion` metadata.

**Steps:**

1. Remove the `_tokenRate: bigint | null` field (line 58).
2. Remove the `_firstSignCap: bigint | null` field (line 60).
3. Remove the `init()` method entirely (lines 424-438) — the seller no longer
   pre-fetches on-chain state.
4. Remove the `ensureInitialized()` method entirely (lines 441-445).
5. Remove the `_lastInitAttemptMs` field and `INIT_RETRY_INTERVAL_MS` static
   (lines 417-418).
6. Remove the `StakingClient` import and `_stakingClient` field (lines 10, 50,
   72-76) — no longer needed.
7. Remove `stakingContractAddress` and `usdcAddress` from `SellerPaymentConfig`
   if no other usage remains in this file.
8. Remove the `stakingClient` getter.

**Verify:** `pnpm run typecheck` — expect errors in callers that invoke
`init()` / `ensureInitialized()`.

---

### Task 3: Add per-session cumulative tracking

**Goal:** Introduce in-memory state for tracking accepted authorizations and
spent amounts per session.

**Steps:**

1. Add two private fields:
   ```typescript
   /** sessionId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
   private readonly _acceptedCumulative = new Map<string, bigint>();

   /** sessionId -> total USDC spent so far (sum of recordSpend calls) */
   private readonly _spent = new Map<string, bigint>();
   ```

2. On startup, hydrate `_acceptedCumulative` from persisted sessions (read
   latest auth's `cumulativeAmount` from SessionStore for each active session).

3. On startup, hydrate `_spent` from persisted sessions (read stored
   `spentAmount` field from SessionStore — requires PRD-03 schema change).

**Verify:** After construction with existing sessions in the store, both maps
are populated correctly. Write a unit test that seeds the store, constructs the
manager, and asserts the maps.

---

### Task 4: Rewrite `handleSpendingAuth()`

**Goal:** Split the handler into two paths: session-open (first auth) and
budget-update (subsequent auth).

**Steps:**

1. Keep the per-buyer mutex (`_buyerLocks`) — concurrent auths for the same
   buyer must still serialize.

2. In `_handleSpendingAuthInner`, replace the current settle-then-reserve flow:

   **First SpendingAuth** (no entry in `_acceptedCumulative` for this sessionId):
   - Verify EIP-712 signature (reuse existing verification logic).
   - Call `reserve()` on-chain with the buyer's signature.
   - Store the session in SessionStore.
   - Initialize `_acceptedCumulative[sessionId] = cumulativeAmount`.
   - Initialize `_spent[sessionId] = 0n`.
   - Add buyer to `_activeBuyers`.
   - Send `AuthAck` via PaymentMux.

   **Subsequent SpendingAuth** (entry exists in `_acceptedCumulative`):
   - Verify EIP-712 signature.
   - Validate `cumulativeAmount > _acceptedCumulative[sessionId]` (monotonic
     increase). Reject if not.
   - Update `_acceptedCumulative[sessionId] = cumulativeAmount`.
   - Persist the latest auth to SessionStore (update `authMax` field or a new
     `latestCumulativeAmount` field).
   - No on-chain call. No AuthAck.

3. Remove the old flow: settle prior session, fetch tokenRate, reserve with
   previousConsumption/previousSessionId.

4. Update the EIP-712 message structure to match the new `SpendingAuthPayload`
   (from PRD-04): use `cumulativeAmount`, `cumulativeInputTokens`,
   `cumulativeOutputTokens` instead of `maxAmountUsdc`, `previousConsumption`,
   `previousSessionId`.

**Verify:** Unit test — first auth triggers reserve + AuthAck; second auth with
higher cumulative updates map but does not call reserve or send AuthAck; second
auth with equal or lower cumulative is rejected.

---

### Task 5: Add `validateAndAcceptAuth()` method

**Goal:** Provide a method that request-handling code calls on every incoming
request to check budget before serving.

**Steps:**

1. Add public method:
   ```typescript
   async validateAndAcceptAuth(
     buyerPeerId: string,
     auth: SpendingAuthPayload,
   ): Promise<boolean>
   ```

2. Implementation:
   - Look up sessionId from the buyer's active session.
   - Verify EIP-712 signature on the auth.
   - Check `BigInt(auth.cumulativeAmount) > _acceptedCumulative[sessionId]`
     (monotonic). If not monotonic but equal, still accept (idempotent
     retransmit).
   - Update `_acceptedCumulative[sessionId]`.
   - Persist latest auth to SessionStore.
   - Compute `available = _acceptedCumulative[sessionId] - _spent[sessionId]`.
   - Return `available >= 0n`.

3. If the buyer has no active session, return false.

**Verify:** Unit test — returns true when cumulative > spent; returns false when
cumulative < spent; returns true on equal-value retransmit.

---

### Task 6: Add `recordSpend()` method

**Goal:** Track USDC consumption after each served request.

**Steps:**

1. Add public method:
   ```typescript
   recordSpend(sessionId: string, costUsdc: bigint): void
   ```

2. Implementation:
   - Get current spent: `_spent.get(sessionId) ?? 0n`.
   - Set `_spent[sessionId] = current + costUsdc`.
   - Persist updated spent amount to SessionStore.

3. If `sessionId` is not in `_spent`, log a warning and return (defensive —
   should not happen in normal flow).

**Verify:** Unit test — multiple recordSpend calls accumulate correctly; unknown
sessionId logs warning and does not throw.

---

### Task 7: Add `settleSession()` method

**Goal:** Settle a completed session on-chain using the latest buyer-signed
SpendingAuth.

**Steps:**

1. Add public method:
   ```typescript
   async settleSession(buyerPeerId: string): Promise<void>
   ```

2. Implementation:
   - Get the active session from SessionStore for this buyer.
   - Get the latest SpendingAuth from SessionStore (needs the stored
     `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens`,
     `buyerSig`).
   - Call `sessionsClient.settle(sessionId, cumulativeAmount,
     cumulativeInputTokens, cumulativeOutputTokens, buyerSig)`.
     (Settle signature changes per PRD-01.)
   - Update session status to `'settled'` in SessionStore.
   - Clean up `_acceptedCumulative` and `_spent` maps for this sessionId.
   - Remove buyer from `_activeBuyers`.

3. If no active session exists, log a warning and return.

4. If `_acceptedCumulative` is 0 (session opened but no requests served), call
   `settleTimeout()` instead to release buyer funds without charging.

**Verify:** Unit test — settleSession calls settle on-chain with correct args,
cleans up maps, marks session settled. Zero-cumulative session calls
settleTimeout instead.

---

### Task 8: Update `getPaymentRequirements()`

**Goal:** Align the PaymentRequired payload with the new protocol types from
PRD-04.

**Steps:**

1. Remove from the returned payload:
   - `tokenRate`
   - `firstSignCap`

2. Add to the returned payload:
   - `minBudgetPerRequest` — read from `this._config.minBudgetPerRequest`,
     default `"10000"` ($0.01 USDC).

3. Keep in the returned payload:
   - `sellerEvmAddr`
   - `suggestedAmount` (keep the first-sign vs proven-sign logic, but base it on
     session history rather than tokenRate)
   - `requestId`
   - `inputUsdPerMillion` (optional)
   - `outputUsdPerMillion` (optional)

4. Remove the null guard on `tokenRate` / `firstSignCap` — the method no longer
   depends on on-chain data and can always return a payload.

5. Simplify the suggested-amount logic: use `firstSignAmountUsdc` for new
   buyers, `provenSignAmountUsdc` for returning buyers (same as today, just
   remove the tokenRate dependency).

**Verify:** Unit test — payload includes `minBudgetPerRequest`, does not include
`tokenRate` or `firstSignCap`. Method never returns null.

---

### Task 9: Update `checkTimeouts()` and config

**Goal:** Adapt timeout handling and config to the new model.

**Steps:**

1. In `checkTimeouts()`, for timed-out sessions:
   - If `_acceptedCumulative[sessionId] > 0n`, call `settleSession()` to settle
     with the latest buyer-signed auth.
   - If no accepted cumulative or `cumulativeAmount = 0`, call
     `settleTimeout()` to release buyer funds.

2. Update `SellerPaymentConfig`:
   - Remove `firstSignAmountUsdc` field.
   - Remove `provenSignAmountUsdc` field.
   - Add `minBudgetPerRequest: string` — minimum USDC per request (base units).
     Default: `"10000"`.
   - Add `settleOnDisconnect: boolean` — whether to immediately settle when
     buyer disconnects. Default: `true`.

3. Update `onBuyerDisconnect()`:
   - If `settleOnDisconnect` is true and there is an active session with
     `_acceptedCumulative > 0`, call `settleSession()`.
   - If `settleOnDisconnect` is false, keep current behavior (preserve session
     for reconnect, let timeout handle it).

**Verify:** Unit test — timeout with accepted cumulative calls settle;
timeout with zero cumulative calls settleTimeout. Disconnect with
`settleOnDisconnect=true` triggers immediate settlement.
