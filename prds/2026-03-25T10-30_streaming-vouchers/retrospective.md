# Retrospective: Streaming SpendingAuth Payment Model

**Date:** 2026-03-25T15:15Z
**PRD Directory:** prds/2026-03-25T10-30_streaming-vouchers/

## Summary

| Metric | Value |
|---|---|
| Total PRDs | 11 |
| Completed | 11 |
| Failed | 0 |
| Total tasks | 66 |
| Completed | 66 |
| Post-review fixes | 4 critical |
| Execution waves | 5 |
| Solidity tests | 88 pass |
| TypeScript tests | 408 pass |
| Full build | 0 errors |

## What Went Well

1. **Wave-based parallel execution worked.** 3 agents in Wave 1, 2 in Wave 2, 2 in Wave 3, etc. Each wave completed in 2-5 min. Total wall-clock ~25 min for 66 tasks.

2. **Impact audit caught cross-file dependencies early.** The upfront grep across the entire codebase identified all 28 files referencing `tokenRate`, 22 files for `previousConsumption`, etc. This prevented surprise compile errors in later waves.

3. **Independent PRDs (01, 04, 11) executing in parallel** was the right call. They touched completely separate files — no conflicts.

4. **Solidity test agent (PRD-09) wrote 11 working tests from scratch** including EIP-712 signature verification via vm.sign(). All passed on first run.

5. **The master plan conversation** (iterating on reserve vs settle vs close, gasless buyer, reputation model) prevented major rework during execution. Every question was resolved before PRD generation.

## What Didn't Work

1. **SessionsClient reserve() ABI mismatch.** PRD-03 agent wrote the ABI with 8 params (including cumulative fields) but the contract only has 6 params. The PRD spec was ambiguous — it said "update ABI to match new contract" but didn't explicitly list the reserve() ABI string. The agent guessed wrong.

2. **EIP-712 version not propagated.** PRD-01 bumped the contract to version "2", but PRD-03 didn't update `makeSessionsDomain()` to match. This is a cross-PRD dependency that wasn't explicitly tracked — the version string lives in TS (signatures.ts) but is set by the contract (PRD-01).

3. **Missing buyerSig persistence in SellerPaymentManager.** The PRD-05 spec mentioned "persist latest auth" but didn't specify that `buyerSig` must be stored separately for the settle() call. The agent stored cumulative amounts but passed empty string for the signature.

4. **PRD-10 agent hit API error and needed retry.** Lost ~2 min.

5. **One straggler file not in any PRD:** `apps/cli/src/cli/commands/reputation.ts` referenced old `ProvenReputation` fields. The impact audit found it but no PRD covered it. Had to fix manually.

6. **AntseedSubPool.sol and test files** also had stale `ProvenReputation` references not covered by PRDs. Fixed manually during Wave 1 verification.

## PRD Quality Issues

1. **PRD-03 Task 5 was too vague on ABI strings.** Should have included the exact ABI strings to use, not "update ABI to match new contract." The agent had to infer the ABI from the contract and got `reserve()` wrong.

2. **Cross-PRD data dependencies need explicit tracking.** The EIP-712 version is a data dependency between PRD-01 (sets it in contract) and PRD-03 (must match in TS). This wasn't listed as a dependency — only the "file" dependency was tracked.

3. **PRD-05 Task 7 (settleSession) should have been more specific** about what data to store. "Persist latest auth" is ambiguous — should have said "store buyerSig, cumulativeAmount, cumulativeInputTokens, cumulativeOutputTokens, nonce, deadline per session."

4. **No PRD covered the `reserveAmount` flow.** The master plan says the buyer signs cumulative amounts and the seller calls reserve() with the deposit size. These are two different values, but no PRD specified how the deposit size gets from the buyer to the seller. Had to add `reserveAmount` field to SpendingAuthPayload post-execution.

5. **Ancillary files (SubPool, reputation CLI command) were missed** by PRD generation despite the impact audit finding them. The PRD generator should have added cleanup tasks for every file the audit flagged.

## Patterns to Keep

1. **Wave-based execution with verification between waves.** Running `forge build` and `tsc --noEmit` between waves catches issues early before they cascade.

2. **One agent per PRD, not one per task.** For 5-9 task PRDs, having one agent execute all tasks sequentially within a PRD was more reliable than splitting. The agent maintains context across related tasks.

3. **Impact audit as mandatory PRD generation step.** The grep-based audit prevented most consumer misses. Should be even more aggressive — add a task to every PRD that touches a consumer the audit identified.

4. **Post-execution team-review** caught 3 critical bugs that individual agents missed. Always run it.

5. **Master plan conversation with multiple rounds** — spending 30+ minutes discussing before any PRD writing prevented architectural thrash during execution.

## Suggestions for Next Time

1. **PRDs should include exact ABI strings** for every client method change, not "update to match contract." Copy the exact string from the contract.

2. **Track "data dependencies" separately from "file dependencies."** A data dependency is: "PRD-03 must use EIP-712 version '2' because PRD-01 sets it." This is different from "PRD-03 depends on PRD-01" (file dependency).

3. **Every file flagged in the impact audit should appear in at least one PRD task.** If the audit finds 5 files referencing `tokenRate`, there should be 5 explicit tasks (or one task listing all 5 files).

4. **Add a "contract-client alignment" verification task** at the end of the contract PRD that checks the TS ABI matches the contract's actual function signatures. This would have caught the reserve() mismatch.

5. **Store the full SpendingAuth payload (including signature)** as a first-class concept in the session store, not as separate fields. This makes the settle() data available without maintaining a parallel map.

6. **Run `pnpm run build` (full workspace) after every wave**, not just `tsc --noEmit` on packages/node. The reputation CLI command error would have been caught in Wave 1.
