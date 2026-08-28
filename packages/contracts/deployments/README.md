# Contract deployment records

This directory is the canonical ledger of official AntSeed contract deployments.

Each network contains:

- `current.json`: the complete active contract set used by applications.
- `history/`: append-only records for executed deployments and cutovers.

## Rules

1. Never edit an executed history record. Correct mistakes with a new record.
2. Every production broadcast must produce a history record containing its transaction hashes, deployment blocks, source commit, constructor arguments, owners, and runtime code hashes.
3. Update `current.json` only after the new state is active and post-deployment checks pass.
4. Represent unknown historical values as `null`; never infer or invent provenance.
5. Migration scripts must assert their expected starting state before broadcasting.
6. Validate records with `node scripts/validate-contract-deployments.mjs`.
7. Mark contracts created by that record with `deployedInRelease: true`; only reconstructed legacy provenance may remain `null`.
8. Release-specific guarantees live in a per-migration schema (for example `schema.m001.json`), not in the shared schema or the validator.
9. Multi-phase migrations must finish from the same clean Git commit that produced their first on-chain phase.
10. Deployment records are created atomically and may never be overwritten, including by a resumed run.
11. Non-fork deployment phases require `BASESCAN_API_KEY` and submit source verification during broadcast.

`packages/node/src/payments/generated-contract-addresses.ts` is generated from
each network's `current.json`. A successful canonical migration regenerates it
automatically; `pnpm contracts:check` reports any stale generated output.

`M001RecognizedUsage` has two records because deployment and activation happen in separate epochs:

- `001-recognized-usage-deployed.json`
- `001-recognized-usage-activated.json`

`pnpm contracts:deploy -- M001 --network <network> --broadcast` creates these
records from Foundry receipts and validates them automatically.

M001 permits Base Sepolia and Base mainnet dry runs and broadcasts. Treat the
pinned Base-mainnet `--fork-test` as a required rehearsal before generating and
reviewing the production dry-run plan.

Use `--dry-run` to simulate only the next safe phase. Before the M001 boundary,
the cutover simulation forks the selected live RPC at its latest block, advances
only that disposable fork beyond the boundary, and executes the unchanged
Solidity script there. Use `--fork-test` with `BASE_MAINNET_RPC_URL` to run the
full deployment, advance Anvil across the boundary, perform cutover, validate
records, and verify that a repeated apply is a no-op.

## Reviewing a rollout

`--dry-run` writes two artifacts under `<network>/pending/` instead of only
printing to the terminal:

- `<release>.plan.json` — every transaction the phase intends to send, with
  decoded function signatures, arguments, and calldata, plus the protocol
  pointer changes it will make.
- `<release>.VALIDATION.md` — the human-reviewable rendering of that plan, with
  a reviewer checklist.

Commit both and make them the thing a reviewer approves; prose in a PR
description is not a substitute for the decoded transaction list. A successful
broadcast deletes the pending artifacts for that release, because the history
record then becomes the authority — `pending/` always means "reviewed but not
yet executed".

## Bytecode provenance

`pnpm contracts:check` rebuilds the contracts locally and compares the result
against every `runtimeCodeHash` recorded in the ledger, and against the code
actually deployed on chain when an RPC URL is available. This
depends on `bytecode_hash = "none"` and `cbor_metadata = false` in
`packages/contracts/foundry.toml`: the Solidity default embeds a metadata digest
derived from absolute source paths, so identical source would otherwise produce
different runtime code on different machines.

## Validation

`scripts/validate-contract-deployments.mjs` checks every record in two layers:

1. `schema.json` — the shared shape, enforced with Ajv in strict mode. It is the
   single source of truth for record structure; there is no parallel hand-written
   check to drift from it.
2. `schema.<migration>.json` — invariants that apply only to the releases one
   migration owns. `schema.m001.json` proves the verification bucket remains
   editable at 10%, that no points policy is active, and that both
   administrative contracts have recorded owners.

The validator resolves the second layer through the migration registry, so a new
migration adds its rules by declaring `recordSchema` and never by editing shared
validation code.

## Commands

- `pnpm contracts:deploy -- ...` runs one migration phase.
- `pnpm contracts:snapshot` deliberately regenerates gas snapshots.
- `pnpm contracts:check -- <base-commit>` runs Forge and deployment-runner
  tests, validates records and generated config, verifies bytecode, and checks
  append-only history. Omit the base commit only when the history comparison is
  not applicable.

## Adding a migration

Migration modules live in `scripts/deployments/mNNN.mjs` and are discovered
automatically. A module declares *what* the rollout is and lets
`scripts/deployments/runtime/` handle *how* it executes — dotenv loading, the
per-network broadcast lock, live-state observation, typed confirmation,
clean-tree enforcement, Foundry receipt parsing, record writing, and artifact
validation are all shared.

```js
export const migration = {
  id: 'M002',
  networks: ['base-sepolia'],
  releases: ['002-example'],          // releases this migration may write
  phases: [                           // first phase whose guard passes is run
    { id: 'deploy', guard: (observation) => observation.state === 'ready', run },
  ],
  expectedState,                      // pointers read from current.json
  observe,                            // live RPC reads -> { state, ... }
  recordSchema,                       // release-specific invariants
  run: (options, overrides) => runMigration(migration, options, overrides),
};
```

The registry rejects a migration that declares no phases, a phase without an
`id`/`guard`/`run`, no releases, or a release another migration already claims.

The runner takes a per-network migration lock during broadcasts. If a process
exits unexpectedly, verify that no deployment is still active before removing
the lock path printed by the command.
