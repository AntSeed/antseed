# PRD-01: AntseedSessions.sol — Cumulative SpendingAuth Model

**Created:** 2026-03-25T11:00Z
**Depends on:** None
**Blocked by:** None

## Overview

Rewrite AntseedSessions.sol to replace the single-SpendingAuth-per-session model (with proof-of-prior-delivery chains) with a cumulative streaming SpendingAuth model where the buyer signs a running total and the seller settles once with a final buyer-signed voucher.

## Tasks

### Task 1: Update EIP-712 typehash and Session struct

Replace the current `SPENDING_AUTH_TYPEHASH` and `Session` struct with the new cumulative model.

**SPENDING_AUTH_TYPEHASH** — replace:
```solidity
"SpendingAuth(address seller,bytes32 sessionId,uint256 maxAmount,uint256 nonce,uint256 deadline,uint256 previousConsumption,bytes32 previousSessionId)"
```
with:
```solidity
"SpendingAuth(address seller,bytes32 sessionId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeOutputTokens,uint256 nonce,uint256 deadline)"
```

**SessionStatus enum** — rename `Reserved` to `Active`:
```solidity
enum SessionStatus { None, Active, Settled, TimedOut }
```

**Session struct** — replace entirely:
```solidity
struct Session {
    address buyer;
    address seller;
    uint256 deposit;              // Total USDC reserved (accumulates on top-up)
    uint256 settled;              // Cumulative USDC settled (set once at settle)
    uint128 settledInputTokens;   // Cumulative input tokens (set once at settle)
    uint128 settledOutputTokens;  // Cumulative output tokens (set once at settle)
    uint256 nonce;
    uint256 deadline;
    uint256 settledAt;            // Timestamp of settlement, 0 if not yet settled
    SessionStatus status;
}
```

#### Acceptance Criteria
- [ ] `SPENDING_AUTH_TYPEHASH` matches the new 7-field SpendingAuth type
- [ ] `Session` struct has exactly the 10 fields listed above
- [ ] `SessionStatus` enum uses `Active` instead of `Reserved`
- [ ] Old struct fields (`maxAmount`, `previousConsumption`, `previousSessionId`, `reservedAt`, `settledAmount`, `settledTokenCount`, `tokenRate`, `isFirstSign`, `isProvenSign`, `isQualifiedProvenSign`) are removed

---

### Task 2: Remove dropped constants, keys, mappings, and errors

**Remove constants:**
- `MIN_TOKEN_THRESHOLD`
- `BUYER_DIVERSITY_THRESHOLD`
- `PROVEN_SIGN_COOLDOWN`

**Remove constant keys:**
- `KEY_MIN_TOKEN_THRESHOLD`
- `KEY_BUYER_DIVERSITY_THRESHOLD`
- `KEY_PROVEN_SIGN_COOLDOWN`

**Rename:**
- `SETTLE_TIMEOUT` → `CLOSE_GRACE_PERIOD`, default `2 hours` (was `24 hours`)
- `KEY_SETTLE_TIMEOUT` → `KEY_CLOSE_GRACE_PERIOD`

**Remove mappings:**
- `latestSessionId`
- `firstSessionTimestamp`

**Remove errors:**
- `CooldownNotElapsed`
- `InvalidProofChain`

**Add error:**
- `SellerNotStaked`

#### Acceptance Criteria
- [ ] `MIN_TOKEN_THRESHOLD`, `BUYER_DIVERSITY_THRESHOLD`, `PROVEN_SIGN_COOLDOWN` are gone
- [ ] Their `KEY_*` constants are gone
- [ ] `CLOSE_GRACE_PERIOD` exists with default `2 hours`
- [ ] `KEY_CLOSE_GRACE_PERIOD` exists, `KEY_SETTLE_TIMEOUT` is gone
- [ ] `latestSessionId` and `firstSessionTimestamp` mappings are gone
- [ ] `CooldownNotElapsed` and `InvalidProofChain` errors are gone
- [ ] `SellerNotStaked` error exists

---

### Task 3: Rewrite `reserve()` function

New signature:
```solidity
function reserve(
    address buyer,
    bytes32 sessionId,
    uint256 maxAmount,
    uint256 nonce,
    uint256 deadline,
    bytes calldata buyerSig
) external nonReentrant whenNotPaused
```

Logic:
1. Validate `block.timestamp <= deadline`.
2. Staking check: `if (!stakingContract.isStakedAboveMin(msg.sender)) revert SellerNotStaked()` — replaces `validateSeller()`.
3. Build EIP-712 struct hash using the new typehash with `cumulativeAmount=0, cumulativeInputTokens=0, cumulativeOutputTokens=0`.
4. Recover signer, verify `recovered == buyer`.
5. **Top-up path:** if `sessions[sessionId].status == SessionStatus.Active`, verify `session.buyer == buyer && session.seller == msg.sender`, then add `maxAmount` to `session.deposit`. Update `session.nonce` and `session.deadline`.
6. **Create path:** if `sessions[sessionId].status == SessionStatus.None`, apply `FIRST_SIGN_CAP` check (first reserve for any buyer-seller pair can use the existing session-level cap: `maxAmount <= FIRST_SIGN_CAP`). Call `depositsContract.lockForSession(buyer, maxAmount)`. Store new session with `deposit = maxAmount`, all settled fields zero, `status = Active`.
7. If status is anything else (`Settled`, `TimedOut`), revert `InvalidSession`.
8. Emit `Reserved(sessionId, buyer, msg.sender, maxAmount)`.

**Dropped from current reserve:** proof chain validation, first-sign/proven-sign classification, proven-sign cooldown, reputation updates on reserve, `latestSessionId`/`firstSessionTimestamp` writes, `tokenRate` storage, `incrementActiveSessions` call on top-up (only on create).

#### Acceptance Criteria
- [ ] `reserve()` has 6 params (no `previousConsumption`, no `previousSessionId`)
- [ ] EIP-712 struct hash encodes the new typehash with three zero cumulative fields
- [ ] Staking check uses `isStakedAboveMin()`, not `validateSeller()`
- [ ] Top-up path increments `deposit` on an existing Active session without creating a new session
- [ ] Top-up path calls `lockForSession` for the additional `maxAmount`
- [ ] Create path enforces `FIRST_SIGN_CAP` and stores a new Active session
- [ ] `incrementActiveSessions` called only on create, not on top-up
- [ ] No proof chain validation, no reputation update in reserve

---

### Task 4: Rewrite `settle()` function

New signature:
```solidity
function settle(
    bytes32 sessionId,
    uint256 cumulativeAmount,
    uint256 cumulativeInputTokens,
    uint256 cumulativeOutputTokens,
    uint256 nonce,
    uint256 deadline,
    bytes calldata buyerSig
) external nonReentrant
```

Logic:
1. Load session, verify `status == Active`.
2. Verify `msg.sender == session.seller`.
3. Verify `block.timestamp <= deadline`.
4. Verify `cumulativeAmount <= session.deposit`.
5. Build EIP-712 struct hash with all cumulative fields and verify buyer signature.
6. Compute `platformFee = (cumulativeAmount * PLATFORM_FEE_BPS) / 10000`.
7. Call `depositsContract.chargeAndCreditEarnings(session.buyer, session.seller, cumulativeAmount, session.deposit, platformFee, protocolReserve, false)` — pass `false` for `isProvenSign` (compatibility until PRD-02 removes this param).
8. Update session: `settled = cumulativeAmount`, `settledInputTokens = uint128(cumulativeInputTokens)`, `settledOutputTokens = uint128(cumulativeOutputTokens)`, `settledAt = block.timestamp`, `status = Settled`.
9. Call `stakingContract.decrementActiveSessions(session.seller)`.
10. Update reputation on Identity with volume and token counts. Call `identityContract.updateReputation(sellerTokenId, ReputationUpdate({ updateType: 1, tokenVolume: cumulativeInputTokens + cumulativeOutputTokens }))`. If `sellerTokenId == 0`, skip.
11. Emit `Settled(sessionId, session.seller, cumulativeAmount, platformFee)`.

**Dropped:** tokenRate-based charge computation, effective token count derivation, emissions accrual (emissions contract calls removed entirely — emissions will be re-added in a future PRD if needed).

#### Acceptance Criteria
- [ ] `settle()` takes 7 params including buyer-signed cumulative values
- [ ] EIP-712 signature verified against buyer using new typehash
- [ ] `cumulativeAmount <= session.deposit` enforced
- [ ] `chargeAndCreditEarnings` called with `isProvenSign = false`
- [ ] Session fields (`settled`, `settledInputTokens`, `settledOutputTokens`, `settledAt`) populated
- [ ] Session status set to `Settled`
- [ ] `decrementActiveSessions` called
- [ ] Reputation updated with combined token volume
- [ ] No tokenRate computation, no emissions calls

---

### Task 5: Rewrite `settleTimeout()` function

Signature stays the same: `function settleTimeout(bytes32 sessionId) external nonReentrant`.

Logic changes:
1. Load session, verify `status == Active` (was `Reserved`).
2. **Permissionless:** remove the `msg.sender` check — anyone can call after grace period.
3. Timeout condition: `block.timestamp >= session.deadline + CLOSE_GRACE_PERIOD` (the session deadline plus 2 hours). Revert `TimeoutNotReached` otherwise.
4. Call `depositsContract.releaseLock(session.buyer, session.deposit)` — releases full deposit.
5. Set `session.status = TimedOut`.
6. Call `stakingContract.decrementActiveSessions(session.seller)`.
7. **No reputation update** — drop the ghost mark logic. Timeouts don't penalize reputation.
8. Emit `SettledTimeout(sessionId, session.buyer, session.seller)`.

#### Acceptance Criteria
- [ ] Status check uses `Active` (not `Reserved`)
- [ ] No `msg.sender` restriction — fully permissionless
- [ ] Timeout condition is `block.timestamp >= session.deadline + CLOSE_GRACE_PERIOD`
- [ ] `CLOSE_GRACE_PERIOD` defaults to 2 hours
- [ ] Full `session.deposit` released via `releaseLock`
- [ ] No `identityContract.updateReputation` call
- [ ] `decrementActiveSessions` still called
- [ ] `SettledTimeout` event emitted

---

### Task 6: Update `setConstant()` admin function

Remove branches for dropped constants and rename the timeout key.

**Remove cases:**
- `KEY_MIN_TOKEN_THRESHOLD`
- `KEY_BUYER_DIVERSITY_THRESHOLD`
- `KEY_PROVEN_SIGN_COOLDOWN`

**Update timeout case:**
- Key: `KEY_CLOSE_GRACE_PERIOD`
- Variable: `CLOSE_GRACE_PERIOD`
- Min value: `30 minutes` (was `1 hours` for `SETTLE_TIMEOUT`)

**Keep:**
- `KEY_FIRST_SIGN_CAP` → `FIRST_SIGN_CAP`
- `KEY_PLATFORM_FEE_BPS` → `PLATFORM_FEE_BPS` (with `MAX_PLATFORM_FEE_BPS` guard)

#### Acceptance Criteria
- [ ] `setConstant` handles exactly 3 keys: `KEY_FIRST_SIGN_CAP`, `KEY_CLOSE_GRACE_PERIOD`, `KEY_PLATFORM_FEE_BPS`
- [ ] `KEY_CLOSE_GRACE_PERIOD` enforces minimum 30 minutes
- [ ] Dropped constant keys cause revert via the else branch

---

### Task 7: Update events and clean up emissions references

**Events** — keep as-is:
- `Reserved(bytes32 indexed sessionId, address indexed buyer, address indexed seller, uint256 maxAmount)` — `maxAmount` represents the amount added in this reserve call (works for both create and top-up).
- `Settled(bytes32 indexed sessionId, address indexed seller, uint256 chargeAmount, uint256 platformFee)`
- `SettledTimeout(bytes32 indexed sessionId, address indexed buyer, address indexed seller)`
- `ConstantUpdated(bytes32 indexed key, uint256 value)`

**Remove:**
- `emissionsContract` state variable
- `setEmissionsContract()` admin function
- `IAntseedEmissions` import
- All `emissionsContract.accrue*` calls (already gone from settle rewrite)

#### Acceptance Criteria
- [ ] `emissionsContract` state variable removed
- [ ] `setEmissionsContract()` function removed
- [ ] `IAntseedEmissions` import removed
- [ ] No references to `emissionsContract` anywhere in the contract
- [ ] All four events retained with unchanged signatures

---

### Task 8: Update NatSpec and contract-level documentation

Update the contract's NatSpec to reflect the new model.

**Contract-level comment** — replace:
```
Session lifecycle with Proof of Prior Delivery and EIP-712 spending authorizations.
```
with:
```
Session lifecycle with cumulative streaming SpendingAuth vouchers.
Buyer signs running-total vouchers; seller settles once with the final voucher.
Holds NO USDC — orchestrates between AntseedDeposits and AntseedIdentity.
This contract is swappable: deploy a new version and re-point Deposits + Identity.
```

**EIP-712 version** — bump from `"1"` to `"2"` in the `EIP712` constructor call to signal the typehash change:
```solidity
EIP712("AntseedSessions", "2")
```

#### Acceptance Criteria
- [ ] Contract NatSpec references cumulative streaming model, not proof-of-prior-delivery
- [ ] EIP-712 version is `"2"`
- [ ] No stale comments referencing proof chains, tokenRate, or proven-sign classification
