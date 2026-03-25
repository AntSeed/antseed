# PRD-02: Interfaces + Deploy Script

**Created:** 2026-03-25T11:00Z
**Depends on:** PRD-01
**Blocked by:** PRD-01

## Overview

Update the Solidity interfaces and AntseedDeposits implementation to match the rewritten AntseedSessions contract from PRD-01. Create the missing `IAntseedSessions.sol` interface, remove the `isProvenSign` parameter from `chargeAndCreditEarnings`, clean up the proof-classification bookkeeping in AntseedDeposits, and verify the deploy script still works with the new constructor.

## Source Files

- `packages/node/contracts/interfaces/IAntseedDeposits.sol`
- `packages/node/contracts/interfaces/IAntseedSessions.sol` (new)
- `packages/node/contracts/AntseedDeposits.sol`
- `packages/node/contracts/script/Deploy.s.sol`

## Tasks

### Task 1: Create `IAntseedSessions.sol` interface

New file at `packages/node/contracts/interfaces/IAntseedSessions.sol`.

Define the public interface matching the rewritten contract from PRD-01. The three external mutating functions are `reserve`, `settle`, and `settleTimeout`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSessions {
    function reserve(
        address buyer,
        bytes32 sessionId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata buyerSig
    ) external;

    function settle(
        bytes32 sessionId,
        uint256 cumulativeAmount,
        uint128 cumulativeInputTokens,
        uint128 cumulativeOutputTokens,
        bytes calldata buyerSig
    ) external;

    function settleTimeout(bytes32 sessionId) external;
}
```

Note: `settle()` in the interface uses `uint128` for token counts (matching the Session struct from PRD-01) rather than `uint256`. The actual contract function in PRD-01 Task 4 accepts `uint256` and truncates to `uint128` on storage — align the interface to match whichever the contract uses. If the contract accepts `uint256`, update the interface to `uint256`.

#### Acceptance Criteria
- [ ] File exists at `contracts/interfaces/IAntseedSessions.sol`
- [ ] `reserve()` has 6 params — no `previousConsumption`, no `previousSessionId`
- [ ] `settle()` includes `cumulativeAmount`, `cumulativeInputTokens`, `cumulativeOutputTokens`, and `buyerSig`
- [ ] `settleTimeout()` takes only `sessionId`
- [ ] SPDX license and pragma match the existing interface files

---

### Task 2: Update `IAntseedDeposits.sol` — remove `isProvenSign`

Current `chargeAndCreditEarnings` signature:
```solidity
function chargeAndCreditEarnings(
    address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
    uint256 platformFee, address protocolReserve, bool isProvenSign
) external;
```

New signature — drop the `bool isProvenSign` param:
```solidity
function chargeAndCreditEarnings(
    address buyer, address seller, uint256 chargeAmount, uint256 reservedAmount,
    uint256 platformFee, address protocolReserve
) external;
```

No new functions needed. The existing `releaseLock(address buyer, uint256 amount)` already covers releasing remaining reservation after settlement — `chargeAndCreditEarnings` already deducts the full `reservedAmount` from `ba.reserved` and only charges `chargeAmount` from `ba.balance`. The unused portion (`reservedAmount - chargeAmount`) is implicitly freed. No separate `releaseReservation` is needed because `chargeAndCreditEarnings` handles both charging and releasing in one call: it subtracts the entire `reservedAmount` from `ba.reserved` (releasing the lock) and only subtracts `chargeAmount` from `ba.balance` (the actual charge).

#### Acceptance Criteria
- [ ] `chargeAndCreditEarnings` has 6 params, no `isProvenSign`
- [ ] `lockForSession`, `releaseLock`, `uniqueSellersCharged` unchanged
- [ ] Interface compiles

---

### Task 3: Update `AntseedDeposits.sol` — remove proof-classification logic

Match the interface changes from Task 2:

1. **Remove `isProvenSign` param** from `chargeAndCreditEarnings` function signature.
2. **Remove the `isProvenSign` conditional** inside the function body:
   ```solidity
   // DELETE these lines:
   if (isProvenSign) {
       ba.provenBuyCount++;
   }
   ```
3. **Remove `provenBuyCount` from `BuyerAccount` struct.** This field is only written inside the deleted conditional and read inside `getBuyerCreditLimit`. Since the proven-sign classification is being dropped, this metric is no longer meaningful.
4. **Remove `PROVEN_SESSION_BONUS` from credit limit calculation** in `getBuyerCreditLimit()`. Remove the `+ PROVEN_SESSION_BONUS * ba.provenBuyCount` term.
5. **Remove the `PROVEN_SESSION_BONUS` constant** (line 39), its `KEY_PROVEN_SESSION_BONUS` constant key (line 28), and the `setConstant` branch for it (line 293).

#### Acceptance Criteria
- [ ] `chargeAndCreditEarnings` has 6 params, no `isProvenSign`
- [ ] No `if (isProvenSign)` block in the function body
- [ ] `provenBuyCount` removed from `BuyerAccount` struct
- [ ] `PROVEN_SESSION_BONUS` constant, key, and `setConstant` branch removed
- [ ] `getBuyerCreditLimit` no longer references `provenBuyCount` or `PROVEN_SESSION_BONUS`
- [ ] Contract compiles
- [ ] `releaseLock`, `lockForSession` unchanged

---

### Task 4: Verify Deploy.s.sol — no changes needed

The deploy script deploys `AntseedSessions(deposits, identity, staking)` at line 71-78. The constructor signature does not change in PRD-01 (the contract still takes `deposits`, `identity`, `staking` as constructor args). The wiring calls also remain the same.

**Verification checklist:**
- Constructor call: `abi.encode(deposits, identity, staking)` — unchanged
- Wiring: `ISetSessions(deposits).setSessionsContract(sessions)` — unchanged
- Wiring: `ISetSessions(identity).setSessionsContract(sessions)` — unchanged
- Wiring: `ISetSessions(staking).setSessionsContract(sessions)` — unchanged
- Wiring: `ISetProtocolReserve(sessions).setProtocolReserve(protocolReserve)` — unchanged
- The `ISetEmissions(sessions).setEmissionsContract(emissions)` wiring call (line 107) **must be removed** — PRD-01 Task 7 drops `emissionsContract` from AntseedSessions, so this wiring call would fail.

#### Acceptance Criteria
- [ ] `AntseedSessions` constructor call unchanged: `abi.encode(deposits, identity, staking)`
- [ ] Line `ISetEmissions(sessions).setEmissionsContract(emissions)` removed from the wiring section
- [ ] All other wiring calls unchanged
- [ ] Deploy script compiles and runs against local anvil
