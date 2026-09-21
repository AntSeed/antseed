# Standalone ANTS dashboard

The standalone build is a static website. It does not start Fastify, load a buyer
identity, or connect to a local AntSeed process. The desktop and CLI still open
the existing local dashboard; their launch URLs and authorization flow are unchanged.

- **Local dashboard:** opened from the desktop app or CLI and connected to its local server.
- **Standalone dashboard:** opened directly in a browser without AntSeed installed or running. Initial buyer-wallet authorization still requires the AntSeed app holding the buyer identity; afterward, eligible claims work independently.

Existing internal names such as `hosted`, `build:hosted`, and `dist/ants-hosted`
remain unchanged. They refer to the standalone mode described here.

## Build and preview

Use Node.js 24 and the workspace's pinned pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter=@antseed/protocol run build
pnpm --filter=@antseed/buyer-core run build
pnpm --filter=@antseed/ui run build
pnpm --filter=@antseed/node run build
pnpm --filter=@antseed/ants run typecheck
pnpm --filter=@antseed/ants run build:hosted
pnpm --filter=@antseed/ants run preview:hosted
```

Deploy `apps/ants/dist/ants-hosted` to a static HTTPS host. No server process,
API rewrite, secret key, or database is required. Hash routing supports static
hosts without SPA rewrites. `build:web` continues producing `dist/ants-web` for
the local server, independently of `build:hosted`.

## Public build configuration

Production is pinned to Base mainnet and the SDK's repository-maintained contract
addresses. These optional Vite environment variables are public, compiled into
the browser bundle, and must never contain secret credentials:

| Variable | Default / purpose |
| --- | --- |
| `VITE_ANTS_RPC_URL` | SDK primary Base RPC; use an HTTPS, CORS-enabled endpoint. |
| `VITE_ANTS_RPC_FALLBACKS` | SDK fallback list; comma-separated endpoints. Empty disables fallbacks. |
| `VITE_ANTS_EXPLORER_URL` | SDK Antscan URL; empty disables indexed history. |
| `VITE_ANTS_WALLETCONNECT_PROJECT_ID` | Existing AntSeed project ID; set your deployment's project ID and allow its production origin. |

URL parameters never override RPC endpoints, contract addresses, network, or
transaction recipients. Production configuration rejects insecure/localhost
endpoints. A dedicated public RPC endpoint with origin restrictions and quotas
is recommended for sustained traffic. The build rejects Node/native modules in
the standalone dependency graph.

## Antscan position and reward feeds

Both dashboard modes use the API contracts from Antscan PRs #8 and #9:

- `GET /api/staking/positions?owner=…&include=live&includeClosed=1` provides
  position status, current/next power, withdrawal epoch, pending max-lock
  changes, per-pool summaries and whole-wallet totals. Stale or incomplete live
  data falls back to the existing reads with an explicit warning.
- A separate `include=rewards&includeClosed=1&limit=100` request reads indexed
  staking rewards without request-time indexer RPC. Rewards discovery adds
  `rewardStatus=outstanding`, retaining closed positions with unclaimed rewards.
  Every cursor page is read; a snapshot-conflict response restarts once.
- Rewards require schema version 1, matching chain/contracts/epoch, complete
  inventory/history, and a fresh checkpoint. Missing, stale or unsupported
  reward snapshots show **unavailable**, never zero or an unbounded historical
  RPC scan. Other reward buckets remain independent.
- Successful transactions persist a per-wallet checkpoint. Older snapshots
  cannot overwrite the post-transaction display, including after reload and
  transaction recovery. Staking rewards may be unavailable until the next
  indexer checkpoint catches up; retrying does not rebroadcast transactions.
- Claims, restaking, ownership, operator authorization and withdrawal previews
  still use live contract checks. Buyer, seller and legacy rewards are not
  covered by the indexed staking-reward feed and retain their existing reads.

The configured Antscan deployment must include PR #8's reward snapshot worker
and complete its history backfill, as well as PR #9's live fields. A dashboard
deployment does not deploy Antscan. PR #8 remained open when this integration
was verified on September 21, 2026; PR #9 was merged. Verify the configured
endpoint before rollout rather than assuming merged code is deployed.
At that check, `https://antscan.co` still returned the older response without
reward checkpoint metadata for `include=rewards`; indexed staking rewards
therefore remain unavailable against that deployment until it is upgraded.

## Accounts and rewards

- Anyone can browse pools and network information without connecting a wallet.
- Connect a browser wallet to use its selected account. No additional sign-in
  signature is requested. Staking and seller rewards use that account.
- In the sidebar wallet menu (top strip on mobile), add a nonzero buyer address copied from the
  existing AntSeed app. Give it an optional local label. Select, rename, remove,
  or clear the selection without changing the signing wallet.
- Buyer addresses and labels are remembered in this browser, scoped by wallet
  and chain. This list is not automatic discovery or proof of ownership.
- Live `Deposits.getOperator(buyer)` checks determine authorization. Different
  operators are view-only; an absent operator requires initial authorization in
  the app holding the buyer identity. Private keys are never imported here.
- Once linked on-chain, buyer claims and restaking work with the original app
  closed. Clearing a saved buyer does not revoke its operator on-chain.
- Blocked storage falls back to in-memory buyer preferences with a warning.
  Writes require working persistent activity storage and Web Locks support.

## Transaction recovery

The existing contract services and browser-signing checks are shared with local
mode. Every standalone action is bound to the original chain, wallet, and buyer.
Same-origin tabs take an exclusive wallet/chain Web Lock. A second tab cannot
start signing while that lock is held; other sites or devices are outside this
lock's scope.

The browser records transaction intent before prompting and records the hash
immediately after broadcast. Account changes invalidate future signing steps,
but submitted transactions stay attached to their original wallet. Receipt
verification checks sender, destination, network, calldata, value, and nonce.

After reload, open **Account → Transaction recovery**. Known hashes are checked
without rebroadcasting. For an approval without a recorded hash, inspect the
original wallet, paste its transaction hash if submitted, or explicitly confirm
that nothing was submitted. Interrupted multi-step actions do not resume
automatically; inspect confirmed steps before initiating another action.

Browser storage contains public addresses, transaction intents/hashes, local
labels, and activity. Clearing site data loses local recovery history; inspect
the wallet/explorer before retrying any interrupted action. No signing keys,
private buyer identity, or server-session token is stored by the standalone runtime.

## Hosting and rollout checks

- Serve over HTTPS; enable `X-Content-Type-Options: nosniff`, a restrictive
  `Referrer-Policy`, and CSP `frame-ancestors 'none'; object-src 'none'; base-uri
  'self'`. Allow self-hosted scripts, the existing Google Fonts styles/fonts,
  wallet UI images, and the HTTPS/WSS origins needed by configured RPC,
  Antscan, and supported wallet connectors. Test the full CSP with every wallet
  connector you enable before enforcing it.
- Cache hashed assets immutably and revalidate `index.html` on deployment.
- Verify CORS from the actual hosting origin for RPC, all `/api/staking/*`,
  display-snapshot GraphQL, seller catalog/model usage, and network endpoints
  used by Antscan. GraphQL POSTs require working OPTIONS/preflight handling.
- Keep missing/stale indexer warnings visible. Displayed staking rewards are
  checkpointed estimates; exact transaction validation remains live. Unavailable
  history is not replaced with unbounded historical RPC scans.
- Run tests, typecheck, both builds, and the static-browser smoke test before
  rollout. Observe failed RPC/indexer requests, wallet rejections, and receipt
  timeouts using browser diagnostics; this build adds no private account telemetry.
- Roll back by deploying the prior static artifact. Existing local installations
  are unaffected. Domain provisioning and production deployment are separate.

## Testing

```sh
pnpm --filter=@antseed/ants test
pnpm --filter=@antseed/ants run typecheck
pnpm --filter=@antseed/ants run build
pnpm --filter=@antseed/ants run build:hosted
node scripts/ants-hosted-smoke.mjs
```

The smoke test requires Playwright/Chromium already installed. It serves only
the built static files and checks disconnected navigation, a test wallet's
account selector, saved-buyer persistence, and absence of local API requests.
It never signs or broadcasts a production transaction.

For an existing disposable `ants-sandbox.mjs --restricted --browser` fixture,
pass `--root=/absolute/path/to/hosted-test-output` and
`--scenario=/absolute/path/to/scenario.json` to the smoke script. It validates
the loopback RPC's chain ID before enabling an injected Anvil-only signer and
claims buyer rewards using the browser runtime. It never calls the local
dashboard API, even when that sandbox also happens to serve one.
Use `--restake` instead to exercise buyer reward staking on a fixture with
unclaimed buyer rewards. The test uses a synthetic Anvil wallet, not a real
wallet-extension popup.

For disposable Anvil tests only, use `vite build --mode hosted-test`,
`VITE_ANTS_CHAIN=base-local`, and `VITE_ANTS_TEST_CONFIG` containing the test
chain configuration JSON. Set `VITE_ANTS_RPC_URL` to that fork and disable
fallbacks/indexing. Never deploy a `hosted-test` artifact; test overrides are
ignored by the normal standalone production build.
