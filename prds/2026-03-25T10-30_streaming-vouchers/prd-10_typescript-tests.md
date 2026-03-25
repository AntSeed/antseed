# PRD-10: TypeScript Unit Tests — Payment Flow Updates

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-05 (SellerPaymentManager), PRD-06 (BuyerPaymentManager), PRD-07 (protocol types + PaymentMux)
**Blocked by:** PRD-05, PRD-06, PRD-07

## Overview

Update all existing TypeScript test files that reference the old payment flow
(receipt/ack round-trip, proof chains, per-session SpendingAuth) to match the
new cumulative streaming voucher model. Some tests need targeted updates; others
need full rewrites.

### Files touched

- `packages/node/tests/payment-codec.test.ts`
- `packages/node/tests/payment-mux.test.ts`
- `packages/node/tests/evm-keypair.test.ts`
- `packages/node/tests/seller-payment-manager.test.ts`
- `packages/node/tests/buyer-payment-manager.test.ts`
- `packages/node/tests/proof-chain-integration.test.ts`

---

## Tasks

### Task 1: Update payment-codec.test.ts

**Goal:** Align codec encode/decode tests with the new message types and removed
message types.

**Steps:**

1. Remove encode/decode tests for deleted message types:
   - `SellerReceipt`
   - `BuyerAck`
   - `TopUpRequest`
2. Add encode/decode test for the new `NeedAuth` message type — verify round-trip
   of all fields through `encodeNeedAuth()` / `decodeNeedAuth()`.
3. Update `SpendingAuth` encode/decode test:
   - New fields: `cumulativeAmount`, `cumulativeInputTokens`,
     `cumulativeOutputTokens`
   - Removed fields: `maxAmountUsdc`, `previousConsumption`,
     `previousSessionId`
   - Verify round-trip preserves all new fields exactly.
4. Update `PaymentRequired` encode/decode test:
   - Remove `tokenRate` and `firstSignCap` fields
   - Add `minBudgetPerRequest` field
   - Verify round-trip preserves updated fields.

#### Acceptance Criteria
- [ ] No references to SellerReceipt, BuyerAck, or TopUpRequest in the test file
- [ ] NeedAuth round-trip test passes
- [ ] SpendingAuth test uses new fields (cumulativeAmount, cumulativeInputTokens, cumulativeOutputTokens)
- [ ] PaymentRequired test uses minBudgetPerRequest instead of tokenRate/firstSignCap

---

### Task 2: Update payment-mux.test.ts

**Goal:** Align PaymentMux handler/sender tests with the new message set.

**Steps:**

1. Remove handler and sender tests for deleted message types:
   - `SellerReceipt` handler/sender
   - `BuyerAck` handler/sender
   - `TopUpRequest` handler/sender
2. Add `NeedAuth` handler test — register a handler, send a NeedAuth message
   through the mux, verify the handler receives the decoded payload.
3. Add `NeedAuth` sender test — call the send method, verify the encoded
   message is written to the underlying transport.
4. Update `SpendingAuth` handler test to use the new payload shape
   (cumulativeAmount, cumulativeInputTokens, cumulativeOutputTokens).

#### Acceptance Criteria
- [ ] No references to SellerReceipt, BuyerAck, or TopUpRequest handlers/senders
- [ ] NeedAuth handler test passes with correct payload decoding
- [ ] NeedAuth sender test passes with correct payload encoding
- [ ] SpendingAuth handler test uses updated payload fields

---

### Task 3: Update evm-keypair.test.ts

**Goal:** Update EIP-712 signature tests to use the new SpendingAuth message
structure.

**Steps:**

1. Update the SpendingAuth signing test:
   - Use new `SpendingAuthMessage` fields: `cumulativeAmount`,
     `cumulativeInputTokens`, `cumulativeOutputTokens`
   - Remove old fields: `maxAmountUsdc`, `previousConsumption`,
     `previousSessionId`
2. Remove `buildReceiptMessage` / `buildAckMessage` tests if they exist
   (these helpers are deleted in PRD-05).
3. Verify signature round-trip: sign with private key, recover signer address,
   assert it matches the expected address.

#### Acceptance Criteria
- [ ] SpendingAuth signing test uses the new 7-field message structure
- [ ] No references to buildReceiptMessage or buildAckMessage
- [ ] Signature recovery produces the correct signer address

---

### Task 4: Rewrite seller-payment-manager.test.ts

**Goal:** Replace all receipt/ack-based tests with tests for the new cumulative
voucher flow on the seller side.

**Steps:**

1. Remove tests for deleted methods:
   - `sendReceipt` tests
   - `handleBuyerAck` tests
   - Any `_topUpRequested` related tests
2. Add `validateAndAcceptAuth` tests:
   - Valid cumulative auth accepted (cumulativeAmount >= previous)
   - Monotonic validation: reject auth with cumulativeAmount < last accepted
   - Invalid buyer signature rejected
3. Add `recordSpend` tests:
   - After accepting auth, record actual spend against the session
   - Verify internal cumulative tracking updates
4. Add `settleSession` tests:
   - Settle uses the latest accepted SpendingAuth
   - Verify on-chain settle is called with correct parameters
5. Update `handleSpendingAuth` tests:
   - Initial SpendingAuth (first auth for a new session): creates session state
   - Subsequent SpendingAuth: updates cumulative tracking, validates monotonic
     increase

#### Acceptance Criteria
- [ ] No references to sendReceipt, handleBuyerAck, or _topUpRequested
- [ ] validateAndAcceptAuth: accepts valid increasing auth, rejects decreasing auth, rejects invalid signature
- [ ] recordSpend: correctly tracks cumulative spend
- [ ] settleSession: calls on-chain settle with latest auth
- [ ] handleSpendingAuth: handles both initial and subsequent auths

---

### Task 5: Rewrite buyer-payment-manager.test.ts

**Goal:** Replace all receipt/top-up-based tests with tests for the new
per-request cumulative auth flow on the buyer side.

**Steps:**

1. Remove tests for deleted methods:
   - `handleSellerReceipt` tests
   - `handleTopUpRequest` tests
   - Any proof-chain-related tests
2. Add `signPerRequestAuth` tests:
   - Signs a cumulative SpendingAuth with running totals
   - Budget cap enforcement: rejects if cumulative would exceed budget
   - Cumulative tracking: each call increments by the request cost
3. Add `handleNeedAuth` tests:
   - Receives NeedAuth from seller, triggers signPerRequestAuth
   - Sends the signed auth back through PaymentMux
4. Add `parseResponseCost` tests:
   - Extracts input/output token counts from provider response
   - Handles missing usage fields gracefully
5. Update `authorizeSpending` tests:
   - Initial auth uses `minBudgetPerRequest` from PaymentRequired
   - Budget allocation respects buyer-configured limits

#### Acceptance Criteria
- [ ] No references to handleSellerReceipt, handleTopUpRequest, or proof chains
- [ ] signPerRequestAuth: cumulative tracking correct across multiple calls
- [ ] signPerRequestAuth: enforces budget cap
- [ ] handleNeedAuth: triggers auth signing and sends response
- [ ] parseResponseCost: handles normal and missing usage data
- [ ] authorizeSpending: respects minBudgetPerRequest

---

### Task 6: Rewrite proof-chain-integration.test.ts

**Goal:** Replace the proof-of-prior-delivery chain tests with cumulative
SpendingAuth chain tests that validate the end-to-end flow of multiple
auths within a single session.

**Steps:**

1. Remove all existing proof chain tests (the proof chain concept is deleted).
2. Add **cumulative auth chain test**:
   - Buyer signs initial auth (cumulativeAmount=0) to open session
   - Seller processes 3 requests, buyer signs per-request auths:
     - Auth 1: cumulativeAmount=10, cumulativeInputTokens=500, cumulativeOutputTokens=200
     - Auth 2: cumulativeAmount=25, cumulativeInputTokens=1200, cumulativeOutputTokens=600
     - Auth 3: cumulativeAmount=40, cumulativeInputTokens=2000, cumulativeOutputTokens=1000
   - Seller settles with Auth 3 (the latest)
   - Assert final settlement matches Auth 3 values
3. Add **monotonic validation rejection test**:
   - After accepting Auth 2 (cumulativeAmount=25), attempt to submit Auth
     with cumulativeAmount=20 — assert rejection
   - Then submit Auth 3 (cumulativeAmount=40) — assert acceptance
4. Add **settle-with-latest test**:
   - Verify that settlement ignores earlier auths and only uses the most
     recent accepted auth for on-chain settlement

#### Acceptance Criteria
- [ ] No references to proof chains, proof-of-prior-delivery, or receipt hashing
- [ ] Cumulative auth chain: 3-request sequence settles correctly with final auth
- [ ] Monotonic rejection: decreasing cumulativeAmount is rejected mid-chain
- [ ] Settle uses latest auth regardless of how many intermediate auths were signed
