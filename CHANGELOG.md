# Changelog

All notable user-facing changes to AntSeed packages are documented here.

This project uses selective package publishing. Each release entry lists the published packages affected by that release.

## Unreleased

### Added

- The website now has a Privacy Policy page at `/privacy-policy`, linked from the footer next to the Terms of Service. It documents website analytics and advertising cookies, download-delivery telemetry, the desktop app's local-only key storage and update checks, and the privacy properties of the peer-to-peer protocol and on-chain payments.
- Website download buttons now offer an "All platforms & versions" link that opens a modal listing every installer (macOS Apple Silicon/Intel, Windows x64, Linux AppImage x86_64/ARM64) as direct `download.antseed.com` links, with older versions and `.deb` packages linked to the GitHub releases page. This gives visitors whose OS was detected wrong — privacy browsers that spoof a Windows user agent on Linux, for example — a way to pick the right installer without leaving the page.
- Desktop installer downloads from the website now go through `download.antseed.com` (a new Cloudflare Worker, `apps/download-proxy`) instead of linking GitHub release assets directly. The proxy resolves the latest release server-side — so download buttons have a direct per-platform URL without any client-side GitHub API call — streams the installer, and reports download started/completed/aborted telemetry to GA4 alongside the existing `download_vpr` click event, giving full click → download-finished funnel visibility. Website-driven downloads are now also cleanly separated from electron-updater traffic, which keeps fetching from GitHub directly. Unresolvable requests (unknown platform, partial releases) fall back to the GitHub releases page as before.

### Fixed

- Website download buttons no longer send first-time visitors to GitHub before device detection finishes. Early clicks now show a spinner in the button while the matching installer resolves, with the releases page used only as a fallback.
- Public tunnel conversations now identify Cursor from its `Cursor/1.0` User-Agent (or an explicit originator/Cursor header) instead of labeling every tunneled request as **Public Tunnel**. Cursor's OS, shell, and workspace preamble is ignored when choosing chat titles, and previously stored preamble titles heal on reload. Other authenticated tunnel clients without an application identifier continue to appear as **Public Tunnel**. Desktop also remembers a running tunnel and restores it after the app restarts, while tunnels stopped by the user remain off.
- Desktop model discovery no longer stalls forever on slow machines or connections. The discovery pipeline previously did unbounded network work (per-peer metering, seller-domain metadata, a ~400KB network-stats download on every cycle) and could exceed the UI's 12s cutoff on every refresh, leaving "No models discovered yet" / "Loading models…" while the runtime was healthy. Each phase now has a hard time budget with graceful degradation, network-wide seller stats come from the Antscan explorer API (~20KB, cached 60s, aggregator fallback), and the UI cutoff is a generous 30s backstop. Discovery failures, recoveries, and slow-cycle phase timings are now written to the system log so exported logs capture this failure mode.

### Changed

- Desktop sidebar navigation now follows **VPR**, **Chat**, **Models**, **Apps**, **Agents**, **Prefs**, and **Help**.
- Desktop and CLI now expose the authenticated VPR model API through optional ngrok or Cloudflare HTTPS tunnels for Cursor, remote agents, servers, and OpenAI-compatible SDKs. Desktop manages provider credentials, generated API keys, connection details, and endpoint lifecycle in one shared modal that opens from **Agents**, **Connected apps**, **Preferences**, and **Help**. Connected apps includes a tunnel-gated Cursor card with the exact URL, API key, model, and native launch steps. The **Agents** view links maintained Hermes and OpenClaw integration pages and setup skills, while website docs and skills cover Hermes' current `providers:` schema, OpenClaw's required `authHeader: true` bearer authentication and current model commands, supported routes, Cursor setup, CLI usage, and troubleshooting.

- Desktop Help now explains the Virtual Private Router as a VPN for AI and adds practical guidance for built-in chat, connected apps, per-conversation model and seller selection, floating-window controls, routing, credits, rewards, the local API, and troubleshooting. Each subject links to a new comprehensive VPR guide or relevant supporting source.

- Desktop model prices and the **Free** badge now reflect only sellers the routing trust gate can actually select, so a low-trust seller's $0 or teaser offer no longer advertises a price a send would never be billed at (picking such a "Free" model previously failed with a 402 for unfunded users). Savings percentages in the model dropdown, model page, and model lists now consistently compare that eligible live price with the retail reference baseline. The Recommended list's free ride-along models are trust-gated the same way, and the first-run default model is chosen from a free-model priority list (DeepSeek Flash, MiniMax, Haiku, Qwen, Nemotron, Gemma, Mistral Large), falling back to the free offer from the highest-trust seller.

- Desktop Connected Apps now uses the correct Hermes portrait brand mark instead of the temporary pixel-art icon.
- Desktop Connected Apps now includes Hermes Agent, configures its named OpenAI-compatible provider in `~/.hermes/config.yaml`, launches the installed Hermes desktop app by default, and shows concise app descriptions with website/download links directly in each app's settings header. Hermes chats now appear in Recent Chats even though Hermes does not send an explicit session header: the buyer derives a stable, privacy-preserving conversation key from the initial user-turn prefix and ignores title-generation housekeeping requests.
- Nested desktop info tooltips now stack above their parent tooltip instead of being hidden behind it.
- Desktop chat now uses a clear, lightweight **View chats** / **Hide chats** control with matching sidebar-state icons, replacing the ambiguous arrow-only conversation-list toggle.

- Windows desktop installers are now Authenticode-signed with the AntSeed Foundation's code-signing certificate. The release build signs directly against the issuing CA's cloud HSM (the private key never exists outside it), with the credentials held in a reviewer-protected CI environment; local and fork builds without the signing secrets continue to produce unsigned installers unchanged.

- Desktop image chats now require sellers that advertise `moderation` support and send `moderation: "low"`, preventing automatic fallback to sellers that would silently restore provider-side Safe Mode blurring. Model lists show reviewed tags such as **Uncensored**, **Coding**, **Reasoning**, **Vision**, **Web search**, and **Open weights** from a versioned declarative registry covering maintained OpenRouter and Venice catalogs with per-model provenance, instead of trusting seller-announced categories. Seller rows identify offers with **Moderation control**, and requests fail clearly when no compatible seller is available.
- The AntSeed X (Twitter) account moved from `@antseedai` to `@antseed`; all website, desktop help, and brand guideline links now point to https://x.com/antseed.

- Desktop Connected Apps now opens directly to the complete app list without the redundant search field at the top; application-picker searches remain available when choosing an installed app. The Home notice for apps that need restarting can now be dismissed for the current app launch and returns after Desktop is relaunched.
- Desktop Connected Apps now includes GooeyPi, configures its Pi harness through `~/.pi/agent/models.json`, auto-detects the installed desktop app, and stamps distinct `originator` headers for Pi and GooeyPi so VPR conversations are attributed to the correct client instead of the underlying OpenAI SDK.
- Buyer request and streaming duration limits are now configurable through `buyer.requestTimeoutMs` and `buyer.maxStreamDurationMs`, allowing slow or long-running generations to exceed the previous fixed five-minute cap.
- The default streaming duration cap was raised from 5 to 30 minutes. Streams longer than the cap were cancelled mid-response, which surfaced in OpenAI Responses clients (e.g. Codex CLI) as `stream disconnected before completion: stream closed before response.completed` on long agentic turns. The cap can also be set via the `ANTSEED_BUYER_MAX_STREAM_DURATION_MS` environment variable.
- The retail savings baseline (desktop Saved tile, Home price strikethroughs, and the CLI activity Saved tile) no longer hard-codes OpenRouter: the comparable-prices source is any endpoint serving the OpenRouter-compatible models schema, configured via the `ANTSEED_COMPARABLE_PRICES_URL` environment variable (e.g. point it at OpenRouter's models endpoint). Release builds (npm packages and desktop installers) bake in a default URL at build time from the repo's CI configuration; the environment variable overrides it, and setting it empty disables the baseline. Builds from source have no default — savings and strikethrough baselines are off until the variable is set.
- Documentation now explains the `model: "antseed"` alias that follows the current VPR model picker, with ready-to-use examples for generic OpenAI-compatible clients, Hermes, OpenClaw, and raw HTTP requests.
- Desktop: the in-app chat is now branded VPR — the AntStation name, logo wordmark, and labels (title bar, setup screen, empty chat state, floating pill, preferences hint, chat-list source label, and assistant system prompt) are replaced with VPR. In-app chats now identify themselves to the buyer proxy with the `x-vpr-session-id` header (conversation key `vpr:<id>`); the proxy still strips the legacy `x-antstation-session-id` header from older desktop builds before forwarding to sellers, and chats recorded under the legacy identity keep showing as VPR while their peer affinity re-establishes on the next message.

### Security

- P2P TCP transport is now encrypted end-to-end (`transport.tcp-enc.v1`): a wallet-signed ephemeral X25519 handshake with forward secrecy and mutual peer authentication, AES-256-GCM framing for all payload traffic. Enabled automatically between peers that advertise the capability in discovery metadata; once offered, the handshake fails closed rather than downgrading to plaintext, and the intro signature covers the advertised capabilities and encryption offer so an on-path attacker cannot strip them to force a legacy fallback. Legacy peers still connect over plaintext unless the new `requireSecureTransport` node option is set.
- WebRTC signaling now signs SDP descriptions (`transport.signed-sdp.v1`), binding the DTLS certificate fingerprint to the peer's wallet identity so a man-in-the-middle on the signaling socket can no longer substitute its own SDP.

### Fixed

- Desktop no longer locks a brand-new install onto a paid default model. The first-run model pick fires on the first discovery snapshot, which is cold — DHT discovery is still partial and on-chain reputation hasn't been fetched, so every free seller fails the routing trust gate and the pick fell back to a paid model that was then persisted permanently. A default not backed by an eligible free route is now provisional: it renders immediately but is not saved, and each discovery refresh re-picks until a trusted free offer appears (which becomes the saved default) or the user explicitly chooses a model. While the pick is provisional, the Home model card shows a "Finding free peers…" hint so the first-use search for a free model is visible instead of silent. The Models view drops the Recommended/All tabs and the pinned selected-model card for one flat catalog list with search, type/family filters (including a new **Free** filter option), and sort. Its top three rows are grouped by a thin framed panel whose border is cut by a small floating label: once the user has starred any model the frame shows their **Favorites**; otherwise it shows **Recommended** — the selected model first, then, until the first deposit ever lands, the most available free models (paid rows would just fail with 402 for an unfunded user), or the popular lineup once funded. Searching or filtering shows the plain filtered list. The Home model dropdown follows the same rules, leading with the three most available free models before the first deposit and filling the remaining rows from the regular popular lineup, which takes over fully — and permanently — after the first deposit.
- The desktop first-run setup screen was rebuilt around its real job — securing a free model to start with — instead of a static checklist that sat on "Loading services" for the whole bootstrap. It now says it is finding free models on the peer network, shows three live tallies that fill in as discovery progresses (network nodes, AI sellers, free models — the free count comes from sellers' fetched per-service pricing, not headline prices that default to zero when unknown), and narrates the current phase in one line that advances as each number becomes real: installing the plugin, connecting to the network, searching for sellers, fetching seller catalogs, looking for free models, then confirming a trusted free model. Setup now completes when routing actually confirms a free-backed default ("Free model ready — <model>"), under a hard two-minute ceiling from when the screen appears — past it the user gets in regardless of how far discovery came (only an unfinished plugin install may hold longer), and the Home "Finding free peers…" hint carries the search on from there.
- A failed chain-RPC probe at buyer startup no longer silently disables payments for the whole session, which left sellers' `402 Payment Required` responses looping unrecoverably (the buyer could not sign the required catch-up authorization) while the app still reported Healthy. Payments now stay enabled: the RPC is monitored in the background with retry, and best-effort on-chain reads resume automatically once it answers. `ANTSEED_ENABLE_SETTLEMENT=false` remains the explicit opt-out.
- The buyer control plane (`/_antseed/deposits/status`) now reports why the automatic-deposit watcher is not running (`payments-disabled`, `no-deposit-relay`, or `external-daemon`) along with live payments and RPC health, and the desktop deposit banner names the actual cause instead of always blaming the chain.
- When a seller demands payment while payments are not running on the buyer, the buyer now returns a clear buyer-side error explaining that this is not a balance problem, instead of forwarding the seller's raw `payment_required` body that asked the user to add credits. Desktop chat errors now show the human-readable message authored by the proxy and payment negotiator instead of raw JSON or generic HTTP text.
- Sellers now monitor their wallet's ETH balance while running (`seller.gasCheck`, enabled by default in payments mode). When the wallet can no longer fund on-chain settlement, the seller pauses advertising — instead of staying discoverable while rejecting every buyer — and prints a console notice with the wallet address to fund; `antseed seller status` shows the same warning. Advertising resumes automatically once the wallet is topped up.
- Seller startup now warns when `seller.publicAddress` is missing or non-public, and `antseed seller doctor` classifies and locally probes the announced endpoint with explicit NAT guidance. The `/docs/transport/` guide now covers port forwarding, firewalls, and VPS/reverse-tunnel deployments.
- CLI identity loading now fails safely when the data directory contains an app-encrypted, unreadable, or malformed identity instead of silently generating a second wallet and overwriting or competing with the existing signer.
- Fixed Desktop image chats dropping an explicitly selected seller when moving from a model page into chat. Image follow-ups use true edits only with sellers that advertise image input support; generation-only sellers instead generate a new image from the cumulative prompt history, and payment progress no longer replaces the image shimmer with the text loader.
- Fixed Desktop image edits losing their selected model while crossing the multipart buyer/seller relay, which caused compatible upstreams to reject follow-up prompts with `model is required`. The image generation shimmer now also appears reliably for the first prompt, before the conversation has entered persistent image mode.
- Local-LLM providers now consume per-service pricing from seller configuration, so differently priced local models are advertised with their configured rates instead of inheriting the provider default.
- CLI plugin installation now reports an actionable Node.js/npm requirement when `npm` is unavailable instead of exposing the raw `spawn npm ENOENT` process error.
- CLI seller configuration now passes a configured `baseUrl` to the local-LLM plugin using its declared `LOCAL_LLM_BASE_URL` key instead of silently falling back to the default Ollama endpoint.
- Provider body injection configured for OpenAI-compatible chat requests no longer leaks into `/v1/images/*` requests, preventing strict image-generation upstreams from rejecting otherwise valid payloads.
- Conversations can now switch from a Chat Completions-backed model to a native OpenAI Responses model without failing on incompatible synthetic message or function-call item IDs. Existing affected histories are repaired narrowly on continuation, while native Responses conversations remain byte-for-byte passthrough so cache keys, response chaining, encrypted reasoning, and prompt history are preserved.
- Documentation, integration guides, buyer skills, and CLI/Desktop help now consistently describe model-only routing through the network-wide `/v1/models` catalog, shared Price + Trust preferences, soft conversation affinity, retry fallback, and persistent explicit peer pins. Automatic routes use catalog model IDs, while `<peerId>@<serviceId>` is reserved for explicitly selecting a seller offer.
- Desktop Activity (and the new `antseed buyer activity`) no longer overstate a channel's locked amount: the displayed value is now the recoverable amount — the on-chain reserve minus the larger of on-chain settled and the buyer's signed cumulative spend. Sellers settle lazily, so the previous `deposit − settled` formula showed already-spent (signed but unsettled) funds as locked, e.g. a fully-used $1.00 channel still displaying "$1.00 locked". Channels opened with delegated sellers (an on-chain seller contract such as DiemStakingProxy) now also resolve: when the canonical AntseedChannels has no record, the lookup retries through the seller facade's `channelsAddress()`, so those rows show real locked amounts and statuses instead of "locked amount unavailable".
- Buyer conversations now retain the actual seller selected for each request, softly prefer that seller on later turns with automatic failover, and expose routed seller names in Desktop only when the existing Show routed peer preference is enabled.
- Desktop Price + Trust settings now persist to `buyer.routingPreferences`, and the running buyer proxy hot-reloads them so `/v1/models` peer order and model-only request dispatch use the same policy. The default `minTrustScore` of `60` is a hard gate for model-only auto routing; CLI-only buyers can lower it or set it to `0` when routing to new or unscored sellers. Automatic text and image chats remain model-only for live fallback, while explicitly selected sellers remain pinned.
- Fixed network model routing review issues: unrestricted requests no longer select coding-only offers, Auto routes sync unrestricted service IDs, explicit peer pins tolerate stale service metadata, legacy conversations return to model-only routing unless explicitly pinned, legacy proxy reuse works across versions, raw trust fallbacks are normalized, malformed model IDs return JSON 404s, reminder savings use canonical model keys, and Desktop can show its persisted catalog during cold start.
- Fixed model-only routing for forwardable endpoints without a detectable API protocol, prevented Desktop Auto chat dispatch from bypassing the minimum-reputation gate, and stopped legacy multi-provider peer metadata from assigning every service exclusively to the first provider.
- Fixed canonical model routing and upgrade compatibility: selected aliases now keep their matching service protocol, pinned aliases are rewritten to the peer's advertised service ID, full services are not displaced by cheaper `coding-only` routes, mixed text/image catalogs remain text-routable, and legacy favorites, seller pins, conversation pins, and stale buyer proxies migrate safely.
- Desktop model discovery now consumes the buyer proxy's `/v1/models` catalog directly, so canonical model grouping, cheapest duplicate selection, cached-price reputation penalties, capabilities, and peer ordering use the same source of truth as API clients.
- On-chain reputation no longer collapses established migrated/facade sellers to the `$25` new-seller credit when their staking contract returns a missing or zero `stakedAt` timestamp. High-activity verified accounts infer mature status, and refresh failures or zero reads no longer overwrite a previously valid staking date.
- On-chain reputation refreshes now update atomically: transient stake or staking-timestamp RPC failures preserve the last verified snapshot and score instead of temporarily halving or collapsing a healthy seller's reputation and removing it from automatic routing.
- Desktop Auto selection now defaults to a minimum `6.0` reputation and treats that threshold as a hard eligibility requirement, so a cheaper seller below the configured minimum can never win on price. Existing installs that still carry the previous `0.0` default migrate to `6.0`; deliberate threshold changes remain persisted. Seller rows also no longer show the last on-chain settlement date.
- Request bodies over 240 KiB (previously 512 KiB) are now sent via the chunked upload protocol, keeping every single frame under the 256 KiB WebRTC data channel message cap so large requests work over any transport.
- The WebRTC transport is now actually functional: nodes load node-datachannel at startup (previously it was never initialized, so every connection silently used TCP). Peers with a working WebRTC stack advertise `transport.webrtc.v1` in discovery metadata. Encrypted TCP remains the preferred transport between nodes (WebRTC data channels cap messages at ~256 KiB, below the 1 MiB protocol chunk size); initiators use WebRTC only toward peers that support WebRTC but not encrypted TCP. Sellers without a working stack now refuse `hello` signaling cleanly instead of crashing on it — previously any WebRTC connection attempt (e.g. from a browser buyer) hit an unguarded code path.
- Free sellers are no longer penalized for omitting cached-input pricing: a $0 offer has nothing to underquote, so it skips the 50% effective-reputation reduction. Under the hard minimum-reputation gate that reduction had made every such free seller ineligible for model-only auto routing whenever any paid competitor on the same model advertised cached pricing (a halved 0–100 score can never reach the default 60). The Desktop first-launch free model default now also requires a free seller that actually passes the auto-selection gate — a model that only looked free off a gated-out cheapest seller could previously become the default and silently dispatch a zero-balance user to a paid peer, failing with an out-of-credits error.
- Auto seller selection now treats the minimum trust score purely as a gate and orders eligible peers by total price, with reputation, failure streaks, and preference bonuses breaking price ties. Previously reputation kept dominating the ranking above the threshold (one display point of reputation outweighed $2/Mtok of price), so a 9.9-reputation paid seller would beat an eligible free seller of the same model — Auto now picks the free or cheapest eligible offer, matching the Price + Trust preference the UI describes.
- Website VPR call-to-actions no longer offer a desktop installer download on phones. The navbar item in the mobile hamburger menu and the two ANTS token page buttons now read **Get Started** and route to the `/get-started` mobile onboarding flow, matching the behavior the homepage buttons already had. Website analytics now report these mobile taps (and any `/get-started` link) as a distinct `get_started` funnel event instead of counting them toward the `download_vpr` conversion event, which phone taps on the homepage CTAs previously inflated.

### Added

- The website footer's Network column now links to the AntSeed Improvement Proposals site at https://aips.antseed.com.
- Added `@antseed/web-sdk`, a browser buyer SDK: connects to unmodified sellers over WebRTC DataChannels (signaled through a relay) and runs the shared `@antseed/buyer-core` request/payment stack — 402 negotiation, in-browser EIP-712 ReserveAuth/SpendingAuth signing, SSE streaming, and chunked uploads. `AntseedWebClient.create()` durably commits complete channel recovery state to IndexedDB before transmitting authorizations, surfaces background storage failures through `onPersistenceError`, and uses an identity-scoped Web Lock to prevent concurrent signing from multiple tabs; the public constructor and explicit `ephemeral()` mode retain injectable/in-memory operation for compatibility, tests, and free interoperability experiments. The `BuyerChannelStore` contract now supports an atomic authorization commit, an optional async `flush()` durability barrier, and lifecycle cleanup; the buyer stack persists and recovers ReserveAuth/SpendingAuth signatures, reserve/top-up state, encoded metadata, and per-service usage. Browser uploads chunk above 192 KiB to stay under the ~256 KiB SCTP message ceiling (`ProxyMux` gained an `uploadThresholdBytes` option). The client takes any address-bearing ethers `AbstractSigner` (`BuyerSigner`) instead of requiring a concrete `Wallet`, supports full `RTCIceServer` entries (TURN credentials) plus `iceTransportPolicy`, reports the selected WebRTC path (`direct`/`relay`/`unknown`) via `onConnectionInfo` without exposing addresses, and ships a working browser example page (`packages/web-sdk/examples/example.html`, served by `pnpm --filter @antseed/web-sdk run example`).
- Added `@antseed/relay`, the web relay browser buyers need: a DHT-discovered seller snapshot at `GET /sellers` and a `WS /bridge/<peerId>` byte pipe to the seller's TCP signaling port. The bridge dials only cached seller endpoints, refuses private/internal address ranges for DHT-announced sellers (checked for IP literals and again at DNS resolution), enforces per-IP, per-seller, and global bridge caps plus a configurable WebSocket message-size limit, supports an optional browser Origin allowlist, exposes cache-aware readiness and privacy-safe aggregate metrics, and supports `RELAY_TRUST_PROXY=1` for deployments behind a TLS-terminating proxy.
- CLI: `antseed buyer deposit` is now the deposit flow — it prints the node's funding address and a terminal QR code (EIP-681 payment request), serves the browser-wallet checkout page and prints its link for users who prefer depositing from a connected wallet, then watches and deposits incoming USDC into the buyer's credits automatically via the gasless relayer sweep. Works through a running buyer daemon or standalone with an ephemeral node; `--amount` prefills the QR request and checkout, `--no-watch` prints without waiting, and `antseed deposit` works as an alias. The previous `buyer deposit <amount>` direct on-chain deposit (hot wallet pays gas) moved to `buyer deposit --onchain <usdc>`.
- CLI: the buyer daemon now auto-sweeps incoming hot-wallet USDC into the deposits balance while `antseed buyer start` runs (new `buyer.autoSweep` config, default `true`), matching the desktop's automatic deposit behavior. The watcher is exposed on the proxy control plane (`GET /_antseed/deposits/status`, `POST /_antseed/deposits/watch`); the desktop app now drives the daemon's watcher instead of running its own signer, so CLI and desktop can no longer race a sweep against the same wallet.
- CLI: new `antseed buyer activity` command — the terminal counterpart of the desktop's Activity view: lifetime tokens/spent/saved tiles (savings measured against a configurable retail-prices API across matched models), a per-day spending chart over 7/30/90 days built from channel snapshots, active channels with on-chain locked amounts (with channel IDs and close guidance), the deposits balance, and claimable ANTS emissions. Served by the running buyer connection; `--json` for scripts.
- CLI: `antseed payments` no longer launches the retired web portal — it now prints the commands that replaced it (`antseed buyer deposit`, `antseed buyer balance/sweep/withdraw/channels/status`). `antseed buyer sweep` now fails fast when every relayer declines the request instead of waiting out the full confirmation window.
- Desktop image chats now treat the first prompt as a generation and later prompts as edits of the latest generated image. While an image request is running, the header model picker stays available with image-only choices, and the conversation shows a dedicated generation/edit shimmer until the result arrives.

- Desktop: add a locally evaluated $10 frontier-model onboarding offer on the VPR Home screen for qualifying free users, with first-use or grandfathered D2 entry and follow-ups on days 5 and 15 while no deposit exists.
- The buyer proxy now answers `GET /v1/models` locally with a network-wide model list aggregated from discovered peers — no peer pin required. Cosmetic variants and conservative aliases such as `claude-opus-5`, `opus-5`, and `opus5` merge into one model and are exposed in `aliases`; Fable variants such as `claude-fable-5`, `fable-5`, and `fable-5-coding-only` also merge while preserving each seller's actual service id and protocol. Numeric-version variants such as `gpt-5.6-sol`, `gpt-56-sol`, and `openai-gpt-56-sol` merge across established model families, while materially different suffixes such as `pro`, `fast`, and `web` remain separate. Aggregated entries now expose a protocol-wide preferred display `name`, so compact aliases such as `gpt-56-luna` consistently render as `GPT 5.6 Luna` across API and desktop surfaces while routing continues to use the seller's actual `serviceId`. When one peer advertises multiple aliases for the same canonical model, only its lowest-priced offer is listed and used for model-only routing: text compares input plus output price, images compare minimum per-image price, and known prices outrank unknown prices. Every retained `peers` offer exposes its actual advertised `serviceId`, resolved protocol, announced protocols, categories, pricing, reputation, effective model-specific reputation, context and output limits, modalities, reasoning, tool-use, structured-output, and supported-parameter capabilities. Model-level capability fields are conservative guarantees across every offer, while `capability_coverage` distinguishes unknown metadata and `supported_protocols` summarizes the network-wide protocol union. The API, desktop seller lists, and desktop score labels now use the same normalized 0–100 model-specific reputation, with unknown scores last. For a model where at least one offer advertises cached-input pricing, an offer missing cached-input pricing receives a 50% effective-reputation reduction because its real cache-heavy workload cost may be materially higher; if no offer advertises cached-input pricing, no penalty applies. Model-only requests use the same effective score, then skip peers in an active PR #750 cooldown when another offer is ready, rewrite to the seller's advertised service ID, and fall back through lower-ranked peers after peer-attributed retryable failures. Desktop Auto routes, Telegram model selections, automatic in-app chats, and connected-app `antseed` aliases now persist only the selected model, so live peer selection and fallback remain active; a seller chosen explicitly in the desktop and `<peerId>@<serviceId>` requests remain single-peer. Buyer-local failures and started streams never fail over. `?type=text` / `?type=images` filters the list, and `GET /v1/models/<id>` looks up a single model across the network.
- `antseed network browse` now derives its per-peer service lists, pricing, and free-service columns from the shared network service catalog — the same source as `GET /v1/models` and the desktop Discover view — so it also surfaces services announced only through protocol/capability metadata or the legacy peer-wide `services` field. Its closing hint now leads with model-only routing (request a model, the proxy auto-selects the best peer) and keeps peer pinning as the explicit override. Website docs, integration pages, the FAQ, and the buyer skills were updated to present pinning as optional across the board.
- SpendingAuth metadata v3 counts generated images: a raw `output_images` counter (top-level and per-service) plus a flat 1290-output-token equivalent per image credited into the token counters, so image work shows up in usage stats. Image requests with no upstream token usage attribute an estimated prompt token count as input. Attribution only — image billing stays on the per-unit price, and the equivalents never enter cost verification. Existing decoders keep reading the aggregate counters (first four fields unchanged); the services array layout is versioned.

- Desktop VPR now discovers and clearly labels image-generation-only models, carries advertised service capability hints and per-image billing tiers through to each seller row, and shows seller-specific image prices, context windows, output limits, modalities, tools, structured output, and supported parameters without incorrectly merging those details at model level. Image models stay out of the main text and connected-app dropdowns and instead offer dedicated “Use in chat” and “Copy instructions” actions; copied instructions reference the public `antseed-images` skill, discover current image models through `/v1/models?type=images`, and use model-only routing so the proxy can select and fail over between serving peers. Image prompts appear in the conversation immediately while generation runs through `/v1/images/generations`, and generated files are stored as persistent conversation attachments. Image routes remain excluded from chat-only external model pickers.

- Website docs now cover the gasless `antseed buyer sweep` command: a CLI-reference entry plus a payments-guide section explaining the offline EIP-3009 authorization, the fixed USDC relay fee, broadcast via a running buyer daemon or an ephemeral node, amount clamping to credit-limit headroom, and the first-deposit minimum. The guide also gained a provider note on relaying sweeps for the fee (`relayer.enabled`, `relayer.minProfitBaseUnits`) and the `AntseedDepositRelay` address in the Base Mainnet contract table.

- Desktop: the All Models list can now be filtered by model family (Anthropic, OpenAI, Moonshot, Z.ai, …), derived from the same brand resolution as each row's vendor mark. The model-type filter pill now reads "Model type" instead of "Any" when no type is selected, and the category dropdown was removed from the list's filter row. Opening a model page no longer stalls on loading its code on first tap, the Models list shows a loading spinner while the first discovery snapshot is still being fetched, and the list's tabs, filters, and search stay responsive on large catalogs (interruptible list re-renders, cached model-identity/brand resolution, offscreen rows skip painting).

- Desktop: added seller-assisted channel closing to Activity for sellers advertising `payments.cooperative-close.v1`, with clear rejection feedback and the existing wallet-based on-chain close retained as a permanent fallback.

- Discovery metadata v12 widens service catalog and per-service map counts to support up to 512 services per provider. Metadata now allows 64 categories and 4 API protocols per service, a 128 KiB signed binary snapshot, and a bounded 256 KiB HTTP metadata response. Buyers remain compatible with v10/v11 sellers, while sellers validate the same limits before announcing.
- Added end-to-end OpenAI image generation support: buyers can route `/v1/images/generations` and `/v1/images/edits` requests through the proxy to image sellers, with per-unit billing (`output_images` components with size/quality matching) announced in discovery metadata and verified on both sides of the payment flow.
- Sellers can announce per-service model capability hints — context window, max output tokens, input modalities, reasoning / tool-use / structured-output support — via `seller.providers.<provider>.services.<service>.capabilities`, the `antseed config seller add-service --capabilities` option, the seller setup wizard, or `ANTSEED_SERVICE_CAPABILITIES_JSON`. Built-in OpenAI, OpenAI Responses, Anthropic, Claude OAuth/Code, and local-LLM providers now announce them in discovery metadata version 12, with invalid values rejected before startup.
- Service capability hints now also cover output modalities (`outputs`, e.g. `["image"]` for image services) and accepted request-body parameters (`supportedParameters`, e.g. `["background", "output_format", "seed"]`), so buyers can discover what a service produces and which optional parameters it honors instead of guessing. The `openai` provider advertises `outputs: ["image"]` automatically for `openai-images` services; explicit capability config extends or overrides the default per field.
- The buyer proxy now logs a warning when an outgoing request carries body parameters the routed peer did not announce in `supportedParameters` for that service. The check is advisory only — requests are never rejected, protocol-core fields (model, prompt, messages, stream, …) are always allowed, and peers that announce no parameter list are never flagged.
- `antseed seller setup` now builds service capabilities through guided per-field prompts with inline validation and re-asking on invalid answers, instead of requiring a hand-written JSON blob. The question set depends on the service's protocol: image models (gpt-image, dall-e, grok-imagine) are asked only about input modalities and supported request parameters (`outputs: ["image"]` is announced automatically), while text models get the full set — context window, max output tokens, input/output modalities, reasoning, tool use, structured output, supported parameters. Pasting a JSON object at the capabilities prompt still works.
- Seller service config now supports per-protocol unit billing models at `seller.providers.<provider>.services.<service>.unitBillingModels`, with matching `antseed config seller add-service --unit-billing-models` and setup-wizard inputs; the CLI serializes them to `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON` for providers that support non-token billing.
- Seller startup now warns when `unitBillingModels` are configured for a provider plugin that does not declare unit-billing support, instead of silently ignoring the setting.
- Model health checks now skip `openai-images` services instead of incorrectly falling back to a Chat Completions probe; image services remain advertised until a non-billable image-specific health check is available.

- Desktop: added a card deposit path powered by AntSeed Pay (antseed-pay.com) with Stripe checkout for US users. The app asks the hosted pay page which providers serve the user's region (its public `/api/options` endpoint, geo-resolved at Cloudflare's edge) and, when Stripe is available, leads the Add Credits chooser with a green Link-branded "Pay with link" button (official Link logo; "Powered by Outerfound" and the accepted card brands — Visa, Mastercard, Amex — on a caption line beneath it); the Fun checkout moves under "More options" as "Deposit using Fun". When Stripe isn't available (non-US region, or the check fails — it fails closed), the chooser stays Fun-led and the card checkout appears under "More options" as "Deposit using Outerfound" (Card · US only), which opens the pay page's own "not available in your region" screen. Selecting the card path opens a narrow app-owned checkout window (420×700) on the signed funding link pinned to the Stripe integration (`provider=stripe`); the existing deposit watcher sweeps the purchased USDC into credits and closes the window when funds arrive. The USDC-on-Base quick deposit row now ends with a chevron indicating it opens its own screen.
- The desktop now shows deposit progress as a fixed banner from any view — received → depositing → credited (with a transaction link), on top of every overlay including the Fun checkout modal — instead of only inside the deposit page. The main-process deposit watcher also keeps running for a while after the deposit page closes (slow background polling, ~30 min, re-armed by activity), so a card/Fun delivery landing after you navigate away is still swept into credits automatically.

- Sellers now run periodic model health self-checks (a 1-token probe per advertised service, every 5 minutes by default) and unadvertise services that keep failing, restoring them automatically when they recover. Configurable via `seller.healthCheck` (`enabled`, `intervalMs`, `failureThreshold`); sellers announcing this behavior advertise the `seller.model-health.v1` capability in discovery metadata. Exposed as `ModelHealthChecker` in `@antseed/node`, alongside `AntseedNode.refreshSellerMetadata()` for runtime service-list changes.
- The buyer proxy now treats `model_not_found` responses as routing failures (instead of successes) and refreshes peer discovery metadata in the background, so a stale cached model list recovers quickly after a seller unadvertises a model.

- Added buyer-initiated cooperative channel close (`CloseChannelRequest`/`CloseChannelResult`, message types 0x59/0x5A), so a buyer can get its reserved USDC released immediately instead of waiting out the on-chain `request-close` → 15-minute grace → `withdraw` flow. The seller closes on-chain and returns the transaction hash. It refuses while it is still mid-accumulation with that buyer — a billable request in flight (`busy`), or served work the buyer hasn't signed for yet (`pending_auth`, sent alongside a `NeedAuth` for the outstanding amount) — leaving the channel untouched so the buyer can retry or fall back to the timeout path.
- The buyer attaches its latest SpendingAuth by default; the seller closes at whichever cumulative is higher (its own or the buyer's), so a seller that lost the last authorization can still be paid in full, and a buyer cannot use this path to settle below what it owes.
- Added `antseed buyer channels close <channelId>` (with `--no-auth` and `--json`), which runs the request through a running `antseed buyer start` daemon's live seller connection via the new `/_antseed/channels/close` control-plane endpoint.
- Added `AntseedNode.requestChannelClose(peerId, opts)` to `@antseed/node`, plus the `payments.cooperative-close.v1` capability advertised in discovery metadata and the connection handshake.
- Added buyer peer health cooldowns, so a seller that stops responding is temporarily deprioritized by automatic routing instead of being selected again on every request. Cooldowns escalate from 30 seconds to a maximum of 8 minutes, are cleared by any response from the peer, and are advisory only — a pinned or explicitly named peer is always still dispatched to. Exposed over the buyer control plane as `GET /_antseed/peer-health` and `POST /_antseed/peer-health/clear`.
- Added automatic peer failover for Desktop chats using automatic routing: when the bound peer stops responding, the retry moves to the next-best healthy peer and the chat reports which peer it switched to. Chats pinned to a peer by hand always keep that peer.
- Added fault attribution to request failures (`AntseedRequestError`, `faultAttributionOf`) so proven buyer-side problems such as empty deposits, chain authorization RPC failures, or a closed local transport are reported as buyer faults with HTTP 503 instead of being reported as peer failures with HTTP 502.

### Changed

- Set generated model metadata for supported connected tools and CLI wrappers to a 280,000-token context window, with an 8,192-token output limit where the tool supports one.

### Changed

- Website docs and integration pages now use open-source models actually live on the network (`deepseek-v4-flash`, `kimi-k2.6`, `minimax-m2.7`, `gpt-oss-120b`, `glm-5`, `flux.1-schnell`) in every example instead of closed models, and show the `<peerId>@<model>` routing form in every tool section (Claude Code, Codex, OpenCode, curl, images, SDK integrations). The Using the API guide also gained previously undocumented material: `/v1/models` and `/v1/messages/count_tokens` endpoints, pin-mechanism precedence, the protocol-translation matrix and its limits, response telemetry headers (`x-antseed-estimated-cost-usd`, token counts, peer attribution), a buyer error catalogue, and the `/_antseed/*` health endpoints.

- The default Base mainnet RPC changed from publicnode to Tenderly's public gateway (`base.gateway.tenderly.co`), with fallbacks drpc → nodies → `mainnet.base.org`. publicnode now rejects archive-depth requests on its free tier with a 403 ("Archive requests require a personal token"), which broke commands like `antseed <role> emissions claim`; llamarpc was dropped as unreliable. The seller-start public-RPC warning still recognizes the removed hosts for users who have them saved in config.
- diemantseed.com: eligible $ANTS incentives are now claimed directly from the staking page's Claim tab (same wallet, per completed epoch) instead of requiring the desktop app; the claim banner, how-it-works steps, and FAQ were updated to match. Desktop download links and copy now use the current VPR branding (formerly AntStation). Failed wallet transactions show the concise error message instead of the full request dump.
- Removed the DIEM claim flow from the desktop app and payments portal now that DIEM staking $ANTS are claimed on diemantseed.com: the VPR Rewards view no longer shows the "DIEM staking rewards" card, the portal's DIEM claim page is gone, and legacy `diem-rewards` portal links fold into the network-rewards claim page.
- Desktop: redesigned the Add Credits chooser. The Fun checkout is now a "Deposit" row ("Powered by fun.xyz") showing the accepted card networks (Mastercard, Apple Pay, Google Pay, Visa), the USDC-on-Base quick deposit is always visible with a note that the AntSeed relayer network credits it, and the Meridian option moved behind "More options" as "Deposit using Meridian". Payment and chain badges now use the official brand logos, and the primary CTA follows the app theme (dark surface in light mode, light surface in dark mode).
- Desktop: the Fun checkout's sign-in and payment popups (Google sign-in, card checkout pages) now open as app-owned windows instead of tabs in the default browser, and close automatically once the sign-in completes or the purchased USDC arrives at the wallet. Popups from those pages carry a standard browser user agent so Google no longer rejects the embedded sign-in, and the desktop IPC bridge is only exposed to the app's own pages, never to third-party checkout content.

### Fixed

- Fixed image SpendingAuth service attribution when a budget/headroom authorization races ahead of the delivered response. Headroom-only messages no longer consume the request accounting slot, and the eventual image charge is attributed exactly once to the requested service with one request and zero synthetic text tokens.
- OpenAI-compatible sellers now recognize Venice image-generation model families such as Flux, Qwen Image, Nano Banana, Recraft, Seedream, and Krea as `openai-images` services, so they advertise image output capabilities and route through image endpoints instead of Chat Completions.
- Fixed three "Read more in the docs" links in the desktop VPR Help view opening 404 pages (`/docs/getting-started/intro`, `/docs/getting-started/configuration`, `/docs/guides/pricing`). They now point at the docs' published slugs (`/docs/`, `/docs/config`, `/docs/pricing`).
- Fixed Codex auto-compaction failing on Anthropic-backed routes when the compaction request contained `tool_choice: "auto"` but no tools. Cross-protocol request rendering now omits `tool_choice` whenever no compatible tools remain, preventing LiteLLM and Anthropic from rejecting long-running tasks at the context limit.
- Fixed the desktop VPR floating pill moving away from the pointer and becoming difficult to click. The pill now uses Electron's native window dragging across its passive surface, with dedicated controls for conversations, shrinking, closing, deposits, and compact expansion.
- Fixed the desktop app crashing on launch with `ERR_MODULE_NOT_FOUND: Cannot find package '@antseed/protocol'`: the packaged app was missing the `@antseed/protocol` and `@antseed/buyer-core` workspace packages (split out of `@antseed/node` by the protocol extraction), so the main process could not resolve them from the app bundle. Desktop packaging now bundles both packages and builds them as part of the pre-dist pipeline.
- Fixed buyers classifying unit-billed services (e.g. image generation) as free because their token pricing is zero: the free-usage gate now resolves the same provider + protocol billing route the seller uses, so paid image requests negotiate payment and record verified cost instead of rejecting the seller's usage claims.
- Fixed a payment-integrity hole where a seller could claim image delivery (`NeedAuth` with positive unit billing cost) before the buyer received any response and get paid for undelivered images. Positive unit-billing claims are now rejected until the buyer has observed the delivered response; the buyer's own post-response authorization covers honest sellers.
- Fixed image billing counting placeholder `data` entries as delivered images. Only response items containing a non-empty image URL or base64 payload are billable now.
- Fixed image requests with zero, fractional, or unsafe `n` values suppressing the delivered-image charge; invalid counts now use the Images API default of one, and omitted size/quality values normalize to `auto` for deterministic tier matching.
- Fixed unmatched image billing tiers silently evaluating to zero. Sellers now reject requests they cannot price before forwarding them upstream, and buyers refuse payment authorization without failing the delivered response path if an older or misconfigured seller still returns an unpriceable image response.
- Fixed hybrid token-plus-image `NeedAuth` validation comparing the seller's total request cost against the image-only estimate. Token and unit costs are now recomputed and validated separately before checking the total.
- Fixed seller health checks leaving rate-limited services advertised indefinitely. HTTP 429 responses now count toward the failure threshold, and a successful probe automatically restores the service.
- Fixed the buyer proxy leaking `.buyer.state.*.json.tmp` files (each a full discovered-peers snapshot, ~1 MB) when the atomic state-file rename failed — common on Windows while a reader briefly holds `buyer.state.json` open. The rename is now retried, a failed write cleans up its temp file and logs the error instead of dropping the state update silently, and leftover temp files from earlier runs are swept at startup.
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
- Fixed buyer payment negotiation so the preflight deposit-balance read remains advisory: a transient RPC failure no longer aborts an otherwise valid negotiation, while failures from required buyer-side chain operations retain structured buyer-fault attribution.
- Fixed `SellerAuthorizationError` so a peer that is not an authorized operator is distinguishable from a chain RPC that could not be reached; the two cases previously shared one error and could only be told apart by matching the message text.

## 2026-08-06 — Desktop 0.2.3

### Desktop

- `@antseed/desktop@0.2.3`

### Added

- The desktop now shows deposit progress as a fixed banner from any view — received → depositing → credited (with a transaction link), on top of every overlay including the Fun checkout modal — instead of only inside the deposit page. The main-process deposit watcher also keeps running for a while after the deposit page closes (slow background polling, ~30 min, re-armed by activity), so a card/Fun delivery landing after you navigate away is still swept into credits automatically.

### Changed

- The desktop Balance page's two deposit buttons (Credit Card / USDC on Base) are now a single full-width "Add Credits" button opening the Add-credits chooser, and the separate "Pay with card" options page (including the embedded Crossmint checkout) is removed — the Fun-led chooser is the deposit flow. Dropping Crossmint also cuts the renderer bundle roughly in half.

### Fixed

- Packaged desktop builds now ship with the Fun deposit checkout enabled — 0.2.2 resolved the Fun API key only from user config or a runtime environment variable, so the primary Deposit button never appeared for end users.

## 2026-08-06 — Desktop 0.2.2

### Desktop

- `@antseed/desktop@0.2.2`

### Added

- The desktop deposit screen now leads with an in-app Fun (fun.xyz) checkout: pay with card/cash or transfer crypto, and the purchased USDC is delivered on Base to the buyer wallet and auto-deposited to credits like any other transfer. Requires a Fun API key (`payments.funkit.apiKey` in the desktop config, or the `ANTSEED_FUNKIT_API_KEY` environment variable) and Base mainnet; otherwise the existing deposit options show unchanged.

### Changed

- The desktop renderer runs on React 19.

## 2026-08-05 — Desktop 0.2.1

### Desktop

- `@antseed/desktop@0.2.1`

### Added

- The desktop release workflow now builds and publishes Linux installers (AppImage + deb, x64 + arm64, each arch on a native runner) alongside macOS and Windows, mirrors them to the rolling alpha release, and the website download CTAs now offer Linux visitors a direct AppImage download for their CPU arch instead of only linking to the releases page.
- The desktop app can now pin a specific seller to an individual chat: each model row in a chat's detail page carries a settings button opening a per-chat seller picker with an auto toggle, and the buyer's conversation records track whether a chat's peer was chosen by the user (`peerSource`) so deliberate picks are never overridden. Pinning a seller for a model (Models page) now also re-points that model's existing auto-routed chats to the chosen seller, and re-pinning a chat to a model respects the model's seller pin instead of always auto-selecting.
- Added a "Show routed peer" preference to the desktop (Preferences → Floating window, default off) that names the seller each chat's requests actually went to next to its model — on the floating pill's chat rows, the Chats page list, and the Home recent-chats card — for verifying where routing really lands.

### Fixed

- Fixed the Linux desktop AppImage aborting at startup with `FATAL:setuid_sandbox_host.cc` on kernels that restrict unprivileged user namespaces (Ubuntu 23.10+, hardened Debian). The app now detects that the Chromium sandbox cannot work in that combination and disables it itself, instead of requiring a manual `--no-sandbox` flag. The `.deb` install is unaffected and keeps the sandbox on.
- The website download buttons now show a Linux (Tux) icon alongside the Apple and Windows glyphs.
- Fixed the desktop's config-patch connect buttons (OpenCode, Codex, Crush, Goose, pi) silently doing nothing for tools installed under WSL. On Windows, connecting one of these tools now detects WSL distros that carry an install, patches the config inside each distro (via `\\wsl.localhost\`), points it at a host the distro can actually reach (the NAT gateway, or `localhost` under mirrored networking), and runs a relay so the loopback-only buyer proxy is reachable from inside WSL. When the tool is found neither natively nor in any WSL distro, the connect now fails with a clear error instead of creating a config directory for a program that isn't installed and reporting success.

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
