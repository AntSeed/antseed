# Changelog

All notable user-facing changes to AntSeed packages are documented here.

This project uses selective package publishing. Each release entry lists the published packages affected by that release.

## Unreleased

### Added

- Sellers now run periodic model health self-checks (a 1-token probe per advertised service, every 5 minutes by default) and unadvertise services that keep failing, restoring them automatically when they recover. Configurable via `seller.healthCheck` (`enabled`, `intervalMs`, `failureThreshold`); sellers announcing this behavior advertise the `seller.model-health.v1` capability in discovery metadata. Exposed as `ModelHealthChecker` in `@antseed/node`, alongside `AntseedNode.refreshSellerMetadata()` for runtime service-list changes.
- The buyer proxy now treats `model_not_found` responses as routing failures (instead of successes) and refreshes peer discovery metadata in the background, so a stale cached model list recovers quickly after a seller unadvertises a model.

- Added buyer-initiated cooperative channel close (`CloseChannelRequest`/`CloseChannelResult`, message types 0x59/0x5A), so a buyer can get its reserved USDC released immediately instead of waiting out the on-chain `request-close` → 15-minute grace → `withdraw` flow. The seller closes on-chain and returns the transaction hash. It refuses while it is still mid-accumulation with that buyer — a billable request in flight (`busy`), or served work the buyer hasn't signed for yet (`pending_auth`, sent alongside a `NeedAuth` for the outstanding amount) — leaving the channel untouched so the buyer can retry or fall back to the timeout path.
- The buyer attaches its latest SpendingAuth by default; the seller closes at whichever cumulative is higher (its own or the buyer's), so a seller that lost the last authorization can still be paid in full, and a buyer cannot use this path to settle below what it owes.
- Added `antseed buyer channels close <channelId>` (with `--no-auth` and `--json`), which runs the request through a running `antseed buyer start` daemon's live seller connection via the new `/_antseed/channels/close` control-plane endpoint.
- Added `AntseedNode.requestChannelClose(peerId, opts)` to `@antseed/node`, plus the `payments.cooperative-close.v1` capability advertised in discovery metadata and the connection handshake.
- Added buyer peer health cooldowns, so a seller that stops responding is temporarily deprioritized by automatic routing instead of being selected again on every request. Cooldowns escalate from 30 seconds to a maximum of 8 minutes, are cleared by any response from the peer, and are advisory only — a pinned or explicitly named peer is always still dispatched to. Exposed over the buyer control plane as `GET /_antseed/peer-health` and `POST /_antseed/peer-health/clear`.
- Added automatic peer failover for Desktop chats using automatic routing: when the bound peer stops responding, the retry moves to the next-best healthy peer and the chat reports which peer it switched to. Chats pinned to a peer by hand always keep that peer.
- Added fault attribution to request failures (`AntseedRequestError`, `faultAttributionOf`) so buyer-side problems such as empty deposits, an unreachable chain RPC, or a closed local transport are reported as buyer faults with HTTP 503 instead of being reported as peer failures with HTTP 502.

### Changed

- Set generated model metadata for supported connected tools and CLI wrappers to a 280,000-token context window, with an 8,192-token output limit where the tool supports one.

### Fixed

- Fixed payment negotiation getting stuck when a buyer lost its local channel state while an older channel remained active on-chain. Sellers now close the superseded channel from durable seller state before accepting the buyer's replacement ReserveAuth.
- Fixed the seller recording an inaccurate settled amount when two close paths raced on the same channel. Only one `close()` is submitted, and every path that joins it now persists the amount that transaction actually settled.
- Fixed the seller persisting the initial ReserveAuth signature in the SpendingAuth column, so restart hydration restored it under the wrong EIP-712 type and every subsequent `close()` reverted with `InvalidSignature`.
- Fixed sellers retrying a failing signed `close()` forever: once the retry limit is exhausted the channel is now persisted as timed out, so `checkTimeouts()` and restarts fall back to the timeout path instead of replaying the same doomed close.
- Fixed seller crashes when sending `PaymentRequired` to a buyer that disconnected before the payment terms could be delivered.
- Fixed the buyer's Responses→Chat Completions request adapter to group parallel tool calls into a single assistant `tool_calls` message. Previously each call became its own assistant message, so strict chat-completions upstreams rejected multi-tool turns with `an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`.
- Fixed the Responses request normalizer to drop non-message input items with no renderable text (e.g. Codex `reasoning` items) instead of converting them into empty user messages mid-history.
- Fixed buyer payment negotiation so an unreachable chain RPC is reported immediately as a buyer-side `chain_rpc_unavailable` error. Previously the failed deposit-balance read was swallowed, negotiation continued without it, and the request stalled for the full 30-second lock-confirmation timeout before failing with an error that blamed the seller.
- Fixed `SellerAuthorizationError` so a peer that is not an authorized operator is distinguishable from a chain RPC that could not be reached; the two cases previously shared one error and could only be told apart by matching the message text.

## 2026-07-16 — Gasless deposit sweep live on Base mainnet

### Published

- `@antseed/api-adapter@0.1.41`
- `@antseed/cli@0.1.135`
- `@antseed/node@0.2.99`
- `@antseed/payments@0.1.30`
- `@antseed/provider-openai-responses@0.1.34`

### Desktop

- `@antseed/desktop`

### Added

- Deployed `AntseedDepositRelay` to Base mainnet at `0x34a44542e76f9b4cff3a31902eDF14AbF2C3B3DD` (fixed fee $0.05) and set `depositRelayAddress` in the `base-mainnet` chain-config preset, so up-to-date sellers start relaying deposit sweeps automatically and desktop QR deposits sweep into `AntseedDeposits` without the buyer wallet ever needing ETH.
- Added `AntseedDepositRelay`, an immutable periphery contract that gaslessly sweeps buyer hot-wallet USDC into `AntseedDeposits` via a single EIP-3009 `receiveWithAuthorization` — the swept amount minus a fixed, deploy-time fee (default $0.05) is credited to the buyer's deposits balance, and the fee pays whoever submitted the transaction. The buyer hot wallet never needs ETH.
- Added the P2P deposit-sweep protocol (`SweepRequest`/`SweepReceipt`, message types 0xA0/0xA1) with seller-side relaying enabled by default. Sellers verify, simulate, and profit-check each request before submitting; opt out with `relayer.enabled: false` or tune the floor with `relayer.minProfitBaseUnits` (may be negative for local testing).
- Added `antseed buyer sweep [--amount] [--timeout]`, which signs the sweep authorization offline and broadcasts it through a running `buyer start` daemon's existing seller connections (new `/_antseed/sweep` control-plane endpoints), falling back to an ephemeral node when no daemon is running. Pre-flight checks cover the fixed fee, the Deposits first-time minimum, and the credit limit (default sweeps clamp to the remaining headroom).
- Added `depositRelayAddress` to chain-config presets, EIP-3009 signing helpers (`buildReceiveAuthorization`, `makeUsdcDomain` with an on-chain `DOMAIN_SEPARATOR()` verification guard), and a `DepositRelayClient` to `@antseed/node`.
- Added a macOS menu bar icon for Desktop with quick actions to show or quit AntSeed.
- Added System Proxy commands to the CLI and a Desktop System Proxy view/tray controls for connecting supported local tools through AntSeed.
- Added Desktop runtime log source filters and buyer debug log filtering via `antseed buyer start --log-filter` / `ANTSEED_LOG_FILTER`.
- Added Desktop peer favicons from verified domains, showing fetched site icons in Discover and chat peer avatars when available.
- Added zero-price free usage authorization for advertised free services, including buyer-signed P2P usage records, seller on-chain reporting through `AntseedFreeUsage`, and CLI configuration for the deployed free usage contract address.
- Added a buyer-side metadata v2 service attribution opt-out for CLI and Desktop. Buyers can disable per-service attribution while preserving aggregate usage metadata in paid SpendingAuth and free-usage records.
- Added `antseed buyer emissions info` and `antseed buyer emissions claim` for buyer-side ANTS emissions.
- Added generic API request, response, and streaming adapters that transform between Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses through internal canonical models.

### Removed

- Removed the legacy subpool/subscription payment surface, including the `antseed buyer subscribe` command, subpool payment client/config exports, and the `AntseedSubPool` contract deployment path.

### Changed

- Changed API adapter streaming transforms to use canonical stream events with per-protocol normalizers and renderers, so new stream protocols can be added without pairwise routes.
- Changed Desktop renderer navigation to load only the active view, preload likely next views, and show a lightweight loading state while lazily loaded pages resolve.
- Reduced the default buyer response-auth evidence sample rate from 20% to 0.5% to limit local `verification_samples` growth during high-request sessions.
- Increased the default free-usage on-chain record flush interval from 10 seconds to 5 minutes to reduce background transaction frequency while preserving batch, disconnect, and shutdown flushes.
- Increased default seller concurrency from 5 to 50 concurrent requests, including the OpenAI Responses provider default, for bursty clients.

### Fixed

- Fixed the DIEM staking site so wallet transactions explicitly switch to and execute on Base mainnet instead of following a wallet that remains on Ethereum mainnet.
- Fixed Desktop auto-update failures so download and install errors appear in the title bar with copyable details, and fixed macOS Quit so the first menu action exits after cleanup instead of requiring a second click.
- Fixed buyer response-auth timeout warnings for non-inference probes and sellers that do not advertise response-auth support.
- Fixed buyer discovery so temporarily unreachable metadata endpoints are probed for recovery before the full exponential cooldown expires, allowing recovered peers to reappear in buyer peer lists sooner.
- Fixed Desktop chats for peers that disappear from discovery so the header reports that the peer was not found and disables the composer instead of showing stale peer identifiers.
- Fixed Desktop Discover overflow tag tooltips so the `+N` category indicator works on service cards in the first row.
- Fixed `antseed seller emissions claim` so it only checks and claims seller rewards, leaving buyer rewards to the buyer command.
- Fixed buyer proxy protocol transforms so requests routed to OpenAI Responses always set upstream `stream: true` without forcing non-stream clients to receive SSE.
- Fixed API adapter cache-token accounting so Anthropic cache reads and OpenAI cached token details stay separate from fresh input tokens across response and streaming transforms.
- Fixed API adapter request transforms to propagate a per-session `prompt_cache_key` (derived from Anthropic `metadata.user_id`) to OpenAI Responses upstreams, improving prompt cache hit rates for cross-protocol buyers.
- Fixed buyer reserve replay after channel top-ups so reconnecting buyers resend the original first-reserve amount instead of an expanded top-up ceiling that can exceed the on-chain first-sign cap.
- Fixed seller payment handling so temporary delegated-account transaction queue backpressure defers top-ups and retries closes instead of permanently rejecting active buyer sessions.

## 2026-06-15 — Buyer peer failure accounting and desktop stream responsiveness

### Published

- `@antseed/cli@0.1.130`

### Desktop

- `@antseed/desktop`

### Fixed

- Fixed buyer proxy failure accounting so transient request failures, local buyer payment errors, and `/v1/models` service probes do not make pinned peers unreachable by deleting cached discovery metadata.
- Fixed Desktop chat sessions becoming sluggish or appearing stuck during long streamed responses by batching streaming UI updates per animation frame while preserving in-progress chat switching behavior.

## 2026-06-15 — Seller verification links and response-auth sampling

### Published

- `@antseed/node@0.2.93`
- `@antseed/cli@0.1.129`

### Desktop

- `@antseed/desktop@0.1.105`

### Added

- Added seller external verification claims in signed peer metadata. Sellers can now advertise domain ownership claims and GitHub account/repository claims.
- Added buyer-side external claim verification for seller metadata. Buyers verify domain claims through `_antseed.<domain>` DNS TXT records or `https://<domain>/.well-known/antseed.json`, and verify GitHub claims through a public `antseed.json` proof file on `raw.githubusercontent.com`.
- Added verified seller links to `antseed network browse`, including domain and GitHub indicators for claims that the buyer has independently verified.
- Added verified domain and GitHub badges to Desktop Discover seller cards, with the verified links included in discover search/filter data.
- Added shared verification-link formatting in `@antseed/node` so CLI and Desktop render the same verified external claims safely.
- Added buyer response-auth evidence sampling configuration via `buyer.verification.sampleRate` and `buyer.verification.maxSampleBytes`, allowing deployments to tune how often verified request/response samples are retained and how large a sample may be.

## 2026-05-18 — Seller setup, payment recovery, and peer refresh

### Published

- `@antseed/node@0.2.86`
- `@antseed/network-stats@0.1.9`
- `@antseed/payments@0.1.20`
- `@antseed/cli@0.1.121`

### Added

- Added a buyer peer-refresh configuration option so buyer runtimes can periodically refresh candidate peers instead of relying only on the startup snapshot.
- Added CLI support for overriding the seller Base RPC endpoint from configuration and seller startup flags.
- Added default seller setup values for chain/RPC, pricing, limits, and identity fields so `antseed seller setup` produces usable configs with fewer manual edits.

### Fixed

- Fixed seller payment recovery for zombie channels by allowing sellers to close requested/expired channels even when the latest auth was only stored locally.
- Preserved stored buyer authorization when a seller timeout path needs to settle or close a channel later.
- Fixed pending top-up race conditions that could prematurely close active payment channels under expensive or concurrent requests.
- Updated network stats to surface contract-backed seller pricing/volume data for peers that publish on-chain metadata.
- Clarified buyer data-directory isolation in CLI docs to prevent buyer profiles from sharing state accidentally.

## 2026-05-13 — Metrics, reputation, and portal stats

### Published

- `@antseed/node@0.2.85`
- `@antseed/payments@0.1.19`
- `@antseed/cli@0.1.120`

### Added

- Added sybil-aware on-chain trust scoring and exposed the resulting risk signals through peer metadata, CLI network browsing, buyer proxy discovery, and Desktop Discover.
- Added CLI metrics/exporter commands and documentation for Prometheus-style AntSeed runtime metrics.
- Added automatic trusted-plugin refresh when bundled core dependency pins drift from the installed CLI.

### Fixed

- Fixed contract-backed seller statistics in pricing and portal views, including legacy emissions compatibility for existing on-chain records.
- Improved provider HTTP relay handling for streamed usage metadata and cross-protocol no-op request normalization.
- Updated payment portal modal, drawer, and loading states so deposits, crediting, and DIEM rewards remain usable on smaller screens.

## 2026-05-10 — Desktop bundled runtime version resolution fix

### Desktop

- `@antseed/desktop@0.1.79`

### Fixed

- Fixed Desktop bundled router runtime to resolve each transitive dependency from its parent package's perspective and nest version-conflicting copies under the parent. The previous flat-copy bundler picked the workspace-hoisted top-level version and silently dropped parent-specific nested copies — causing the buyer to fail at startup with `Named export 'execa' not found ... CommonJS module` because `default-gateway@7.2.2` was paired with the wrong `execa` version.

## 2026-05-10 — Desktop router clean reinstall

### Desktop

- `@antseed/desktop@0.1.78`

### Fixed

- Fixed Desktop router recovery so stale or incomplete bundled router installs are deleted and recreated from the app bundle instead of being incrementally repaired.
- Prevented the Desktop-started buyer runtime from retrying npm plugin repair after a successful bundled reinstall, keeping recovery offline on locked-down corporate networks.

## 2026-05-10 — Anthropic streaming token accounting fix

### Published

- `@antseed/api-adapter@0.1.39`
- `@antseed/node@0.2.84`
- `@antseed/payments@0.1.18`
- `@antseed/cli@0.1.119`

### Desktop

- `@antseed/desktop@0.1.77`

### Fixed

- Fixed Anthropic Messages streaming token accounting so the `message_start` event's `message.usage` payload is unwrapped alongside `parsed.usage` and `parsed.response.usage`. Previously, cached input tokens (`cache_read_input_tokens`) and the full input count vanished from streamed Anthropic responses, leaving only the small fresh tail from `message_delta` — producing on-chain `MetadataRecorded` events with absurdly low `inputTokens` and under-billing sellers for cached traffic. Both buyer and seller installs need this update for correct on-chain stats, accurate seller billing, and matching cost-tolerance validation between peers.
- Fixed Desktop bundling so the prepared resource tree no longer collides when multiple plugins share transitive runtime dependencies.

## 2026-05-10 — Buyer router install repair

### Published

- `@antseed/cli@0.1.118`

### Desktop

- `@antseed/desktop@0.1.76`

### Fixed

- Fixed `antseed buyer start` so trusted router plugins are repaired automatically when the plugin package is present but incomplete, including missing nested dependencies such as `ethers` under bundled Desktop installs.
- Fixed Desktop plugin setup so bundled router repairs copy the full transitive runtime dependency tree of `@antseed/node` (`ethers`, `@silentbot1/nat-api`, `tokenx`, ...) and work fully offline without Node or npm on the user machine.
- Fixed Desktop bundling so the dependency tree of `@antseed/node` is materialized as real files under `Resources/bundled-plugins/`, avoiding `ENOTDIR` failures when copying out of `app.asar`.
- Fixed the Desktop setup screen so a transient router-plugin install failure no longer blocks the app after the buyer runtime and service catalog are available.
- Added a manual install hint to missing third-party plugin errors.

## 2026-05-09 — Reputation, pricing, and cached-token fixes

### Published

- `@antseed/api-adapter@0.1.38`
- `@antseed/node@0.2.83`
- `@antseed/router-core@0.1.44`
- `@antseed/router-local@0.1.43`
- `@antseed/payments@0.1.17`
- `@antseed/cli@0.1.116`

### Added

- Added multi-factor on-chain peer reputation scores based on settled volume, completed channels, average channel value, recency, stake age, and ghost penalties.
- Surfaced reputation scores in `antseed network browse` and Desktop Discover, with reputation-first ranking and low-reputation warnings.
- Added settled USDC volume to Desktop Discover peer cards.

### Fixed

- Enforced buyer pricing policy across router, CLI, and Desktop Discover paths, including invalid cached-input pricing.
- Fixed pinned peer routing so manual peer selection respects the full buyer policy, including explicit minimum reputation.
- Fixed Anthropic cached-input token accounting so usage metadata records total logical input tokens while preserving fresh/cached cost splits.
- Fixed compact token formatting so `1000M` rolls up to `1B`.

## 2026-05-07 — Payment channel catch-up fixes

### Published

- `@antseed/node@0.2.81`
- `@antseed/payments@0.1.15`
- `@antseed/cli@0.1.114`

### Fixed

- Fixed repeated payment catch-up loops when delivered seller spend exactly matched the last accepted buyer `SpendingAuth`.
- Prevented sellers from requesting `SpendingAuth` above delivered spend during catch-up.
- Stopped sellers from serving additional paid requests once an exactly settled channel has reached its reserve ceiling.

## 2026-05-07 — Payment accounting and seller close fixes

### Published

- `@antseed/node@0.2.80`
- `@antseed/payments@0.1.14`
- `@antseed/cli@0.1.113`

### Fixed

- Fixed seller-side `NeedAuth` accounting so post-response authorization requests only the cumulative delivered spend instead of double-counting the latest request.
- Fixed stale buyer `NeedAuth` handling so service-specific pricing context is preserved for the real authorization request.
- Prevented duplicate in-flight seller channel close attempts under concurrent cleanup paths.
