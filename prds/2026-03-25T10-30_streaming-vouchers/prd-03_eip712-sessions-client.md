# PRD-03: EIP-712 Types + SessionsClient TS

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-01
**Blocked by:** PRD-01

## Overview

Update the TypeScript EIP-712 signing utilities and `SessionsClient` to match the new cumulative streaming SpendingAuth model from PRD-01. Drop proof-chain fields from the EIP-712 type, remove Ed25519 receipt/ack message builders (off-chain bilateral receipts dropped), and rewrite `SessionsClient` methods and ABI to match the new contract interface.

## Source Files

- `packages/node/src/payments/evm/signatures.ts`
- `packages/node/src/payments/evm/sessions-client.ts`

## Tasks

### Task 1: Update `SPENDING_AUTH_TYPES` in `signatures.ts`

Replace the current 7-field EIP-712 type:
```typescript
SpendingAuth: [
  { name: 'seller', type: 'address' },
  { name: 'sessionId', type: 'bytes32' },
  { name: 'maxAmount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'previousConsumption', type: 'uint256' },
  { name: 'previousSessionId', type: 'bytes32' },
]
```

With the new 7-field type (same count, different fields):
```typescript
SpendingAuth: [
  { name: 'seller', type: 'address' },
  { name: 'sessionId', type: 'bytes32' },
  { name: 'cumulativeAmount', type: 'uint256' },
  { name: 'cumulativeInputTokens', type: 'uint256' },
  { name: 'cumulativeOutputTokens', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
]
```

#### Acceptance Criteria
- [ ] `SPENDING_AUTH_TYPES.SpendingAuth` has exactly 7 entries
- [ ] Fields are: `seller`, `sessionId`, `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens`, `nonce`, `deadline`
- [ ] `maxAmount`, `previousConsumption`, `previousSessionId` are gone
- [ ] Field order matches the Solidity typehash in PRD-01 Task 1

---

### Task 2: Update `SpendingAuthMessage` interface in `signatures.ts`

Replace:
```typescript
interface SpendingAuthMessage {
  seller: string;
  sessionId: string;
  maxAmount: bigint;
  nonce: number;
  deadline: number;
  previousConsumption: bigint;
  previousSessionId: string;
}
```

With:
```typescript
export interface SpendingAuthMessage {
  seller: string;
  sessionId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  nonce: number;
  deadline: number;
}
```

The `signSpendingAuth` function signature stays the same — it already takes a generic `SpendingAuthMessage` and passes it through to `signer.signTypedData`.

#### Acceptance Criteria
- [ ] `SpendingAuthMessage` has exactly 7 fields
- [ ] `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens` are `bigint`
- [ ] `maxAmount`, `previousConsumption`, `previousSessionId` are gone
- [ ] `signSpendingAuth` still compiles and works with the new interface
- [ ] `makeSessionsDomain` unchanged

---

### Task 3: Remove `buildReceiptMessage` and `buildAckMessage` from `signatures.ts`

These functions built Ed25519 receipt/ack messages for the bilateral off-chain proof system. With cumulative streaming vouchers, the buyer signs EIP-712 vouchers directly — no separate receipt/ack exchange needed.

**Remove:**
- `buildReceiptMessage` function (lines 52-70)
- `buildAckMessage` function (lines 72-87)

**Keep:**
- `signMessageEd25519` — still used for general P2P message signing
- `verifyMessageEd25519` — still used for general P2P signature verification

Also check for any callers of `buildReceiptMessage` or `buildAckMessage` across the codebase. If found, note them as requiring updates in a follow-up task.

#### Acceptance Criteria
- [ ] `buildReceiptMessage` function removed
- [ ] `buildAckMessage` function removed
- [ ] `signMessageEd25519` and `verifyMessageEd25519` retained
- [ ] No TypeScript compile errors in `signatures.ts`
- [ ] Any callers in other files identified and flagged

---

### Task 4: Update `SessionInfo` type in `sessions-client.ts`

Replace the current 15-field `SessionInfo`:
```typescript
interface SessionInfo {
  buyer: string;
  seller: string;
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  previousConsumption: bigint;
  previousSessionId: string;
  reservedAt: bigint;
  settledAmount: bigint;
  settledTokenCount: bigint;
  tokenRate: bigint;
  status: number;
  isFirstSign: boolean;
  isProvenSign: boolean;
  isQualifiedProvenSign: boolean;
}
```

With the new 10-field struct matching the contract from PRD-01 Task 1:
```typescript
export interface SessionInfo {
  buyer: string;
  seller: string;
  deposit: bigint;
  settled: bigint;
  settledInputTokens: bigint;
  settledOutputTokens: bigint;
  nonce: bigint;
  deadline: bigint;
  settledAt: bigint;
  status: number;
}
```

#### Acceptance Criteria
- [ ] `SessionInfo` has exactly 10 fields matching the Solidity `Session` struct
- [ ] Removed fields: `maxAmount`, `previousConsumption`, `previousSessionId`, `reservedAt`, `settledAmount`, `settledTokenCount`, `tokenRate`, `isFirstSign`, `isProvenSign`, `isQualifiedProvenSign`
- [ ] New fields: `deposit`, `settled`, `settledInputTokens`, `settledOutputTokens`, `settledAt`
- [ ] `status` remains `number`

---

### Task 5: Update `SessionsClient` methods and ABI

**Update `SESSIONS_ABI`** to match the new contract:
```typescript
const SESSIONS_ABI = [
  'function reserve(address buyer, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes calldata buyerSig) external',
  'function settle(bytes32 sessionId, uint256 cumulativeAmount, uint128 cumulativeInputTokens, uint128 cumulativeOutputTokens, bytes calldata buyerSig) external',
  'function settleTimeout(bytes32 sessionId) external',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'function sessions(bytes32 sessionId) external view returns (address buyer, address seller, uint256 deposit, uint256 settled, uint128 settledInputTokens, uint128 settledOutputTokens, uint256 nonce, uint256 deadline, uint256 settledAt, uint8 status)',
] as const;
```

**Remove ABI entries:**
- `latestSessionId` — mapping dropped in PRD-01
- `firstSessionTimestamp` — mapping dropped in PRD-01
- `PROVEN_SIGN_COOLDOWN` — constant dropped in PRD-01

**Update `reserve()` method:**
```typescript
async reserve(
  signer: AbstractSigner,
  buyer: string,
  sessionId: string,
  maxAmount: bigint,
  nonce: bigint,
  deadline: bigint,
  buyerSig: string,
): Promise<string>
```
Drop `previousConsumption` and `previousSessionId` params.

**Update `settle()` method:**
```typescript
async settle(
  signer: AbstractSigner,
  sessionId: string,
  cumulativeAmount: bigint,
  cumulativeInputTokens: bigint,
  cumulativeOutputTokens: bigint,
  buyerSig: string,
): Promise<string>
```
Replace the old `(signer, sessionId, tokenCount)` signature with the new cumulative fields plus buyer signature.

**Update `getSession()` method:**
Parse the new 10-field struct from the contract return value:
```typescript
async getSession(sessionId: string): Promise<SessionInfo> {
  const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
  const result = await contract.getFunction('sessions')(sessionId);
  return {
    buyer: result[0],
    seller: result[1],
    deposit: result[2],
    settled: result[3],
    settledInputTokens: result[4],
    settledOutputTokens: result[5],
    nonce: result[6],
    deadline: result[7],
    settledAt: result[8],
    status: Number(result[9]),
  };
}
```

**Remove methods:**
- `getLatestSessionId()` — depends on dropped `latestSessionId` mapping
- `getFirstSessionTimestamp()` — depends on dropped `firstSessionTimestamp` mapping
- `getProvenSignCooldown()` — depends on dropped `PROVEN_SIGN_COOLDOWN` constant
- `getBuyerApprovalContext()` — depends on all three removed methods above

**Keep methods:**
- `settleTimeout()` — unchanged
- `domainSeparator()` — unchanged
- `getFirstSignCap()` — unchanged

Also check for callers of the removed methods across the codebase. If found, note them as requiring updates.

#### Acceptance Criteria
- [ ] `SESSIONS_ABI` matches the new contract — 6 entries (reserve, settle, settleTimeout, domainSeparator, FIRST_SIGN_CAP, sessions)
- [ ] `reserve()` has 7 params — no `previousConsumption`, no `previousSessionId`
- [ ] `settle()` has 6 params — `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens`, `buyerSig`
- [ ] `getSession()` returns 10-field `SessionInfo` matching the new struct
- [ ] `getLatestSessionId`, `getFirstSessionTimestamp`, `getProvenSignCooldown`, `getBuyerApprovalContext` removed
- [ ] `settleTimeout`, `domainSeparator`, `getFirstSignCap` retained unchanged
- [ ] No TypeScript compile errors
- [ ] Any callers of removed methods identified and flagged
