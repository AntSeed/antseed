# M002 — Legacy seller claims

One broadcast, two signers, run only after M001 is `active`:

```bash
pnpm contracts:deploy -- M002 --network <base-sepolia|base-mainnet> --dry-run
pnpm contracts:deploy -- M002 --network <base-sepolia|base-mainnet> --broadcast \
  --signer deployer=<wallet> --signer sellerRewardsPoolOwner=<wallet>
```

The CLI reads live chain state and finishes whatever is missing. Rerunning is
safe: both steps check on-chain state first and an `active` pool is a no-op.

## Why

Legacy EmissionsV2 routed rewards of sellers without an unlock policy into
`AntseedSellerRewardsPool`. Claiming from that pool is blocked twice:

| Blocker | Revert | Fixed by |
| --- | --- | --- |
| `pool.sellerClaimPolicy == 0` | `NoSellerClaimPolicy` | pool owner installs `AntseedLegacySellerClaimPolicy` |
| pool not on `ANTSToken.transferWhitelist` while transfers are disabled | `TransfersNotEnabled` | token owner whitelists the pool |

M001 pins the pool to a registry facade so *locking* keeps working after the
flip, but leaves both blockers in place on purpose; this migration removes them.

## What gets deployed

`AntseedLegacySellerClaimPolicy(v2, lastEpoch, releaseBps, vestStart, vestEpochs, washTradingRegistry)`

- `v2` — the legacy EmissionsV2 that locked into the pool (read from
  `AntseedLegacyEmissionsEscrow.legacyEmissions()`); `v1` is derived from
  `v2.legacyEmissions()` because V2 merges V1 points for epochs ≤ its
  migration epoch.
- `lastEpoch = gate.effectiveEpoch() − 1` — the last epoch legacy V2 could ever
  lock. Immutable; that is why M002 must wait for M001 to activate.
- `releaseBps` — `RELEASE_BPS`, default 1538 (≈ 10/65 of the legacy seller
  share).
- `vestStart`, `vestEpochs` — `VEST_START_EPOCH` / `VEST_EPOCHS`, default 0
  (immediate).
- `washTradingRegistry` — `WASH_TRADING_REGISTRY`; the CLI defaults it to the
  registry M001 pinned into `AntseedPositionInit`. Proven wash traders
  (`isProvenWashTrader`) can claim nothing. The policy owner (pool owner) can
  also flag sellers manually (`setSellerFlagged`) or swap the source
  (`setWashTradingRegistry`).

The policy is a pure view from the pool's perspective. It reconstructs a
seller's cumulative locked amount from V2 claim flags and V2/V1 points, so
`cumulative − locked` is what the seller already withdrew; nothing is
double-counted across claims and nothing needs storage.

## Signers

| `--signer` role | Must be | Sends |
| --- | --- | --- |
| `deployer` | `ANTSToken.owner()` | `setTransferWhitelist(pool, true)` (skipped if transfers are enabled or already whitelisted) |
| `sellerRewardsPoolOwner` | `AntseedSellerRewardsPool.owner()` | policy deployment + `setSellerClaimPolicy` |

Both signers are always named; the token owner is only *verified* when the
whitelist call is actually needed. Dry runs simulate each role as its live
owner and need no wallet.

## States

| State | Meaning |
| --- | --- |
| `ready` | M001 active, pool found, at least one of {whitelist, policy} missing |
| `active` | pool can send ANTS and has the recorded claim policy |
| `not-applicable` | the legacy emissions contract has no rewards pool (V1-only testnets); nothing to do |
| `invalid` | M001 not active, escrow missing, effective epoch ≤ migration epoch, or the pool carries a claim policy this ledger did not install |

## Rehearsal

`--fork-test` on Base mainnet runs the full M001 rehearsal (deploy, advance
past the boundary, cutover) on a disposable Anvil fork and then applies M002
on top of the records M001 wrote, checking that a second apply is a no-op.

## After

- Sellers call `AntseedSellerRewardsPool.claim(recipient)`; `NothingToClaim`
  means either nothing is released yet or the seller is a proven wash trader.
- To change the release share or vesting later, deploy a new policy and
  `pool.setSellerClaimPolicy` it (pool owner). The policy's own state is only
  the wash-trading source and manual flags.
