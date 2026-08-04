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

- The desktop release workflow now builds and publishes Linux installers (AppImage + deb, x64 + arm64, each arch on a native runner) alongside macOS and Windows, mirrors them to the rolling alpha release, and the website download CTAs now offer Linux visitors a direct AppImage download for their CPU arch instead of only linking to the releases page.

### Fixed

- Fixed bursty buyer startups causing initial payment-channel reserves to fail when delegated seller accounts reject excess in-flight transactions. Sellers now retry transient transaction backpressure before acknowledging the channel.
- Fixed seller health checks leaving unavailable upstreams advertised: HTTP 402 responses now count as failures, every failing service can be removed, and a provider with no healthy services is omitted from signed discovery metadata until a probe succeeds.
- Fixed OpenAI Responses model health probes using a scalar `input` value that strict providers rejected with HTTP 400, leaving every health result inconclusive and preventing automatic model unadvertising.
- Fixed payment negotiation getting stuck when a buyer lost its local channel state while an older channel remained active on-chain. Sellers now close the superseded channel from durable seller state before accepting the buyer's replacement ReserveAuth.
- Fixed the seller recording an inaccurate settled amount when two close paths raced on the same channel. Only one `close()` is submitted, and every path that joins it now persists the amount that transaction actually settled.
- Fixed the seller persisting the initial ReserveAuth signature in the SpendingAuth column, so restart hydration restored it under the wrong EIP-712 type and every subsequent `close()` reverted with `InvalidSignature`.
- Fixed sellers retrying a failing signed `close()` forever: once the retry limit is exhausted the channel is now persisted as timed out, so `checkTimeouts()` and restarts fall back to the timeout path instead of replaying the same doomed close.
- Fixed seller crashes when sending `PaymentRequired` to a buyer that disconnected before the payment terms could be delivered.
- Fixed the buyer's Responses→Chat Completions request adapter to group parallel tool calls into a single assistant `tool_calls` message. Previously each call became its own assistant message, so strict chat-completions upstreams rejected multi-tool turns with `an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`.
- Fixed the Responses request normalizer to drop non-message input items with no renderable text (e.g. Codex `reasoning` items) instead of converting them into empty user messages mid-history.

## 2026-08-03 — Desktop beta

### Desktop

- `@antseed/desktop@0.2.0`

### Changed

- AntSeed VPR graduates from alpha to beta and becomes the recommended desktop build, replacing AntStation 0.1.114 as the latest release. Existing AntStation installs auto-update to it; alpha-channel installs graduate to it.
- Highlights since 0.1.114: in-app deposit flow (QR → hot wallet → sponsored sweep, with live status), per-chat model routing with conversation pins and float-pill chat/model dropdowns, Telegram bridge over the local agent, network reachability diagnostics surfaced as a banner, opt-in update downloads with staged macOS installs, and large idle CPU reductions in the main process and compositor.
- The Fun checkout CTA and the Stripe payment option are hidden for the beta; the deposit chooser lists the USDC options directly.

## 2026-08-01 — Desktop alpha: quiet update-check errors

### Desktop

- `@antseed/desktop@0.1.115-alpha.29` (prerelease)

### Fixed

- Transient network errors no longer raise a red "Update failed" banner. Background update checks that fail (e.g. `net::ERR_NETWORK_CHANGED` when a VPN toggles or WiFi switches mid-check) are logged and silently retried on the next periodic check, and an interrupted update download quietly retries up to five times — the retry budget resets whenever bytes flow again, so long downloads survive flaky networks. Real failures (retries exhausted, non-network errors, or errors while installing) still surface as before.

## 2026-08-01 — Desktop alpha: opt-in update downloads

### Desktop

- `@antseed/desktop@0.1.115-alpha.28` (prerelease)

### Changed

- Update downloads are now opt-in: detecting a new version shows an "Update available" banner with a Download button instead of fetching hundreds of megabytes automatically. Download progress, background verification, and the "Restart & update" step follow only after clicking. Dismissing the banner hides it for the current session; it returns the next time the app opens until the update is taken.
- The Home usage card shows the measured savings amount without the percentage suffix.
- The bundled runtime picks up the latest payment and protocol work from main, including buyer-requested cooperative channel close, seller channel-recovery fixes, and the parallel-tool-call adapter fix (see Unreleased for the package-level details).

## 2026-07-31 — Desktop alpha: deposit chooser polish, faster update handoff

### Desktop

- `@antseed/desktop@0.1.115-alpha.27` (prerelease)

### Changed

- Deposit chooser polish: single-line option rows with tighter padding — USDC on Base, USDC from any chain (Meridian behind the scenes, with ETH/Arbitrum/BNB/Polygon chain badges), and Stripe with its official mark. The main CTA now reads just "Deposit", and the verbose trust card is replaced by a compact strip: payment/crypto icon row, the encrypted/non-custodial line, and a pay-per-request line.
- Faster, clearer macOS updates: the "Update available" button now appears only after the update is fully staged and signature-verified in the background, so clicking "Restart & update" goes straight to the final bundle swap instead of silently stalling for tens of seconds. The update watchdog also steps in after ~2–6 seconds instead of a fixed wait, and a system notification ("Installing the update — the app will reopen shortly") covers the brief gap while the app is closed.

## 2026-07-31 — Desktop alpha: deposit chooser, model browsing, wallet pages in browser

### Desktop

- `@antseed/desktop@0.1.115-alpha.26` (prerelease)

### Added

- Redesigned the deposit page around a Fun-branded primary option, with everything else behind a "More options" expander: USDC on Base (QR flow), Meridian (crypto, cross-chain), and AntSeed Pay (Stripe card checkout), each with official brand marks, payment-network badges, and a non-custodial trust line.
- Browsing models from Explore no longer changes the active route — the model page's new "Use" button is what applies it, and a "Start chat" link always opens a fresh conversation on the chosen model. The applied model's page shows a checkmark, and category tags self-fit into a single line with a +N chip.

### Changed

- Wallet pay pages (deposit, withdraw, authorize, claims, channel close) and the card-purchase page now open in a regular browser tab in the default browser instead of a chromeless app-mode window.

## 2026-07-30 — Desktop alpha: reliable macOS update installs

### Desktop

- `@antseed/desktop@0.1.115-alpha.25` (prerelease)

### Fixed

- macOS updates now install reliably even when launchd declines to auto-start Squirrel's ShipIt helper (seen on machines where Background Task Management doesn't recognize the renamed app, leaving the update staged but never installed). Before quitting for an update, the app spawns a detached watchdog that waits for the app to exit and starts the installer itself if launchd didn't — kickstarting the registered job or running the helper directly. The `alpha.23` approach of clearing the previous ShipIt registration is removed: it made the fresh registration fail outright.

## 2026-07-30 — Desktop alpha: simpler tray menu

### Desktop

- `@antseed/desktop@0.1.115-alpha.24` (prerelease)

### Changed

- The menu-bar tray menu is now three actions — show the app, show the floating window, and Connect/Disconnect — replacing the old peer/model/per-app submenus, and it stays in sync with the runtime state. The Connect/Disconnect entry toggles the main routing runtime, and "Show Floating Window" opens the app first when no window is up.
- Preferences copy: the floating-window auto-open setting now reads "Show on traffic".

## 2026-07-30 — Desktop alpha: fix silent macOS update installs

### Desktop

- `@antseed/desktop@0.1.115-alpha.23` (prerelease)

### Fixed

- Fixed a macOS auto-update failure where clicking "Restart & update" quit the app but never installed the update or relaunched. A ShipIt launchd job left registered by a previous update (observed after the AntSeed Desktop → AntSeed VPR rename) made launchd accept Squirrel's fresh submission without ever starting the installer helper. The install handler now clears any existing `com.antseed.desktop.ShipIt` registration before handing off to Squirrel. If a machine hits this once more on the way to this version, the pending install can be completed with `launchctl kickstart gui/$(id -u)/com.antseed.desktop.ShipIt` or by simply relaunching the app.

## 2026-07-30 — Desktop alpha: connect toggle for set-up apps

### Desktop

- `@antseed/desktop@0.1.115-alpha.22` (prerelease)

### Added

- Connected Apps rows now show an on/off toggle for apps that have been set up before, so reconnecting a previously configured tool is one click instead of re-running Connect. The set of ever-connected apps (`setupProfileNames`) persists across app restarts and proxy stops, including state files written by older builds.
- Disconnecting an app now restarts it so it immediately drops the proxy configuration instead of keeping stale settings until its next manual restart.

## 2026-07-30 — Desktop alpha: network trouble alerts + visible auto-updates

### Desktop

- `@antseed/desktop@0.1.115-alpha.21` (prerelease)

### Added

- Desktop now detects and explains why the peer-to-peer network is unreachable instead of silently looking connected. A banner distinguishes three cases: no internet connection, a firewall/VPN blocking peer-to-peer (UDP) traffic, and being on the network but finding no providers. The first-launch setup screen shows the same hint when peer discovery stalls, and the Home power button renders as off while the network is unreachable.
- Detection is driven by a new `GET /_antseed/status` buyer-proxy endpoint reporting the DHT routing-table size and consecutive empty discovery sweeps (blocked UDP produces no errors — lookups silently return nothing, and cached peers keep rendering as online). Grace periods cover DHT bootstrap after startup and re-bootstrap after connectivity returns, so the alerts don't flash during normal recovery.
- Auto-updates are visible again: a banner shows download progress, an "Update available — Restart & update" action when the new version is ready, and failure details on error. The update UI had been lost in the VPR shell redesign — updates downloaded and installed on quit, but nothing in the app ever showed them.

### Fixed

- Alpha prerelease versioning switched from `-alpha-0.N` to `-alpha.N` so installed alphas auto-update to newer prereleases and graduate to stable releases when one is published. Installs of `0.1.115-alpha-0.20` and earlier can't see the new format — install this release manually once; updates are automatic from then on.

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
- Added T3 Code to Desktop Connected Apps, creating a managed AntSeed Claude provider that routes its models through the local buyer proxy.
- Added Desktop runtime log source filters and buyer debug log filtering via `antseed buyer start --log-filter` / `ANTSEED_LOG_FILTER`.
- Added Desktop peer favicons from verified domains, showing fetched site icons in Discover and chat peer avatars when available.
- Added zero-price free usage authorization for advertised free services, including buyer-signed P2P usage records, seller on-chain reporting through `AntseedFreeUsage`, and CLI configuration for the deployed free usage contract address.
- Added a buyer-side metadata v2 service attribution opt-out for CLI and Desktop. Buyers can disable per-service attribution while preserving aggregate usage metadata in paid SpendingAuth and free-usage records.
- Added `antseed buyer emissions info` and `antseed buyer emissions claim` for buyer-side ANTS emissions.
- Added generic API request, response, and streaming adapters that transform between Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses through internal canonical models.

### Removed

- Removed the legacy subpool/subscription payment surface, including the `antseed buyer subscribe` command, subpool payment client/config exports, and the `AntseedSubPool` contract deployment path.

### Changed

- Set generated model metadata for supported connected tools and CLI wrappers to a 280,000-token context window, with an 8,192-token output limit where the tool supports one.
- Changed API adapter streaming transforms to use canonical stream events with per-protocol normalizers and renderers, so new stream protocols can be added without pairwise routes.
- Changed Desktop renderer navigation to load only the active view, preload likely next views, and show a lightweight loading state while lazily loaded pages resolve.
- Reduced the default buyer response-auth evidence sample rate from 20% to 0.5% to limit local `verification_samples` growth during high-request sessions.
- Increased the default free-usage on-chain record flush interval from 10 seconds to 5 minutes to reduce background transaction frequency while preserving batch, disconnect, and shutdown flushes.
- Increased default seller concurrency from 5 to 50 concurrent requests, including the OpenAI Responses provider default, for bursty clients.

### Fixed

- Fixed the Desktop Telegram bridge so `/model` offers the same curated list as the in-app model dropdown (starred favorites first, then the recommended lineup, routed to the same sellers), and so models outside the buyer pricing policy are never offered or kept as the default route — previously a stored route to an over-priced seller made every Telegram message fail with a routing-policy 502.
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
