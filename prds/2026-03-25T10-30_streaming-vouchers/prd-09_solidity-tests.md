# PRD-09: Solidity Tests — AntseedSessions

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-01 (AntseedSessions contract), PRD-02 (interfaces + deploy)
**Blocked by:** PRD-01, PRD-02

## Overview

The old AntseedEscrow.t.sol was deleted in the contract split, along with the
E2E integration test. We need a new Foundry test file for the rewritten
AntseedSessions contract covering reserve, settle, settleTimeout, and edge
cases.

### Files touched

- `packages/node/contracts/test/AntseedSessions.t.sol` (new file)

---

## Tasks

### Task 1: Create AntseedSessions.t.sol test base

**Goal:** Set up the test harness that deploys all 4 contracts plus MockUSDC,
wires them together, and provides reusable helpers for every subsequent test.

**Steps:**

1. Create `packages/node/contracts/test/AntseedSessions.t.sol`.
2. Import and deploy all 5 contracts in `setUp()`:
   - `MockUSDC` (6 decimals, mint to test accounts)
   - `AntseedIdentity`
   - `AntseedStaking`
   - `AntseedDeposits`
   - `AntseedSessions`
3. Wire contracts together (set sessions address on deposits, set deposits/
   identity addresses on sessions, etc.).
4. Create helper functions:
   - `createBuyer(uint256 privateKey)` — register identity, approve USDC,
     deposit into AntseedDeposits
   - `createSeller(uint256 privateKey)` — register identity, approve USDC,
     stake into AntseedStaking
   - `signSpendingAuth(uint256 pk, address seller, bytes32 sessionId, uint256 cumulativeAmount, uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 nonce, uint256 deadline)` — produce a valid EIP-712 signature using `vm.sign()`
   - `signCumulativeAuth(...)` — alias or wrapper if needed for clarity in settle tests
5. Use deterministic private keys (e.g., `0xA11CE`, `0xB0B`) via `vm.addr()`
   for buyer/seller addresses.

#### Acceptance Criteria
- [ ] `forge test` compiles and runs the setUp without errors
- [ ] All 4 contracts + MockUSDC are deployed and wired in setUp
- [ ] `createBuyer()` produces a funded, deposited buyer
- [ ] `createSeller()` produces a staked seller
- [ ] `signSpendingAuth()` returns a valid EIP-712 signature recoverable to the signer

---

### Task 2: Test reserve() — new session

**Goal:** Verify that a seller can open a new session by calling `reserve()`
with a buyer-signed SpendingAuth where cumulativeAmount=0.

**Steps:**

1. Create buyer (deposit 100 USDC) and seller (stake sufficient amount).
2. Sign an initial SpendingAuth with `cumulativeAmount=0`,
   `cumulativeInputTokens=0`, `cumulativeOutputTokens=0`.
3. Seller calls `reserve(buyer, sessionId, maxAmount, nonce, deadline, sig)`.
4. Assert:
   - Session exists with `status == Active`
   - `session.deposit == maxAmount`
   - `session.buyer` and `session.seller` match
   - `session.settled == 0`
   - `session.nonce == nonce`
5. Assert buyer's Deposits: `reserved` increased by `maxAmount`,
   `available` decreased by `maxAmount`.

#### Acceptance Criteria
- [ ] New session is created with status Active and correct deposit
- [ ] Buyer's reserved balance increased, available balance decreased
- [ ] Session fields (buyer, seller, nonce, deadline) match inputs

---

### Task 3: Test reserve() — top-up existing session

**Goal:** Verify that calling `reserve()` again on an already-Active session
adds to the deposit rather than creating a new session.

**Steps:**

1. Set up a buyer and seller; reserve an initial session with `maxAmount=50 USDC`.
2. Sign a new SpendingAuth (same sessionId, updated nonce) and call `reserve()`
   again with `maxAmount=30 USDC`.
3. Assert:
   - `session.deposit == 80 USDC` (50 + 30)
   - `session.status` is still `Active`
4. Assert buyer's Deposits: `reserved` increased by additional 30 USDC.

#### Acceptance Criteria
- [ ] Session deposit accumulates across multiple reserve() calls
- [ ] Session status remains Active after top-up
- [ ] Buyer's reserved balance reflects the total reservation

---

### Task 4: Test settle() with cumulative SpendingAuth

**Goal:** Verify the seller can settle a session by submitting the final
buyer-signed cumulative SpendingAuth.

**Steps:**

1. Create buyer and seller; reserve a session with deposit=100 USDC.
2. Sign a cumulative SpendingAuth with `cumulativeAmount=60 USDC`,
   `cumulativeInputTokens=5000`, `cumulativeOutputTokens=2000`.
3. Seller calls `settle(sessionId, cumulativeAmount, cumulativeInputTokens,
   cumulativeOutputTokens, nonce, deadline, sig)`.
4. Assert session state:
   - `status == Settled`
   - `settled == 60 USDC`
   - `settledInputTokens == 5000`
   - `settledOutputTokens == 2000`
   - `settledAt > 0` (set to block.timestamp)
5. Assert financial state:
   - Seller earnings credited with 60 USDC (check Deposits or direct balance)
   - Buyer's reserved decreased by 100 USDC (full deposit released)
   - Buyer's available increased by 40 USDC (deposit - cumulativeAmount refund)
6. Assert reputation:
   - Identity sessionCount incremented for both buyer and seller

#### Acceptance Criteria
- [ ] Session status transitions to Settled with correct settled amounts
- [ ] settledAt is set to block.timestamp
- [ ] Seller receives cumulativeAmount, buyer gets refund of (deposit - cumulativeAmount)
- [ ] Identity reputation (sessionCount) updated for both parties

---

### Task 5: Test settleTimeout()

**Goal:** Verify that anyone can time out a stale session after the grace
period, releasing the full deposit back to the buyer.

**Steps:**

1. Create buyer and seller; reserve a session with deposit=100 USDC.
2. Attempt `settleTimeout()` immediately — assert revert (grace period not
   elapsed).
3. Warp time forward past `CLOSE_GRACE_PERIOD` (2 hours):
   `vm.warp(block.timestamp + 2 hours + 1)`.
4. Call `settleTimeout(sessionId)` from an arbitrary third-party address.
5. Assert session state:
   - `status == TimedOut`
   - `settled == 0`
6. Assert financial state:
   - Full deposit (100 USDC) released back to buyer's available balance
   - Buyer's reserved decreased by 100 USDC

#### Acceptance Criteria
- [ ] settleTimeout() reverts before CLOSE_GRACE_PERIOD elapses
- [ ] After grace period, any address can call settleTimeout()
- [ ] Session status transitions to TimedOut
- [ ] Full deposit returned to buyer, no funds go to seller

---

### Task 6: Test edge cases and reverts

**Goal:** Verify that invalid inputs and boundary conditions revert with
the expected errors.

**Tests:**

1. **settle() with cumulativeAmount > deposit** — sign a SpendingAuth with
   `cumulativeAmount=150` on a session with `deposit=100`. Assert revert
   (e.g., `CumulativeExceedsDeposit` or arithmetic underflow).

2. **settle() with invalid signature** — submit a SpendingAuth signed by
   a random key (not the buyer). Assert revert (`InvalidSignature`).

3. **settle() on non-Active session** — settle a session, then try to settle
   it again. Assert revert (`SessionNotActive` or similar).

4. **reserve() exceeds FIRST_SIGN_CAP for new buyer-seller pair** — if the
   contract enforces a cap on the first session between a new pair, attempt
   to reserve above that cap and assert revert.

5. **reserve() with insufficient buyer balance** — buyer deposits 10 USDC,
   attempt to reserve 50 USDC. Assert revert.

6. **settle() with expired deadline** — sign a SpendingAuth with a past
   deadline, attempt settle. Assert revert (`DeadlineExpired`).

#### Acceptance Criteria
- [ ] Each invalid scenario reverts with the appropriate error
- [ ] No state changes occur on reverted transactions
- [ ] All 6 edge cases covered with individual test functions
