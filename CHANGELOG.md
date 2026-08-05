# Changelog

All notable user-facing changes to AntSeed packages are documented here.

This project uses selective package publishing. Each release entry lists the published packages affected by that release.

## Unreleased

### Published

- `@antseed/api-adapter`
- `@antseed/cli`
- `@antseed/fingerprints`
- `@antseed/node`

### Desktop

- `@antseed/desktop`

### Added

- Added `antseed verifier reference build <model>` and buyer-proxy-only `antseed verifier run <model>`. Reference creation is explicit; runs load powered references selected adaptively from 100 through 500 probes, read peers from the running buyer, pin every probe request through its local proxy, and write proxy-observation evidence without requiring a separate verifier identity or deposit.
- Added a direct final-attestation `AntseedVerifierRegistry` API with compact metric events, hash-committed evidence, latest and historical routing state, per-service and per-agent verdict counters, seller points penalties controlled by the latest conclusive audit, and an owner-configurable 100-credit verifier epoch cap. Valid attestations beyond the cap still update verification history and penalties.
- Added service-weighted verifier penalties: `submitVerificationResult` accepts the audited model's seller-volume share, rejects epoch rollover, and permits zero-share `DIFF` records without a points penalty.
- Added verifier-only `AntseedVerifierRewards`, allocating the entire verification emissions bucket pro rata by epoch credits and freezing the epoch budget and credit denominator on first claim or zero-credit remainder settlement.
- Added canonical local proxy-observation evidence containing reference data, pinned request/response hashes, match vectors, statistical power, and verdicts. It explicitly contains no `ResponseAuth` or payment evidence, and workflow state uses JSON artifacts rather than verification database tables.
- Added a target-driven KBF reference builder that generates candidate rounds until enough stable probes distinguish the reference from at least one configured contrast, records accurate per-contrast subsets, deduplicates candidates, grows self-tested prefixes by ten until statistical power reaches 90%, and atomically replaces one JSON reference file.
- Added lightweight reference-build resilience: endpoint/model preflight, cached request checkpoints with compatibility invalidation and restart reuse, transient retry/backoff, a hard physical-request budget, global and per-model concurrency limits, adaptive throttling after `429`, and bounded no-progress termination.
- Added per-(peer, model) verification reputation so buyers can incorporate on-chain verification history into local routing and authenticity scoring.
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

- Changed reference generation to use the canonical KBF domain registry with
  deterministic code-owned ranges and tolerances instead of LLM-authored
  scoring policy. Mathematics uses the public KBF domain's exact-match
  tolerance; existing references and checkpoints must be rebuilt.
- Changed KBF audits to use the paper's fixed reference denominator: missing,
  malformed, non-finite, out-of-range, and valid-but-nonmatching answers from
  completed responses count as discrepancies. Only exhausted transport retries
  produce `UNDETERMINED`, and OpenAI Responses SSE bodies are decoded even when
  a peer streams despite `stream: false`.
- Changed buyer discovery to load each seller's verifier attestations once and derive verification lifecycles for every advertised service. `DefaultRouter` excludes suspended services and deprioritizes flagged services during automatic selection, while explicit peer pins remain authoritative. `findPeer` and incremental background discovery use the same enrichment as full discovery.
- Changed verifier configuration to accept evidence/reference directories, request timeout, trusted reference endpoint/model mapping, and bounded reference-build retry, request-budget, progress, concurrency, and adaptive-sizing controls.
- Verifier reward claiming is fault-isolated per epoch, so one reverting epoch no longer blocks every later one.
- Changed API adapter streaming transforms to use canonical stream events with per-protocol normalizers and renderers, so new stream protocols can be added without pairwise routes.
- Changed Desktop renderer navigation to load only the active view, preload likely next views, and show a lightweight loading state while lazily loaded pages resolve.
- Increased the default free-usage on-chain record flush interval from 10 seconds to 5 minutes to reduce background transaction frequency while preserving batch, disconnect, and shutdown flushes.

### Fixed

- Fixed the DIEM staking site so wallet transactions explicitly switch to and execute on Base mainnet instead of following a wallet that remains on Ethereum mainnet.
- Fixed Desktop auto-update failures so download and install errors appear in the title bar with copyable details, and fixed macOS Quit so the first menu action exits after cleanup instead of requiring a second click.
- Fixed buyer response-auth timeout warnings for non-inference probes and sellers that do not advertise response-auth support.
- Fixed buyer discovery so temporarily unreachable metadata endpoints are probed for recovery before the full exponential cooldown expires, allowing recovered peers to reappear in buyer peer lists sooner.
- Fixed Desktop chats for peers that disappear from discovery so the header reports that the peer was not found and disables the composer instead of showing stale peer identifiers.
- Fixed Desktop Discover overflow tag tooltips so the `+N` category indicator works on service cards in the first row.
- Fixed `antseed seller emissions claim` so it only checks and claims seller rewards, leaving buyer rewards to the buyer command.

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
