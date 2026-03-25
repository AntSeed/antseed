# PRD-06: BuyerPaymentManager Rewrite

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-03 (SessionStore changes), PRD-04 (protocol types + PaymentMux)
**Blocked by:** PRD-03, PRD-04

## Overview

Rewrite BuyerPaymentManager to sign a SpendingAuth on every request with
cumulative amounts, replacing the current model of one upfront auth followed by
receipt/ack round-trips. The buyer tracks cumulative USDC spent, input tokens,
and output tokens, and signs progressively larger authorizations as it consumes
services.

### Files touched

- `packages/node/src/payments/buyer-payment-manager.ts`

---

## Tasks

### Task 1: Remove receipt/ack/top-up handling

**Goal:** Strip all receipt, ack, and top-up machinery that is no longer part of
the protocol.

**Steps:**

1. Remove the `handleSellerReceipt()` method entirely (lines 198-285).
2. Remove the `handleTopUpRequest()` method entirely (lines 289-316).
3. Remove Ed25519 ack/receipt signing imports from `./evm/signatures.js`:
   - `buildAckMessage`
   - `signMessageEd25519`
   - `verifyMessageEd25519`
   - `buildReceiptMessage`
4. Remove the type imports from `../types/protocol.js`:
   - `SellerReceiptPayload`
   - `TopUpRequestPayload`
5. Remove the `autoAck` field from `BuyerPaymentConfig` (line 35).

**Verify:** `pnpm run typecheck` — expect errors in callers of the removed
methods (node.ts wiring) but the file itself should be clean.

---

### Task 2: Add cumulative tracking state

**Goal:** Introduce in-memory maps for tracking cumulative amounts signed to
each seller.

**Steps:**

1. Add three private fields:
   ```typescript
   /** sellerPeerId -> cumulative USDC amount in the latest SpendingAuth */
   private readonly _cumulativeAmount = new Map<string, bigint>();

   /** sellerPeerId -> cumulative input tokens reported by seller */
   private readonly _cumulativeInputTokens = new Map<string, bigint>();

   /** sellerPeerId -> cumulative output tokens reported by seller */
   private readonly _cumulativeOutputTokens = new Map<string, bigint>();
   ```

2. On startup, hydrate all three maps from persisted active sessions in
   SessionStore (read the latest stored SpendingAuth's cumulative values for
   each active buyer-role session).

**Verify:** Unit test — construct manager with pre-seeded SessionStore, assert
maps are hydrated correctly.

---

### Task 3: Rewrite `authorizeSpending()` for initial auth

**Goal:** The initial `authorizeSpending()` call now signs a SpendingAuth with
`cumulativeAmount = minBudgetPerRequest` (from the seller's PaymentRequired
payload) instead of the buyer's full `defaultMaxAmountUsdc`.

**Steps:**

1. Change signature to accept the seller's `minBudgetPerRequest`:
   ```typescript
   async authorizeSpending(
     sellerPeerId: string,
     sellerEvmAddr: string,
     paymentMux: PaymentMux,
     minBudgetPerRequest: bigint,
   ): Promise<string>
   ```

2. Generate sessionId, nonce, deadline as before.

3. Sign EIP-712 SpendingAuth with the new payload shape (from PRD-04):
   - `cumulativeAmount = minBudgetPerRequest`
   - `cumulativeInputTokens = "0"`
   - `cumulativeOutputTokens = "0"`
   - Remove `maxAmountUsdc`, `previousConsumption`, `previousSessionId`.

4. Initialize cumulative maps:
   - `_cumulativeAmount[sellerPeerId] = minBudgetPerRequest`
   - `_cumulativeInputTokens[sellerPeerId] = 0n`
   - `_cumulativeOutputTokens[sellerPeerId] = 0n`

5. Store session in SessionStore (update stored fields to match new schema from
   PRD-03).

6. Send SpendingAuth via PaymentMux.

7. Remove the proof-chain logic (`previousConsumption`, `previousSessionId`,
   `canChain` check, `ZERO_SESSION_ID`) — the new model does not chain sessions
   via previous consumption.

**Verify:** Unit test — authorizeSpending signs with cumulativeAmount equal to
minBudgetPerRequest, cumulative token counts at zero, and sends via PaymentMux.

---

### Task 4: Add `signPerRequestAuth()` method

**Goal:** Before each request (after the initial one), sign an updated
SpendingAuth with incremented cumulative values.

**Steps:**

1. Add public method:
   ```typescript
   async signPerRequestAuth(
     sellerPeerId: string,
     addedCostUsdc: bigint,
     addedInputTokens: bigint,
     addedOutputTokens: bigint,
     estimatedNextCostUsdc: bigint,
   ): Promise<SpendingAuthPayload>
   ```

2. Implementation:
   - Look up the active session for this seller.
   - Update cumulative maps:
     - `_cumulativeAmount[sellerPeerId] += addedCostUsdc + estimatedNextCostUsdc`
     - `_cumulativeInputTokens[sellerPeerId] += addedInputTokens`
     - `_cumulativeOutputTokens[sellerPeerId] += addedOutputTokens`
   - Cap `_cumulativeAmount` at `maxPerRequestUsdc` increment (see Task 6).
   - Sign EIP-712 SpendingAuth with the updated cumulative values. Reuse the
     session's `sessionId`, `nonce`, `deadline`.
   - Persist the updated cumulative values and latest signature to SessionStore.
   - Return the signed `SpendingAuthPayload` (caller attaches it to the
     request).

3. If no active session exists for this seller, throw an error (caller must
   call `authorizeSpending()` first).

**Verify:** Unit test — after initial auth with cumAmount=X, calling
signPerRequestAuth with addedCost=Y and estimatedNext=Z produces a new auth
with cumAmount=X+Y+Z. Cumulative token counts increment correctly.

---

### Task 5: Add `handleNeedAuth()` method

**Goal:** Handle seller-initiated NeedAuth messages when the seller's budget
runs out mid-session.

**Steps:**

1. Add public method:
   ```typescript
   async handleNeedAuth(
     sellerPeerId: string,
     payload: NeedAuthPayload,
     paymentMux: PaymentMux,
   ): Promise<void>
   ```

2. Implementation:
   - Look up the active session for this seller.
   - Parse `requiredCumulativeAmount` from the payload.
   - Check against buyer's deposit balance:
     - If `requiredCumulativeAmount` is within the current reserve (does not
       exceed the deposited amount allocated to this session): sign a new
       SpendingAuth with `cumulativeAmount = requiredCumulativeAmount` and send
       via PaymentMux.
     - If `requiredCumulativeAmount` exceeds the current reserve: sign a new
       `reserve()` authorization to increase the on-chain deposit for this
       session, then sign the SpendingAuth. (This path may require an on-chain
       transaction; log a warning if the buyer's total deposit is insufficient.)
   - Update `_cumulativeAmount[sellerPeerId]` to the new value.
   - Persist to SessionStore.

3. If no active session exists, log a warning and return.

**Verify:** Unit test — NeedAuth within budget produces a new SpendingAuth;
NeedAuth exceeding deposit logs a warning.

---

### Task 6: Add budget validation

**Goal:** Protect the buyer from over-authorizing USDC to any single seller or
request.

**Steps:**

1. Add config fields to `BuyerPaymentConfig`:
   ```typescript
   /** Max USDC to pre-authorize per request increment (base units). Default: 100000 ($0.10). */
   maxPerRequestUsdc: bigint;
   /** Max total USDC to reserve per session (base units). Default: 10000000 ($10.00). */
   maxReserveAmountUsdc: bigint;
   ```

2. In `authorizeSpending()`:
   - Validate `minBudgetPerRequest <= maxPerRequestUsdc`. If the seller demands
     more than the buyer allows, log a warning and do not authorize. Return an
     empty string (or throw) to signal the caller.

3. In `signPerRequestAuth()`:
   - Cap each `addedCostUsdc + estimatedNextCostUsdc` increment at
     `maxPerRequestUsdc`.
   - Cap total `_cumulativeAmount[sellerPeerId]` at `maxReserveAmountUsdc`.
   - If either cap is hit, sign with the capped value and log a debug message.

4. In `handleNeedAuth()`:
   - Reject if `requiredCumulativeAmount > maxReserveAmountUsdc`.

**Verify:** Unit test — signPerRequestAuth with an increment exceeding
maxPerRequestUsdc is capped. Total cumulative exceeding maxReserveAmountUsdc is
capped. authorizeSpending rejects when minBudgetPerRequest > maxPerRequestUsdc.

---

### Task 7: Parse response headers for cost info

**Goal:** Provide a utility method that extracts per-request cost and token
usage from seller response headers, so callers can feed the values into
`signPerRequestAuth()`.

**Steps:**

1. Add public static method:
   ```typescript
   static parseResponseCost(
     headers: Record<string, string>,
   ): { cost: bigint; inputTokens: bigint; outputTokens: bigint } | null
   ```

2. Implementation:
   - Read `x-antseed-cost` header — parse as bigint (USDC base units). If
     missing, return null.
   - Read `x-antseed-input-tokens` header — parse as bigint. Default to `0n`
     if missing.
   - Read `x-antseed-output-tokens` header — parse as bigint. Default to `0n`
     if missing.
   - Return the parsed values.

3. Header names should be defined as constants at the top of the file:
   ```typescript
   const HEADER_COST = 'x-antseed-cost';
   const HEADER_INPUT_TOKENS = 'x-antseed-input-tokens';
   const HEADER_OUTPUT_TOKENS = 'x-antseed-output-tokens';
   ```

**Verify:** Unit test — headers with all three values parse correctly; missing
cost returns null; missing token counts default to 0n; non-numeric values
return null.
