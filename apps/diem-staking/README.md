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
| **On-chain (wagmi `useReadContract` / `useReadContracts`, polled every ~12s)** | Pool TVL (`totalStaked`), distinct stakers (`stakerCount`), USDC distributed all-time (`totalUsdcDistributedEver`), pool cap (`maxTotalStake`), Venice cooldown (`DIEM.cooldownDuration`), user wallet DIEM, user stake, user claimable USDC (`earnedUsdc`), user pending ANTS (`pendingAntsForEpoch` summed), unstake queue state (`currentEpoch` / `oldestUnclaimed` / `epochs(id)` / `epochUserAmount`). |
| **`getLogs` aggregation** | Last-epoch USDC (for realized APR). Sums `UsdcDistributed` events between the two most-recent `RewardEpochClosed` blocks, capped at a 500k block lookback. Caches for ~60s via tanstack-query. A deployment with a long event tail should replace this with a dedicated indexer. |
| **Off-chain** | DIEM price from CoinGecko (`useDiemPrice`). Falls back to "—" on miss; APR degrades to 0. |

## Unstake UX

The proxy's unstake flow is three on-chain steps (`initiateUnstake` → `flush`
→ `claimEpoch`) but the UI presents one smart action button per user state:

- **Queued** — cohort not yet flushed. Button: "Start cooldown" (calls
  `flush`). Disabled with an explanation when the prior cohort is still
  unclaimed.
- **Cooling down** — cohort sent to Venice. No action; live countdown.
- **Claimable** — ready to withdraw. Button: "Withdraw N $DIEM" (calls
  `claimEpoch`, pays everyone in the cohort).

This is honest — any user in the cohort can advance each step, so users
often find theirs already moved. No keeper service required.

## Site metadata

`index.html` mirrors the metadata block in `apps/website/docusaurus.config.ts`
so this subdomain reads as the same brand as antseed.com. Only DIEM-focused
fields differ: `<title>`, `description`, `og:title`, `og:description`,
`twitter:title`, `twitter:description`, and the canonical URL
(`https://diem.antseed.com/`).

Everything else is identical to the website:

- **Favicon**: `public/logo.svg` — same AntSeed ant as antseed.com. Copied
  verbatim from `apps/website/static/logo.svg`; keep the two in sync.
- **Fonts**: same Google Fonts stylesheet (Space Grotesk + JetBrains Mono).
- **Keywords**: same AI-marketplace / P2P-inference keyword list.
- **`og:image` / `twitter:image`**: `https://antseed.com/og-image.jpg` — the
  parent site's card. If a dedicated DIEM staking hero card is ever designed,
  drop it at `public/og-image.jpg` and update the two URLs here.
- **`robots.txt`**: copied from `apps/website/static/robots.txt` — same AI
  crawler allowlist + sitemap hint.

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
