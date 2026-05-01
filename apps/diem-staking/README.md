# @antseed/diem-staking

Static web app for the DIEM staking portal at
[`diem.antseed.com`](https://diem.antseed.com).

Users stake Venice's DIEM token (on Base) into the `DiemStakingProxy` contract
and earn real USDC yield from AI inference demand on the AntSeed network, plus
$ANTS token emissions.

## Stack

- Vite + React 18 + TypeScript (strict)
- `wagmi` + `viem` for all chain I/O
- RainbowKit for wallet connection
- `@tanstack/react-query` for caching + polling

Uses the same WalletConnect project id and Base RPC fallback order as the
existing `apps/payments/web` portal — see `src/wagmi-config.ts`.

## Scripts

```bash
pnpm --filter=@antseed/diem-staking run dev        # vite dev server (:5180)
pnpm --filter=@antseed/diem-staking run typecheck  # strict tsc
pnpm --filter=@antseed/diem-staking run build      # typecheck + vite build → dist/
pnpm --filter=@antseed/diem-staking run preview    # serve built output
```

`dist/` and `node_modules/` are ignored by the repo-root `.gitignore`; this
app ships no per-app `.gitignore`, matching `apps/payments`.

## Configuration

The only required configuration is the deployed `DiemStakingProxy` address:

```bash
# .env.local (or environment at deploy time)
VITE_DIEM_STAKING_PROXY=0x…
```

If not set, every on-chain read short-circuits to `null`/`"—"` and write
actions are gated behind the connect-wallet CTA so the page still renders
cleanly pre-deploy.

## What's live vs. cached

Every display value is on-chain live except two:

| Source | What |
|---|---|
| **On-chain (wagmi `useReadContract` / `useReadContracts`, polled every ~12s)** | Pool TVL (`totalStaked`), distinct stakers (`stakerCount`), USDC distributed all-time (`totalUsdcDistributedEver`), pool cap (`maxTotalStake`), reward baseline (`firstRewardEpoch` / `syncedRewardEpoch` / `finalizedRewardEpoch`), Venice cooldown (`DIEM.cooldownDuration`), user wallet DIEM, user stake, user claimable USDC (`earnedUsdc`), user pending ANTS (`pendingAntsForEpoch` summed), per-epoch claim flags (`userEpochClaimed`), unstake queue state (`currentUnstakeBatch` / `oldestUnclaimedUnstakeBatch` / `unstakeBatches(id)` / `unstakeBatchUserAmount`). |
| **Off-chain** | DIEM price from CoinGecko (`useDiemPrice`). Falls back to "—" on miss; APY degrades to 0. APY uses all-time distributed USDC divided by pool age in days, annualized by 365, then divided by live pool TVL; TVL is current staked $DIEM valued at the live $DIEM price. Pool age is read from the first recent `Staked` log, with the Base mainnet `AntseedEmissions` genesis constant in `src/lib/epoch.ts` as a fallback; authoritative claimability still comes from `finalizedRewardEpoch()` on-chain. |

## Unstake UX

The proxy's unstake flow is three on-chain steps (`initiateUnstake` → `flush`
→ `claimUnstakeBatch`) but the UI presents one smart action button per user state:

- **Queued** — batch not yet flushed. Button: "Start cooldown" (calls
  `flush`). Disabled with an explanation when the prior batch is still
  unclaimed or when the minimum batch-open window has not elapsed.
- **Cooling down** — batch sent to Venice. No action; live countdown.
- **Claimable** — ready to withdraw. Button: "Withdraw N $DIEM" (calls
  `claimUnstakeBatch`, pays everyone in the batch).

This is honest — any user in the batch can advance each step, so users
often find theirs already moved. No keeper service required.

## ANTS reward epochs

The proxy no longer relies on an operator tick to decide reward boundaries.
Reward epochs are aligned to `AntseedEmissions.currentEpoch()`:

- `firstRewardEpoch` pins the emissions epoch at proxy deployment.
- `syncedRewardEpoch` is the next reward epoch that still needs a local
  `RewardEpochClosed` checkpoint.
- `finalizedRewardEpoch()` reads the emissions contract's current epoch; epochs
  below it are finalized and can be synced/claimed.
- `syncRewardEpochs(maxEpochs)` permissionlessly checkpoints finalized epochs in
  bounded chunks.
- `claimAnts(uint32[] rewardEpochs)` accepts explicit epoch ids, lazily syncs a
  bounded backlog, lazily funds each epoch's ANTS pot from `AntseedEmissions`,
  and marks zero-payout epochs processed so the user can advance to later
  epochs.

For ABI consumers migrating from the earlier proxy surface:

| Old | New |
|---|---|
| `currentEpoch` | `currentUnstakeBatch` |
| `oldestUnclaimed` | `oldestUnclaimedUnstakeBatch` |
| `epochs(id)` | `unstakeBatches(id)` |
| `epochUserAmount(id, user)` | `unstakeBatchUserAmount(id, user)` |
| `claimEpoch(id)` | `claimUnstakeBatch(id)` |
| `setMinEpochOpenSecs(secs)` | `setMinUnstakeBatchOpenSecs(secs)` |
| `operatorClaimEmissions(epoch)` | `syncRewardEpochs(maxEpochs)` + user `claimAnts(uint32[])` |

## Site metadata

`index.html` mirrors antseed.com's final rendered metadata (which Docusaurus
composes from its `title` + `tagline` + `metadata` config). Same shape as the
parent site:

- `<title>` and `og:title` follow the `{tagline} | {brand variant}` pattern.
  On antseed.com that's `The open market for AI inference. No gatekeepers. |
  AntSeed`; here the brand variant is extended to `AntSeed DIEM Staking`.
- `twitter:title` drops the brand suffix but keeps a short page identifier
  (`... | DIEM Staking`), matching Docusaurus's convention of shorter twitter
  titles while still giving unfurls page context.
- `description` / `og:description` prepend the same brand tagline, then
  suffix the DIEM-specific staking purpose.
- `canonical` is `https://diem.antseed.com/`.

Everything else — keywords, `og:type`, `og:image` / `twitter:image`,
`twitter:card`, favicon, fonts — is byte-for-byte what antseed.com emits.

Static assets copied from the website:

- **Favicon**: `public/logo.svg` — same AntSeed ant as antseed.com. Copied
  verbatim from `apps/website/static/logo.svg`; keep the two in sync.
- **Fonts**: same Google Fonts stylesheet (Space Grotesk + JetBrains Mono).
- **`og:image` / `twitter:image`**: `https://antseed.com/og-image.jpg` — the
  parent site's card. If a dedicated DIEM staking hero card is ever designed,
  drop it at `public/og-image.jpg` and update the two URLs here.
- **`robots.txt`**: copied from `apps/website/static/robots.txt` — same AI
  crawler allowlist, minus the parent-site sitemap directive.

### Not mirrored

The website also ships `google-site-verification` and a JSON-LD
`SoftwareApplication` schema. Neither is copied:

- `google-site-verification` is per-host; Search Console wants a separate
  token for the `diem.antseed.com` subdomain. Add one to `index.html` when
  the subdomain is verified.
- The `SoftwareApplication` JSON-LD describes the AntStation desktop app —
  wrong schema for a staking page. If structured data is wanted here, the
  right shape is `FinancialProduct` or `InvestmentFund`.

## Contract reference

Source of truth for all ABIs:
[`packages/contracts/DiemStakingProxy.sol`](../../packages/contracts/DiemStakingProxy.sol).
`src/lib/abi.ts` mirrors the subset this app calls — keep them in lockstep.
