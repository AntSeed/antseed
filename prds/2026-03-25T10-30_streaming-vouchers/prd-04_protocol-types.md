# PRD-04: WebRTC Protocol Types + PaymentMux

**Created:** 2026-03-25T11:00Z
**Depends on:** None
**Blocked by:** None

## Overview

Refactor the WebRTC payment protocol types, codec, and mux to support
cumulative streaming vouchers. Remove the receipt/ack/top-up round-trip
messages and replace them with a simpler model: SpendingAuth sent on every
request with cumulative values, and NeedAuth for seller-initiated budget
escalation.

### Files touched

- `packages/node/src/types/protocol.ts`
- `packages/node/src/p2p/payment-codec.ts`
- `packages/node/src/p2p/payment-mux.ts`

---

## Tasks

### Task 1: Update protocol.ts types

**Goal:** Remove obsolete types/enums, add NeedAuth, and update SpendingAuth
and PaymentRequired payloads to match the new cumulative model.

**Steps:**

1. In the `MessageType` enum:
   - Remove `SellerReceipt = 0x53`
   - Remove `BuyerAck = 0x54`
   - Remove `TopUpRequest = 0x55`
   - Add `NeedAuth = 0x58`

2. Remove these interfaces entirely:
   - `SellerReceiptPayload`
   - `BuyerAckPayload`
   - `TopUpRequestPayload`

3. Replace `SpendingAuthPayload` with:
   ```typescript
   export interface SpendingAuthPayload {
     /** 32-byte session ID as hex string */
     sessionId: string;
     /** Cumulative authorized amount in USDC base units (6 decimals) */
     cumulativeAmount: string;
     /** Cumulative input tokens consumed across the session */
     cumulativeInputTokens: string;
     /** Cumulative output tokens consumed across the session */
     cumulativeOutputTokens: string;
     /** Replay-protection nonce */
     nonce: number;
     /** Unix timestamp deadline */
     deadline: number;
     /** Buyer's EIP-712 signature as hex */
     buyerSig: string;
     /** Buyer's EVM address */
     buyerEvmAddr: string;
   }
   ```

4. Replace `PaymentRequiredPayload` with:
   ```typescript
   export interface PaymentRequiredPayload {
     /** Seller's EVM address for the SpendingAuth */
     sellerEvmAddr: string;
     /** Minimum USDC budget required per request (base units) */
     minBudgetPerRequest: string;
     /** Suggested reserve amount in USDC base units */
     suggestedAmount: string;
     /** The requestId that triggered the 402, so the buyer can correlate */
     requestId: string;
     /** Per-direction pricing from seller metadata (USD per 1M tokens), if available */
     inputUsdPerMillion?: number;
     outputUsdPerMillion?: number;
   }
   ```

5. Add new interface:
   ```typescript
   export interface NeedAuthPayload {
     /** Session ID for which more budget is needed */
     sessionId: string;
     /** Cumulative USDC amount the seller needs authorized (base units) */
     requiredCumulativeAmount: string;
     /** Cumulative amount currently accepted by the seller (base units) */
     currentAcceptedCumulative: string;
     /** Buyer's remaining deposit in escrow (base units) */
     deposit: string;
   }
   ```

**Verify:** `pnpm run typecheck` passes (expect downstream errors in codec/mux
until Tasks 2-5 are done; confirm only those files error).

---

### Task 2: Update SpendingAuth codec

**Goal:** Align `encodeSpendingAuth` / `decodeSpendingAuth` in
`payment-codec.ts` with the new `SpendingAuthPayload` fields.

**Steps:**

1. `encodeSpendingAuth` — no structural change needed (it already does
   `JSON.stringify`), but confirm the type matches after Task 1.

2. `decodeSpendingAuth` — rewrite the field extraction:
   - Remove: `maxAmountUsdc`, `previousConsumption`, `previousSessionId`
   - Add: `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens`
   - All three new fields are required strings.

**Verify:** Write a unit test (or update the existing one) that round-trips
a SpendingAuth through encode/decode and asserts all fields survive.

---

### Task 3: Update PaymentRequired codec

**Goal:** Align `encodePaymentRequired` / `decodePaymentRequired` with the
new `PaymentRequiredPayload` fields.

**Steps:**

1. `encodePaymentRequired` — no structural change (JSON.stringify).

2. `decodePaymentRequired` — rewrite field extraction:
   - Remove: `tokenRate`, `firstSignCap`
   - Add: `minBudgetPerRequest` (required string)
   - Keep: `sellerEvmAddr`, `suggestedAmount`, `requestId`,
     `inputUsdPerMillion?`, `outputUsdPerMillion?`

**Verify:** Round-trip unit test with and without the optional pricing fields.

---

### Task 4: Add NeedAuth codec

**Goal:** Add `encodeNeedAuth` / `decodeNeedAuth` to `payment-codec.ts`.

**Steps:**

1. Remove these functions (dead code after Task 1):
   - `encodeSellerReceipt`, `decodeSellerReceipt`
   - `encodeBuyerAck`, `decodeBuyerAck`
   - `encodeTopUpRequest`, `decodeTopUpRequest`

2. Remove the `SellerReceiptPayload`, `BuyerAckPayload`, `TopUpRequestPayload`
   imports at the top of the file.

3. Add import for `NeedAuthPayload`.

4. Add encoder:
   ```typescript
   export function encodeNeedAuth(payload: NeedAuthPayload): Uint8Array {
     return encoder.encode(JSON.stringify(payload));
   }
   ```

5. Add decoder with runtime validation:
   ```typescript
   export function decodeNeedAuth(data: Uint8Array): NeedAuthPayload {
     const obj = parseJson(data);
     return {
       sessionId: requireString(obj, 'sessionId'),
       requiredCumulativeAmount: requireString(obj, 'requiredCumulativeAmount'),
       currentAcceptedCumulative: requireString(obj, 'currentAcceptedCumulative'),
       deposit: requireString(obj, 'deposit'),
     };
   }
   ```

**Verify:** Round-trip unit test for NeedAuth encode/decode.

---

### Task 5: Update PaymentMux handlers

**Goal:** Remove obsolete handler/sender pairs and add NeedAuth support.

**Steps:**

1. Update imports at top of file:
   - Remove: `SellerReceiptPayload`, `BuyerAckPayload`, `TopUpRequestPayload`
   - Add: `NeedAuthPayload`

2. In `MESSAGE_TYPE_NAME` map:
   - Remove entries for `SellerReceipt`, `BuyerAck`, `TopUpRequest`
   - Add: `[MessageType.NeedAuth]: 'NeedAuth'`

3. Remove handler fields:
   - `_onSellerReceipt`
   - `_onBuyerAck`
   - `_onTopUpRequest`

4. Remove handler registration methods:
   - `onSellerReceipt()`
   - `onBuyerAck()`
   - `onTopUpRequest()`

5. Remove sender methods:
   - `sendSellerReceipt()`
   - `sendBuyerAck()`
   - `sendTopUpRequest()`

6. Add handler field, registration, and sender for NeedAuth:
   ```typescript
   private _onNeedAuth?: PaymentMessageHandler<NeedAuthPayload>;

   onNeedAuth(handler: PaymentMessageHandler<NeedAuthPayload>): void {
     this._onNeedAuth = handler;
   }

   sendNeedAuth(payload: NeedAuthPayload): void {
     this._send(MessageType.NeedAuth, codec.encodeNeedAuth(payload));
   }
   ```

7. In `handleFrame()` switch:
   - Remove cases for `SellerReceipt`, `BuyerAck`, `TopUpRequest`
   - Add case:
     ```typescript
     case MessageType.NeedAuth:
       await this._onNeedAuth?.(codec.decodeNeedAuth(frame.payload));
       return true;
     ```

**Verify:** `pnpm run typecheck` passes cleanly. Run existing payment-mux
tests if any; expect some to need updates for removed message types.
