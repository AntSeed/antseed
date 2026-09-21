# Generic payment recovery follow-up

This is PR 6/6, based on buyer integration (#1036). It extracts independent
payment recovery work from #1035 so the routing changes can be reviewed without
unrelated recovery, storage-regression, or type-cleanup changes.

## Scope

- Reconnect to retained seller channels by acknowledging a valid cumulative
  authorization without increasing the bill or resetting delivered usage.
- Validate disconnected and disk-restored channels on-chain before reactivation;
  reject closed, blocked, closing, or superseded channels. A disconnect during
  validation must not reactivate the channel.
- Preserve authorization for already-delivered work and zero-spend closure.
- Keep regressions for the released SQLite v5 records/signatures and development
  databases that already contain extra recovery columns. No migration is added.
- Reuse the existing captured billing-context type in the seller handler.

This is a behavior-preserving extraction of the original completed stack, not a
payment redesign. Routing-specific request accounting, acceptance, attribution,
pricing verification, and concurrency safeguards remain in #1035 because buyer
integration uses them. This follow-up does not change metadata or billing wire
versions, reserve policies, or package versions.

## Verification

The buyer/seller regression uses mocked chain calls by default:

```sh
pnpm --filter @antseed/node exec vitest run tests/payment-reconnect.test.ts
```

After building protocol, API adapter, buyer-core, and node, the same cases can be
run against freshly deployed local contracts:

```sh
pnpm --filter @antseed/e2e run flow:local-chain-payment-reconnect
```

The fixture requires Anvil, Forge, and the pinned `forge-std` dependency. It uses
temporary test wallets and a local image provider, and verifies delivery after
reconnect, final settlement, released reserves, and unchanged ghost counts. This
is not a real network-transport disconnect test.

## Known limitation

The earlier review reproduced a separate pending-authorization expiry bug: after
a signing or send failure, the pending work can outlive its five-minute billing
context and prevent cooperative close. This extraction does not fix that bug or
claim exactly-once billing across process restarts. That fix remains follow-up
work; it is not a reason to broaden the routing PRs.
