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

- Added the model-verification verifier network with a fully transparent audit pipeline (commit → carry → anchor → attest → reveal): whitelisted verifiers probe sellers advertising the same model with fresh numeric probe sets, compare response distributions across the cohort (plus optional KBF references), and attest SAME/DIFF verdicts on-chain — and every audit is publicly recomputable. The probe set is sealed on-chain before any probe is sent (probe-set commitment); before anything is revealed, the verifier anchors every seller answer on-chain via `AntseedVerifierRegistry.anchorExchangeBatch(probeCommitment, records, signingPayloads, recordProbeCounts)`, which takes the full exchange batch as calldata (one `(agentId, requestHash, responseHash, responseAuthSig)` record per signed stealth request, plus each record's exact ResponseAuth signing preimage and probe-bundle size) and recomputes the Merkle root from the records on-chain so the root ↔ data binding is contract-verified. The anchor also VERIFIES EVERY SELLER SIGNATURE ON-CHAIN: each record's `responseAuthSig` must recover — over the EIP-191 digest of `"antseed-data-v1:" || signingPayloads[i]` — to the ERC-8004 owner of the record's `agentId`, and the payload's embedded request/response hashes must match the record, so a verifier can only anchor exchanges the audited seller actually signed (the batch reverts on any bad signature, hash mismatch, or a per-record probe count below 1); each `submitAttestation` verdict must reference an anchored `batchRoot` bound to the same probe commitment; and after attestations land the probe set itself is published on-chain via `revealProbeSet`, a contract-checked sha256 commitment opening that is rejected before any attestation references the commitment. Includes the `AntseedVerifierRegistry` (approvals, probe-set commit-reveal, exchange-batch anchoring, batchRoot-bound attestations, per-(agent,service) and per-agent verification stats, per-epoch audit credits) and `AntseedVerifierRewards` (verification emissions bucket controller; verifiers claim per-epoch ANTS pro rata to credited audits) contracts, the new `@antseed/fingerprints` package (KBF verifier math, cohort consensus, canonical evidence hashing), verifier contract clients plus a TS mirror of the contract's exchange-batch leaf/root computation in `@antseed/node`, and the `antseed verifier start|status|claim` CLI commands with a `verifier` config section. After each audit the daemon publishes the full response pack (probe set, exact request/response bytes, signed ResponseAuths, cohort verdicts) under `verifier.publishDir` (default `<dataDir>/verifier/packs/<commitment>.json`); `evidenceHash` in the attestation is the canonical hash of that pack, and `verifier.revealDelayMs` (default 0) can hold the on-chain reveal back after attestations.
- Added `antseed audit verify <txHashOrCommitment>`: third-party recomputation of any completed audit from public data. Given an RPC URL and the verifier address, it fetches the anchored exchange calldata and the revealed canonical probe-set JSON from chain, recomputes the batch Merkle root against the anchored `batchRoot`, checks the sha256 commitment opening, and — with `--pack <path|url>` pointing at the published response pack — verifies every seller-signed ResponseAuth against the pack's request/response plaintexts, re-extracts answers with the fingerprints parser, re-runs the cohort/KBF grading over the revealed probe definitions, and reports whether each recomputed per-seller verdict matches the on-chain attestation, exiting non-zero on any mismatch. A verifier's verdict is therefore never a trust-me claim: fabrication is publicly disprovable (seller signatures are anchored before reveal) and a wrong verdict is demonstrable by anyone.
- Added per-(peer, model) verification reputation: buyers enrich discovered peers with on-chain verification stats and a locally-computed authenticity score (`PeerInfo.modelVerification`), so routers can avoid sellers flagged for model substitution. Added `AntseedVerifierPointsPolicy`, a swappable recognized-usage points policy that zeroes (or partially discounts) a seller's usage-emission points while it carries a DIFF substitution flag, wireable via `AntseedUsageAccounting.setPointsPolicy`. The penalty is corroborated and reversible: it fires only while at least `minDistinctDiffVerifiers` (default 2) distinct verifiers' latest verdicts are DIFF (`activeDiffVerifierCount` in the registry), so one mistaken or malicious verifier cannot permanently zero a seller, and accusers re-attesting SAME retract their standing DIFF.
- Added buyer-delegated probe execution to the verifier network so probe traffic originates from organic buyer identities instead of the publicly-whitelisted verifier wallet (which cheating sellers could classify and special-case). Verifiers with `verifier.delegation.enabled` announce a `verification.probe-delegation.v1` capability on the DHT and dispatch fully verifier-crafted probe jobs over a new delegation protocol (message types 0x90–0x96); opt-in buyers with `buyer.delegate.enabled` relay those jobs byte-for-byte over their ordinary paid buyer path after checking the verifier against the on-chain whitelist. Job placement is target-solicited: before assigning jobs the verifier asks each connected delegate which sellers of the audited service that delegate already uses (`TargetQuery`/`TargetSuggestion`, message types 0x95/0x96, answered from the delegate's local routing history with a 10 s collection timeout) and prefers assigning a seller's probes to a delegate that suggested it — the probe then travels a buyer→seller relationship that predates the audit — falling back to ordinary assignment for sellers no delegate suggested. Delegates are untrusted transport: the verifier re-verifies each seller-signed ResponseAuth against the exact request it crafted and the response body returned, so a delegate can drop a job but never alter or fabricate an observation, and suggestions are advisory placement hints that never influence probe content.
- Added delegate crediting and rewards, credited entirely on-chain at anchor time (no off-chain voucher). Because `anchorExchangeBatch` verifies each seller-signed ResponseAuth on-chain, the buyer named inside every verified payload accrues delegate credits right there — the verifier signs and sends nothing (`DelegateVoucher`, message type `0x94`, is retired and its type id reserved). A carrier discovers its accruals trustlessly from the `DelegateCreditsAccrued(verifier, probeCommitment, buyer, agentId, serviceHash, credits)` event — the buyer is an indexed topic, so its worker `queryFilter`s the log for its own address from a persisted block cursor and records the accruals in `delegate/credits.json`. The buyer's deposits operator lists them with the new `antseed delegate credits` command and claims them with `antseed delegate claim` — which calls `AntseedVerifierRegistry.claimDelegateCredits(verifier, probeCommitment, buyer, agentId, serviceHash)` per accrual, then collects any finalized delegate ANTS rewards. The contract enforces what the old verifier-submitted `creditDelegates` flow only promised off-chain: the caller must be the operator registered for the buyer in `AntseedDeposits` (resolved at claim time — the buyer hot wallet never receives funds), a buyer's claimable credits are capped PER AUDITED TARGET by the `probeCount` of the verifier's credited attestation of that exact (agentId, service) on the commitment (so grants are backed by real, cooldown-limited, commit-reveal audit work on the target the buyer actually carried, and carriers of one target can never drain the budget another target's attestation minted), and per-verifier epoch grant caps still apply; a clamped remainder stays claimable later. Every anchored request hash is also recorded in a global on-chain registry (`anchoredExchangeBy`) — a seller-signed exchange is anchorable exactly once network-wide, so a witnessed exchange cannot be re-anchored under other commitments or by other verifiers to multiply accrual. `AntseedVerifierRewards` splits the verification emissions bucket into verifier and delegate pools by `delegateShareBps` (default 20%, applied only to epochs with delegate credits, frozen with the budget at first touch); operators collect via `claimDelegateReward`. `buyer.delegate.payoutAddress` config is removed — there is nothing to configure or assert anymore.
- Added a stealth probe engine to `@antseed/fingerprints`: verifier probe requests are generated to read like organic user chat (varied framings and phrasing, 1–3 facts per message, free-text numeric answer extraction) instead of a recognizable numbered test battery, so a cheating seller cannot cheaply classify and special-case probe traffic. The stealth/cost trade-off is tunable via `verifier.maxProbesPerRequest`.
- Added a pluggable `ProbeSource` with LLM probe authoring as the verifier daemon's default when `verifier.upstream` is configured (`probeSource: "llm"`): an upstream frontier model authors ~2× candidate numeric-answer probes per audit as strict JSON, every candidate is validated mechanically (cloze template shape, finite numbers, sane range/tolerance, a banned volatile-fact screen against time-varying answers — validation helpers live in `@antseed/fingerprints`), deduplicated against the rotation log, and certified through the existing reference machinery (temperature-consistency filtering plus hold-out self-error), so the per-audit probe burn from on-chain reveal is a generated operating cost rather than the exhaustion of a finite bank. A compositional entity/attribute generator (hundreds of thousands of probes) is the upstream-less fallback and the static probe bank remains a test/bootstrap fixture; per-service probe rotation guarantees probes revealed by past audits are never reused. `verifier` config fields: `probeSource` (`"llm"` | `"compositional"` | `"bank"`), `probeAuthorModel` (optional authoring-model override), `probeRotationHistory`, `probeLogDir`.
- Made `antseed verifier start` work with zero configuration: the daemon (already a full buyer node) now auto-discovers every service advertised on the network from one wildcard peer discovery per round when `verifier.services` is empty, tracks the per-epoch audit budget across services, and audits services with a certified KBF reference down to a single seller (cohort consensus still requires `cohortMinSize` sellers when no reference exists).
- Added KBF reference enrollment: `antseed verifier reference build --model <id>` enrolls a model through a trusted OpenAI-compatible upstream (canonical provider, OpenRouter, or local open-weights deployment) following the published KBF protocol (arXiv:2605.29524) — consistency filtering across temperatures certifies stable probes and a hold-out pass measures the reference's own error rate. With `verifier.upstream` configured (`baseUrl`, `apiKey`/`apiKeyEnv`, optional `modelMap`), the daemon enrolls references automatically for discovered services that lack one, and warns when a reference is older than 7 weeks (published probe-staleness window).
- Rebuilt `@antseed/fingerprints` deterministic randomness on standard primitives: RFC 5869 HKDF-SHA256 seed derivation with domain separation, a NIST SP 800-90A HMAC_DRBG (SHA-256) stream, unbiased rejection-sampled draws, and Fisher–Yates shuffling (replacing the ad-hoc sha256+mulberry32 PRNG); commitment nonces are now HKDF-derived and canonical JSON hashing is documented against RFC 8785 (JCS). Probe selection, stealth request phrasing, and evidence hashes change accordingly (pre-release wire-format change).
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

- Hardened the verifier network's commit-reveal and evidence trail: probe-set commitments now bind the complete probe definitions (templates, expected answers, ranges, tolerances) instead of probe ids only, so scoring criteria cannot be altered after observing seller responses, and the published response packs embed the full signed ResponseAuth payloads plus exact request/response bytes so any third party can re-verify every observation offline (pre-release wire-format change: probeSetId, commitments, nonces, and evidence hashes all change).
- Hardened verifier daemon cost control: hard per-epoch caps on attempted audits (independent of credited attestations), exponential per-seller backoff for sellers that repeatedly fail to produce credited audits, enforcement of the on-chain `minProbeCount` before any commit or probe spend, rotation-pool recycling instead of permanent audit failure, per-round policy refresh, bounded-backoff retry on transient RPC outages, and probe requests that preserve the seller's advertised model spelling.
- Hardened buyer-delegated probing: delegate workers re-check the verifier whitelist on a TTL (revoked verifiers are dropped mid-session), abort abandoned jobs end-to-end, enforce a strict probe-job schema (model must match the audited service, streaming refused, response caps), fail closed on stop, and discover credit accruals from a persisted block cursor so log scans are incremental across restarts; delegation hosts cap connected delegates and delegates reject jobs until a welcome is accepted.
- Changed buyer routing to exclude sellers carrying an active (unretracted) model-substitution flag for the requested service, falling back to the agent-wide aggregate: the CLI/Desktop buyer proxy — which routes pinned-peer-only — now refuses to dispatch to a flagged peer, including an explicitly pinned one, until every accusing verifier retracts (`/v1/models` listing stays exempt so flagged peers remain inspectable), and `DefaultRouter` drops flagged peers from selection. Retracted DIFFs downgrade to a history signal, per-(peer, model) verification stats persist in `buyer.state.json` so the gate keeps working from the warm cache across restarts, `findPeer` and incremental background discovery carry the same verification enrichment as full discovery, and delegation hosts are discoverable via their capability DHT topic.
- Changed verifier CLI configuration to strict validation: malformed `verifier` config values (e.g. non-string `services` entries, mistyped `upstream`) now fail startup instead of being silently dropped, numeric flags like `--interval` reject non-integer values, `--api-key` takes precedence over config `apiKeyEnv`, custom bootstrap nodes merge with (not replace) official ones, and reference enrollment rejects references whose hold-out self-test lacks discriminating power.
- Changed automatic reference enrollment to send the seller's advertised model spelling upstream (with `verifier.upstream.modelMap` keys matched against the advertised, normalized, or any case-insensitive form), so mixed-case models like `Qwen/Qwen3-32B` enroll against case-sensitive upstreams instead of 404ing every batch and permanently suppressing retries.
- Verifier and delegate reward claiming is fault-isolated per epoch, so one reverting epoch no longer blocks every later one.
- Added `AntseedVerifierRegistry.clearVerifierStanding`, an owner-only remediation that retracts a specific verifier's standing DIFF for an (agent, service) — de-whitelisting alone could not clear standing accusations, so two rogue verifiers could otherwise zero a seller's recognized-usage emissions permanently.
- Changed API adapter streaming transforms to use canonical stream events with per-protocol normalizers and renderers, so new stream protocols can be added without pairwise routes.
- Changed Desktop renderer navigation to load only the active view, preload likely next views, and show a lightweight loading state while lazily loaded pages resolve.
- Reduced the default buyer response-auth evidence sample rate from 20% to 0.5% to limit local `verification_samples` growth during high-request sessions.
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
