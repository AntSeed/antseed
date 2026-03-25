# PRD-08: Desktop + CLI + Config Updates

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-03 (EIP-712 / SessionsClient), PRD-07 (Node.ts Wiring)
**Blocked by:** PRD-03, PRD-07

## Overview

Update the desktop app IPC handlers, bridge types, and CLI payment config to
match the new cumulative SpendingAuth model. The main changes are: replace
`previousConsumption`/`previousSessionId`/`maxAmount` fields with cumulative
amount and token fields, remove obsolete config keys (`tokenRate`,
`firstSignCap`), and add new buyer/seller config fields.

### Files touched

- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/renderer/types/bridge.ts`
- `apps/cli/src/cli/commands/seed.ts`
- `apps/cli/src/cli/commands/connect.ts`

---

## Tasks

### Task 1: Update desktop `payments:sign-spending-auth` IPC handler

**Goal:** Change the IPC handler parameter shape to match the new
SpendingAuthMessage (cumulative model, no previousConsumption/previousSessionId).

**Steps:**

1. In `main.ts` (~line 682), update the `payments:sign-spending-auth` handler
   params from:
   ```typescript
   {
     sellerEvmAddress: string;
     sessionId: string;
     maxAmountBaseUnits: string;
     nonce: number;
     deadline: number;
     previousConsumption: string;
     previousSessionId: string;
   }
   ```
   To:
   ```typescript
   {
     sellerEvmAddress: string;
     sessionId: string;
     cumulativeAmountBaseUnits: string;
     cumulativeInputTokens: string;
     cumulativeOutputTokens: string;
     nonce: number;
     deadline: number;
   }
   ```

2. Update validation:
   - Remove: `BYTES32_RE.test(params.previousSessionId)` check (line 706-708).
   - Change: `BigInt(params.maxAmountBaseUnits)` to
     `BigInt(params.cumulativeAmountBaseUnits)`. Keep the
     `> MAX_SPENDING_AUTH_BASE_UNITS` cap check.
   - Add: validate `cumulativeInputTokens` and `cumulativeOutputTokens` are
     non-negative numeric strings.

3. Update the `signSpendingAuth()` call (line 728-736):
   - Change: `maxAmount` to `cumulativeAmount`
     (`BigInt(params.cumulativeAmountBaseUnits)`).
   - Change: `previousConsumption` / `previousSessionId` to
     `cumulativeInputTokens` (`BigInt(params.cumulativeInputTokens)`) and
     `cumulativeOutputTokens` (`BigInt(params.cumulativeOutputTokens)`).
   - Match whatever field names PRD-03 defines for the updated
     `signSpendingAuth` domain types.

**Acceptance criteria:**
- Handler accepts the new parameter shape.
- `previousConsumption` and `previousSessionId` are no longer accepted or
  validated.
- `cumulativeInputTokens` and `cumulativeOutputTokens` are validated and
  passed to `signSpendingAuth()`.
- Signing still returns `{ signature, buyerEvmAddress }`.

---

### Task 2: Update desktop `chat:approve-payment` handler

**Goal:** Update manual payment approval to use cumulative fields for the
initial SpendingAuth.

**Steps:**

1. In `main.ts` (~line 847), in the `chat:approve-payment` handler:
   - Remove: `previousConsumption: 0n` and
     `previousSessionId: '0x' + '00'.repeat(32)` from the `signSpendingAuth()`
     call (lines 900-901).
   - Add: `cumulativeInputTokens: 0n` and `cumulativeOutputTokens: 0n`
     (initial auth has no prior consumption).
   - Change: `maxAmount` to `cumulativeAmount` — set to
     `minBudgetPerRequest` from the PaymentRequired payload if available,
     otherwise fall back to `suggestedAmount`.

2. Update the `authPayload` object (lines 905-915):
   - Change: `maxAmountUsdc` to `cumulativeAmount`.
   - Remove: `previousConsumption` and `previousSessionId` fields.
   - Add: `cumulativeInputTokens: '0'` and `cumulativeOutputTokens: '0'`.

**Acceptance criteria:**
- Initial SpendingAuth from manual approval uses `cumulativeAmount` with
  cumulative token counts at zero.
- No `previousConsumption` or `previousSessionId` in the auth payload.
- The `authBase64` payload set via `chatEngine.setPendingSpendingAuth()` uses
  the new field names.

---

### Task 3: Update desktop bridge types

**Goal:** Update the renderer-side TypeScript type for the spending-auth
signing bridge method to match the new parameter shape.

**Steps:**

1. In `bridge.ts` (~line 139), update `paymentsSignSpendingAuth` from:
   ```typescript
   paymentsSignSpendingAuth?: (params: {
     sellerEvmAddress: string;
     sessionId: string;
     maxAmountBaseUnits: string;
     nonce: number;
     deadline: number;
     previousConsumption: string;
     previousSessionId: string;
   }) => Promise<{ ok: boolean; data?: { signature: string; buyerEvmAddress: string }; error?: string }>;
   ```
   To:
   ```typescript
   paymentsSignSpendingAuth?: (params: {
     sellerEvmAddress: string;
     sessionId: string;
     cumulativeAmountBaseUnits: string;
     cumulativeInputTokens: string;
     cumulativeOutputTokens: string;
     nonce: number;
     deadline: number;
   }) => Promise<{ ok: boolean; data?: { signature: string; buyerEvmAddress: string }; error?: string }>;
   ```

2. Verify the preload script (if any) that bridges `ipcRenderer.invoke`
   matches the updated parameter names.

**Acceptance criteria:**
- `paymentsSignSpendingAuth` type uses `cumulativeAmountBaseUnits`,
  `cumulativeInputTokens`, `cumulativeOutputTokens`.
- `maxAmountBaseUnits`, `previousConsumption`, `previousSessionId` are removed
  from the type.
- Return type is unchanged.

---

### Task 4: Update CLI `seed.ts` payment config

**Goal:** Update seller-side payment config fields to remove tokenRate-based
pricing and add per-request budget config.

**Steps:**

1. In `seed.ts`, in the payment config section (~lines 254-358):
   - Remove: any `tokenRate`-related config fields if present in the config
     object or seller config.
   - Add to the seller config (via `effectiveSellerConfig` or the node
     constructor `payments` block):
     - `minBudgetPerRequest`: minimum USDC the seller requires per request
       (from `config.payments.minBudgetPerRequest` or a sensible default
       like `'10000'` = $0.01).
   - The `tokenRate` field in PaymentRequired is replaced by
     `minBudgetPerRequest` + per-direction pricing from provider metadata.
     Ensure the node constructor receives `minBudgetPerRequest`.

2. The `suggestedAmount` in PaymentRequired is now computed by the
   SellerPaymentManager from `minBudgetPerRequest` and a multiplier, so no
   CLI config change is needed for that.

**Acceptance criteria:**
- `tokenRate` is not passed in the payments config to `AntseedNode`.
- `minBudgetPerRequest` is configurable and passed to the node.
- Existing seller config fields (reserveFloor, maxConcurrentBuyers, etc.)
  remain unchanged.

---

### Task 5: Update CLI `connect.ts` payment config

**Goal:** Update buyer-side payment config fields to support the cumulative
model.

**Steps:**

1. In `connect.ts`, in the payment config section (~lines 296-332):
   - Add to `paymentsConfig` or the node constructor:
     - `maxPerRequestUsdc`: maximum USDC the buyer authorizes per single
       request (from `config.payments.maxPerRequestUsdc` or a default like
       `'100000'` = $0.10).
     - `maxReserveAmountUsdc`: maximum total USDC the buyer will reserve in
       a single SpendingAuth (from `config.payments.maxReserveAmountUsdc` or
       a default like `'1000000'` = $1.00).
   - These values are passed to BuyerPaymentManager via the node config and
     used in `_doNegotiatePayment()` (PRD-07 Task 6) to cap the
     initial auth amount.

2. Display the new config in the "Effective buyer settings" section:
   ```typescript
   console.log(chalk.dim(`  max per-request USDC: ${formatUsdc(maxPerRequestUsdc)}`))
   console.log(chalk.dim(`  max reserve USDC: ${formatUsdc(maxReserveAmountUsdc)}`))
   ```

**Acceptance criteria:**
- `maxPerRequestUsdc` and `maxReserveAmountUsdc` are configurable.
- Both are passed to the node and available to BuyerPaymentManager.
- Both are displayed in the startup "Effective buyer settings" output.
- Sensible defaults are applied if not configured.
