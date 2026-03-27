> **Note (2026-03-27):** This audit was based on a pre-fix version of the contracts. All three VULNs identified below have been addressed:
> - **VULN-001** (reserve sig doesn't bind maxAmount/deadline): Fixed — introduced dedicated `ReserveAuth(channelId, maxAmount, deadline)` EIP-712 type that binds all reserve parameters to the buyer's signature.
> - **VULN-002** (topUp without buyer auth): Fixed — `topUp()` has been removed. Budget exhaustion triggers a new session negotiation with a fresh ReserveAuth.
> - **VULN-003** (partial settle inflates sessionCount): Fixed — `sessionCount` is now incremented only on `close()`, not on intermediate `settle()` calls.

# Security Audit Report

**Scope**
- `/Users/shahafan/Development/antseed/packages/node/contracts/AntseedSessions.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/AntseedDeposits.sol`

**Related files reviewed for confidence**
- `/Users/shahafan/Development/antseed/packages/node/contracts/AntseedStats.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/AntseedStaking.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/interfaces/IAntseedDeposits.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/interfaces/IAntseedSessions.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/interfaces/IAntseedStats.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/interfaces/IAntseedStaking.sol`
- `/Users/shahafan/Development/antseed/packages/node/contracts/interfaces/IAntseedEmissions.sol`

**Date**
- 2026-03-26

**Method**
- Manual code review
- Cross-file authorization and accounting trace
- Test review
- Local execution of:
  - `forge test --match-contract 'Antseed(Sessions|Deposits)Test' -vv`

**Test Result**
- 104 tests passed
- This does not eliminate logic or authorization flaws; it only confirms current tested behavior.

---

## Executive Summary

This review identified **3 high-confidence issues** in the current Sessions/Deposits design.

The most important problems are in `AntseedSessions.sol`, where seller-controlled actions can reserve or expand reservation of buyer funds without sufficiently binding buyer intent on-chain. There is also a stats inflation issue where one real session can be counted multiple times if partial settlements occur before close.

### Summary of Findings
- **High severity:** 3
- **Critical severity:** 0
- **Primary themes:** authorization gaps, fund lockup risk, reputation/accounting inflation

---

## Findings

### VULN-001 — `reserve()` signature does not bind `maxAmount` or `deadline`
- **Severity:** High
- **Confidence:** High
- **Location:**
  - `AntseedSessions.sol` reserve flow
  - `AntseedSessions.sol` EIP-712 verification helper

#### Description
The buyer’s signature used during `reserve()` only authenticates:
- `channelId`
- `cumulativeAmount`
- `metadataHash`

For the reserve path, the verified payload is effectively only a zero-state authorization:
- `cumulativeAmount = 0`
- `metadataHash = zeroMetadataHash`

However, the following reserve parameters are **not** authenticated by the buyer signature:
- `maxAmount`
- `deadline`

Because the seller supplies these values on-chain, a seller who has a valid reserve signature for a session can choose a larger amount and/or a much later deadline than the buyer intended.

#### Impact
A malicious seller can lock more of the buyer’s deposited USDC than was intended and keep it reserved for longer than intended.

This creates a practical buyer fund-locking attack:
1. buyer signs a reserve intent off-chain
2. seller submits a larger `maxAmount`
3. seller sets a long `deadline`
4. buyer funds become unavailable because they are reserved in Deposits

This is especially important because the buyer’s available balance is reduced by reservation even though no per-reserve amount/deadline approval is verified on-chain.

#### Evidence
Relevant signed type:

```solidity
bytes32 public constant METADATA_AUTH_TYPEHASH = keccak256(
    "MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
);
```

Reserve path:

```solidity
function reserve(
    address buyer,
    bytes32 salt,
    uint128 maxAmount,
    uint256 deadline,
    bytes calldata buyerSig
) external nonReentrant whenNotPaused {
    ...
    bytes32 channelId = computeChannelId(buyer, msg.sender, salt);
    ...
    _verifyMetadataAuth(channelId, 0, zeroMetadataHash, buyer, buyerSig);
    depositsContract.lockForSession(buyer, maxAmount);
```

#### Recommendation
Introduce a dedicated reserve authorization typed message that includes at least:
- `buyer`
- `seller`
- `salt`
- `maxAmount`
- `deadline`

Do not rely on off-chain convention for escrow-critical terms.

---

### VULN-002 — `topUp()` can reserve additional buyer funds without buyer authorization
- **Severity:** High
- **Confidence:** High
- **Location:** `AntseedSessions.sol` top-up flow

#### Description
Once a session is active, the seller may call `topUp()` and cause additional buyer funds to be reserved:

```solidity
depositsContract.lockForSession(session.buyer, additionalAmount);
session.deposit += additionalAmount;
```

No buyer signature is required for this step, and there is no previously signed maximum-total-reservation enforced on-chain.

#### Impact
A seller with one valid active session can progressively lock more of the buyer’s deposit balance than originally agreed.

This enables a straightforward griefing/fund-freeze pattern:
1. seller opens a legitimate session
2. seller repeatedly calls `topUp()`
3. more buyer funds move from available to reserved
4. buyer cannot withdraw or use those funds until session resolution

This also bypasses the initial `FIRST_SIGN_CAP` restriction, since that cap is only checked during `reserve()`.

#### Evidence
```solidity
function topUp(bytes32 channelId, uint128 additionalAmount) external nonReentrant whenNotPaused {
    Session storage session = sessions[channelId];
    if (session.status != SessionStatus.Active) revert SessionNotActive();
    if (msg.sender != session.seller) revert NotAuthorized();
    if (block.timestamp > session.deadline) revert SessionExpired();
    if (additionalAmount == 0) revert InvalidAmount();

    depositsContract.lockForSession(session.buyer, additionalAmount);
    session.deposit += additionalAmount;
}
```

#### Recommendation
Require explicit buyer authorization for top-ups.

Safe options include:
- a buyer signature per top-up, or
- a signed `maxTotalAmount` established during reserve and enforced for all future top-ups

Also consider enforcing the cap against total session deposit, not just the initial reservation.

---

### VULN-003 — Partial `settle()` plus `close()` inflates `sessionCount`
- **Severity:** High
- **Confidence:** High
- **Location:**
  - `AntseedSessions.sol` settlement and close flows
  - `AntseedStats.sol` stats update logic

#### Description
`AntseedSessions` records stats on every partial `settle()` and again on final `close()`.

Both paths call `_recordStatsAndEmissions(...)`, which sends `updateType: 0` to `AntseedStats`.

`AntseedStats.updateStats(...)` increments `sessionCount` for every update with `updateType == 0`.

As a result, one real session can be counted multiple times if it has one or more intermediate settlements before close.

#### Impact
A seller can inflate session-derived reputation/accounting by splitting a single real session into several checkpoints.

This can distort downstream logic that depends on `sessionCount`, including:
- effective settlement calculations in staking
- reputation/trust heuristics
- analytics and any reward or slashing logic derived from stats

#### Evidence
Settlement path:

```solidity
function settle(...) external nonReentrant {
    ...
    _recordStatsAndEmissions(session, delta, metadata);
}
```

Close path:

```solidity
function close(...) external nonReentrant {
    ...
    _recordStatsAndEmissions(session, delta, metadata);
}
```

Stats update logic:

```solidity
function updateStats(uint256 agentId, StatsUpdate calldata update) external onlySessions {
    AgentStats storage s = _stats[agentId];
    if (update.updateType == 0) {
        s.sessionCount++;
        s.totalVolumeUsdc += update.volumeUsdc;
        ...
    }
}
```

#### Recommendation
Separate “partial settlement accounting” from “session completion accounting.”

Options:
- increment `sessionCount` only once on final close, or
- add a distinct update type for partial settlements that does not increase `sessionCount`

The key invariant should be:
- one completed session → one session count increment

---

## Additional Notes

### No direct theft issue identified in `AntseedDeposits.sol`
Under the current trust boundaries, I did not identify a direct standalone theft primitive in `AntseedDeposits.sol` itself. The main risk is that `AntseedSessions.sol` is currently authorized to manipulate reservation state in ways that do not sufficiently bind buyer intent.

### Tests currently pass
The existing tests validate intended current behavior, including the problematic authorization model. Passing tests therefore should not be interpreted as evidence that the design is secure.

---

## Remediation Priorities

### Priority 1
Fix reserve authorization so buyer-approved terms include:
- amount
- deadline
- seller binding
- salt/session binding

### Priority 2
Fix top-up authorization so additional locked funds require explicit buyer approval or a pre-signed total cap.

### Priority 3
Fix stats accounting so partial settlements do not inflate per-session metrics.

---

## Suggested Follow-Up Work

1. Add new EIP-712 typed data specifically for reserve and top-up flows.
2. Add tests for malicious seller attempts to:
   - reserve more than buyer intended
   - reserve for a longer deadline than buyer intended
   - top up without buyer approval
3. Refactor stats updates to distinguish:
   - partial settlement
   - final session close
4. Re-run:
   - `forge test`
   - fuzz tests for settlement/close ordering
   - invariant tests for Deposits balance/reserved accounting

---

## Conclusion

The current Sessions/Deposits implementation has solid baseline test coverage, but it still contains material authorization flaws that can be abused by a seller to lock buyer funds beyond intended limits. It also contains a stats inflation issue that can overstate session-based reputation or activity.

These should be addressed before relying on the system for production fund custody or reputation-sensitive behavior.
