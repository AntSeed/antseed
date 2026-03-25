# PRD-07: Node.ts Wiring

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-05 (SellerPaymentManager), PRD-06 (BuyerPaymentManager)
**Blocked by:** PRD-05, PRD-06

## Overview

Node.ts is the integration point that wires SellerPaymentManager,
BuyerPaymentManager, PaymentMux, and ProxyMux together. This PRD updates the
wiring to use the new cumulative streaming-voucher APIs: SpendingAuth on every
request, cost headers in seller responses, NeedAuth for budget escalation, and
removal of the receipt/ack round-trip.

### Files touched

- `packages/node/src/node.ts`

---

## Tasks

### Task 1: Update seller-side PaymentMux handler registration

**Goal:** Remove the BuyerAck handler and update SpendingAuth handling to
support both initial and per-request cumulative auths.

**Steps:**

1. In `_handleIncomingConnection()` (~line 1188), in the
   `if (this._sellerPaymentManager)` block:
   - Remove: `paymentMux.onBuyerAck()` registration (lines 1194-1196).
     BuyerAck message type is dropped in PRD-04.
   - Keep: `paymentMux.onSpendingAuth()` — but update the handler body.
     Currently it only calls `spm.handleSpendingAuth()` for initial auth.
     Change to: if `spm.hasSession(buyerPeerId)`, call
     `spm.validateAndAcceptAuth(buyerPeerId, payload)` for subsequent
     per-request auths; otherwise call `spm.handleSpendingAuth()` for initial
     session establishment (which sends AuthAck).

**Acceptance criteria:**
- `paymentMux.onBuyerAck()` call is removed.
- SpendingAuth handler distinguishes initial vs per-request auth and calls the
  appropriate SellerPaymentManager method.
- Seller still sends AuthAck on the first SpendingAuth (initial session).
- Subsequent SpendingAuth payloads update cumulative budget without AuthAck.

---

### Task 2: Update seller-side request handling — add cost headers

**Goal:** After serving a request, include token-usage and cost information in
the response headers so the buyer knows what was consumed.

**Steps:**

1. In the `mux.onProxyRequest` handler (~line 1340), after
   `_recordMetering()` and where `parseResponseUsage(responseBody)` is called:
   - Compute cost from the seller's off-chain pricing:
     ```typescript
     const pricing = this._resolveProviderPricing(provider, request);
     const costUsdc = computeCostUsdc(usage.inputTokens, usage.outputTokens, pricing);
     ```
   - Before sending the response, inject headers into the response object:
     - `x-antseed-input-tokens`: `usage.inputTokens` (string)
     - `x-antseed-output-tokens`: `usage.outputTokens` (string)
     - `x-antseed-cost`: `costUsdc` (USDC base units, string)
     - `x-antseed-cumulative-cost`: cumulative cost for the session from
       `spm.getCumulativeSpend(buyerPeerId)` (string)
   - Call `spm.recordSpend(buyerPeerId, costUsdc)` to update the seller's
     off-chain spend tracker.

2. Remove the existing `spm.sendReceipt()` call (lines 1357-1362). Receipts
   are replaced by cost headers + per-request SpendingAuth.

**Acceptance criteria:**
- Response headers include `x-antseed-input-tokens`, `x-antseed-output-tokens`,
  `x-antseed-cost`, and `x-antseed-cumulative-cost`.
- `spm.recordSpend()` is called after each request.
- `spm.sendReceipt()` call is removed.
- Cost computation uses the same provider pricing already resolved for metering.

---

### Task 3: Update seller-side — send NeedAuth when budget low

**Goal:** After recording spend, check whether the buyer's remaining authorized
budget is running low and proactively request a new SpendingAuth via NeedAuth.

**Steps:**

1. After calling `spm.recordSpend()` in the request handler (Task 2):
   - Get remaining budget: `spm.getRemainingBudget(buyerPeerId)`.
   - Estimate next request cost (use the cost just computed, or a configurable
     `estimatedNextRequestCost` from seller config).
   - If `remainingBudget < estimatedNextRequestCost`:
     ```typescript
     paymentMux.sendNeedAuth({
       currentCumulativeAmount: spm.getAcceptedCumulative(buyerPeerId),
       spent: spm.getCumulativeSpend(buyerPeerId),
       suggestedTopUp: estimatedNextRequestCost * 2n, // suggest 2x headroom
     });
     ```

2. This is fire-and-forget; the buyer will respond with a new SpendingAuth
   via the existing handler (Task 1).

**Acceptance criteria:**
- NeedAuth is sent when remaining authorized budget drops below estimated
  next request cost.
- NeedAuth payload includes `currentCumulativeAmount`, `spent`, and
  `suggestedTopUp`.
- No NeedAuth is sent if budget is sufficient.
- NeedAuth does not block the response to the buyer.

---

### Task 4: Update buyer-side PaymentMux handler registration

**Goal:** Remove obsolete handler registrations and add NeedAuth handling.

**Steps:**

1. In `_getOrCreateBuyerPaymentMux()` (~line 1901):
   - Remove: `pmux.onSellerReceipt()` registration (lines 1915-1917).
     SellerReceipt message type is dropped.
   - Remove: `pmux.onTopUpRequest()` registration (lines 1919-1921).
     TopUpRequest message type is dropped.
   - Add: `pmux.onNeedAuth()` handler:
     ```typescript
     pmux.onNeedAuth((payload) => {
       void bpm.handleNeedAuth(peerId, payload, pmux);
     });
     ```
   - Keep: `pmux.onAuthAck()` — unchanged.
   - Keep: `pmux.onPaymentRequired()` — unchanged.

**Acceptance criteria:**
- `pmux.onSellerReceipt()` and `pmux.onTopUpRequest()` calls are removed.
- `pmux.onNeedAuth()` is registered and delegates to
  `bpm.handleNeedAuth()`.
- AuthAck and PaymentRequired handlers remain unchanged.

---

### Task 5: Update buyer-side request flow — attach SpendingAuth to every request

**Goal:** Before sending each proxy request to the seller, attach a fresh
SpendingAuth with cumulative cost from the previous response.

**Steps:**

1. In the buyer-side proxy request path (where requests are forwarded to
   the seller via ProxyMux):
   - After the first request (which was covered by the initial SpendingAuth
     during session open), each subsequent request must include a new
     SpendingAuth.
   - Before sending: read the cost headers from the previous response
     (`x-antseed-cost`, `x-antseed-cumulative-cost`, `x-antseed-input-tokens`,
     `x-antseed-output-tokens`) to know the current cumulative state.
   - Call `bpm.signPerRequestAuth(peerId, cumulativeCost, cumulativeInputTokens, cumulativeOutputTokens)` to get a signed SpendingAuth payload.
   - Send the SpendingAuth via `pmux.sendSpendingAuth(payload)` before (or
     piggybacked with) the proxy request.

2. For the first request after session open: the initial SpendingAuth was
   already sent during `_doNegotiatePayment()`, so skip signing again.
   Use a flag or check `bpm.hasInitialAuth(peerId)` to distinguish.

**Acceptance criteria:**
- Every request after the first includes a fresh SpendingAuth via PaymentMux.
- SpendingAuth cumulative fields reflect the cost reported by the seller in
  the previous response.
- The first request does not double-send SpendingAuth.
- If `bpm.signPerRequestAuth()` fails (e.g., budget exceeded), the request is
  rejected locally with a clear error.

---

### Task 6: Simplify _doNegotiatePayment()

**Goal:** Remove on-chain context fetching, firstSignCap/cooldown logic, and
simplify to: receive PaymentRequired, validate, sign initial auth, reserve.

**Steps:**

1. In `_doNegotiatePayment()` (~line 2141):
   - Remove: `getBuyerApprovalContext()` call and all `approvalContext` usage
     (lines 2171-2180). On-chain context is no longer needed for signing;
     cumulative model doesn't have firstSignCap or cooldown.
   - Remove: `isFirstSign` / `firstSignCap` capping logic (lines 2190-2197).
   - Remove: `approvalContext.buyerBalance.available` capping
     (lines 2190-2192).
   - Simplify amount selection:
     - Use `requirements.suggestedAmount` as the reserve amount.
     - Validate against `bpm.maxPerRequestUsdc` and
       `bpm.maxReserveAmountUsdc` from buyer config.
     - If `suggestedAmount > maxReserveAmountUsdc`, cap to
       `maxReserveAmountUsdc`.
   - Update the `approvalInfo` emitted via `payment:required`:
     - Remove: `buyerAvailableUsdc`, `isFirstSign`, `cooldownRemainingSecs`,
       `tokenRate`, `firstSignCap`.
     - Add: `minBudgetPerRequest` from `requirements.minBudgetPerRequest`.
   - Call `bpm.authorizeSpending()` with the validated amount. The initial
     SpendingAuth will have `cumulativeAmount = reserveAmount`,
     `cumulativeInputTokens = "0"`, `cumulativeOutputTokens = "0"`.

2. Remove the `_sessionsClient` field usage for `getBuyerApprovalContext`.
   The SessionsClient may still be used elsewhere; only remove the call
   from this method.

**Acceptance criteria:**
- `getBuyerApprovalContext()` is not called during payment negotiation.
- No `firstSignCap`, `isFirstSign`, or `cooldownRemainingSecs` logic remains.
- Amount is capped by `maxReserveAmountUsdc` from buyer config.
- `payment:required` event payload uses new fields
  (`minBudgetPerRequest` instead of `tokenRate`/`firstSignCap`).
- Initial SpendingAuth sets cumulative token fields to zero.
- Payment negotiation still waits for AuthAck before marking session as locked.
