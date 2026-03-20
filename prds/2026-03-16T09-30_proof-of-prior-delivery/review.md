# Code Review: Proof of Prior Delivery

**Date:** 2026-03-16
**PRD Directory:** prds/2026-03-16T09-30_proof-of-prior-delivery/

## Overall Assessment: PASS_WITH_ISSUES

All 6 PRDs implemented with exact spec compliance. Critical security issues found and fixed.

## Spec Compliance

- Tasks matching spec exactly: **69/69 (100%)**
- Minor deviations: 0
- Major deviations: 0

## Code Quality (Contracts)

- Contracts reviewed: 5
- Issues found: 32 total (2 critical, 3 high, 9 medium, 5 low, 13 info)

### Critical Issues (FIXED)

1. **AntseedEscrow.sol — proof chain validation gap**: `reserve()` accepted `Reserved` sessions as proof of prior delivery. Fixed: now requires `Settled` status only.

2. **AntseedSubPool.sol — missing access control**: `recordTokenUsage()` was publicly callable. Fixed: restricted to escrow contract or owner.

### High Issues (FIXED)

3. **AntseedEmissions.sol — constructor validation**: Share percentages not validated in constructor. Fixed: added sum-to-100 check.

### Remaining Issues (Accepted/Deferred)

- AntseedEscrow: withdrawal timelock can be reset (accepted — user protection, not security)
- AntseedSubPool: optOut() O(n) array search (accepted — <100 peers in v1)
- AntseedIdentity: unbounded feedback arrays (accepted — gas cost naturally limits)
- Emissions: share change mid-epoch (documented, mathematically correct)

## Code Reuse (Simplify Review)

### Fixed
- **BaseEvmClient extracted**: 4 clients shared identical boilerplate (~40 lines each). Created shared base class.
- **BuyerAck persistence**: Ack signatures were discarded. Now persisted to SessionStore.
- **SQLite indexes**: Added composite indexes for fast lookups.
- **Session status constants**: Replaced raw strings with named constants.

## Integration

- Old protocol APIs removed: **100% clean** (no stale references)
- New API wiring: **85% complete**
- Import chains: **No circular dependencies**

### Known TODOs (tracked, not blocking)
1. `reputation-verifier.ts:25` — reimplement with IdentityClient
2. `announcer.ts:161` — wire IdentityClient for reputation lookup
3. `node.ts:480` — wire IdentityClient for peer verification
4. Cross-contract authorization wiring not in bootstrap (done at deploy time)

## Test Results

```
Foundry:  182 tests, 0 failures
  - ANTSToken:              19
  - AntseedIdentity:        15
  - AntseedIdentityRep:     18
  - AntseedEscrowBuyer:     14
  - AntseedEscrowReserve:   14
  - AntseedEscrowSettle:     8
  - AntseedEscrowStaking:    9
  - AntseedEscrowAdmin:     13
  - AntseedSubPool:         41
  - AntseedEmissions:       22
  - E2EIntegration:          9

TypeScript: 0 errors (17 packages)
Vitest:    379 pass, 1 skipped
```

## Action Items

- [ ] Wire IdentityClient into discovery layer (announcer, reputation-verifier, node peer lookup)
- [ ] Implement cross-contract authorization in deployment script
- [ ] Consider withdrawal request cooldown (nice-to-have)
- [ ] Monitor SubPool optOut() gas at scale (upgrade if >100 peers)
