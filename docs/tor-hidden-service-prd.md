# PRD: Tor Hidden Service Mode For AntSeed

- Status: Draft
- Date: 2026-02-26
- Owner: Networking/CLI
- Target: `@antseed/node`, `@antseed/cli`, `@antseed/desktop`, protocol docs

## 1. Summary

Add a first-class Tor hidden-service networking mode so sellers can accept inbound connections without exposing their direct IP address.  
In this mode, inbound traffic must terminate at a `.onion` service, and AntSeed must not rely on public UDP DHT announcement/discovery.

This PRD defines product behavior, security guarantees, implementation modules, compatibility strategy, rollout phases, and edge-case handling.

## 2. Problem

Current behavior is optimized for public internet reachability:

- Seller listener binds to `0.0.0.0` in `packages/node/src/node.ts`.
- Seller auto-attempts NAT traversal and public port mapping in `packages/node/src/node.ts`.
- Discovery uses BitTorrent DHT over UDP in `packages/node/src/discovery/dht-node.ts`.
- Buyer resolves metadata and signaling via direct host/port in `packages/node/src/discovery/http-metadata-resolver.ts` and `packages/node/src/p2p/connection-manager.ts`.

This creates two blockers for IP privacy:

- DHT announce leaks source IP by design.
- Inbound reachability uses direct socket/NAT mapping rather than onion routing.

## 3. Goals

1. Sellers can run in a mode where inbound connections never target their direct IP.
2. Buyers can discover and connect to those sellers through Tor-compatible paths.
3. Existing public-network mode remains intact and default.
4. Protocol/auth guarantees remain intact (signed metadata, peer auth).
5. The feature is PR-able in phases (MVP first, then richer discovery).

## 4. Non-Goals

1. Full network anonymity for all layers (payments/on-chain identity may still be linkable).
2. Hiding outbound network usage from local OS/network administrators.
3. Replacing existing public DHT mode.
4. Implementing a new decentralized UDP-over-Tor transport.
5. Solving anti-global-adversary threat models.

## 5. User Stories

1. As a seller, I can start seeding behind Tor so buyers only connect through a `.onion` endpoint.
2. As a buyer, I can connect to Tor-only sellers without direct TCP to seller public IPs.
3. As an operator, I can choose public mode, Tor mode, or explicit mixed mode with clear guardrails.
4. As a maintainer, I can review and merge this incrementally with tests and no regression to existing users.

## 6. Privacy/Security Requirements

### 6.1 Hard requirements in Tor mode

1. Seller signaling listener must bind to loopback (`127.0.0.1`) only.
2. NAT traversal must be disabled.
3. DHT announce/lookup must be disabled (no UDP discovery).
4. Outbound buyer connections to `.onion` must go through Tor SOCKS.
5. WebRTC path must be disabled in Tor mode to avoid ICE/STUN leaks and UDP dependency.
6. No silent fallback to direct clearnet unless explicitly enabled by user.

### 6.2 Metadata integrity requirements

1. Advertised endpoint(s) used for connection must be covered by signed metadata.
2. Buyer must verify metadata signature before using endpoint data.
3. Tor mode should reject unsigned/invalid endpoint hints.

## 7. Product Requirements

### 7.1 Modes and config model

Introduce explicit network profile:

- `public` (default): current behavior.
- `tor-hidden-service`: Tor-safe behavior.

Add `network.tor` config block (CLI config + NodeConfig projection):

- `enabled: boolean`
- `socksProxy: { host, port }` default `127.0.0.1:9050`
- `controlPort: { host, port, passwordEnv? }` optional for managed onion service
- `hiddenService:`
  - `mode: "manual" | "control-port"`
  - `onionAddress` (required in `manual`)
  - `virtualPort` (default signaling port)
  - `localAddress` default `127.0.0.1`
  - `localPort` default signaling port
- `discovery:`
  - `mode: "manual" | "manifest"`
  - `manualPeers: string[]` (`peerId@host:port` or `host:port`)
  - `manifestUrl` (supports `http(s)` and `.onion`)
  - `refreshIntervalMs`
- `allowDirectFallback` default `false`

### 7.2 Seller behavior (Tor mode)

1. Start `ConnectionManager` on loopback only.
2. Skip `NatTraversal.mapPorts(...)`.
3. Skip DHT startup + periodic announce.
4. Build metadata including signed endpoint data that contains `.onion` endpoint.
5. If `hiddenService.mode = control-port`, create/refresh hidden service via Tor control API.
6. If `hiddenService.mode = manual`, validate operator-provided onion endpoint format.
7. Print operator guidance and explicit warnings when Tor assumptions are violated.

### 7.3 Buyer behavior (Tor mode)

1. Skip DHT startup + lookup.
2. Resolve candidate endpoints from:
  - manual peer list (MVP),
  - signed manifest source (MVP+).
3. Fetch metadata through Tor SOCKS.
4. Verify metadata signature and endpoint binding.
5. Connect signaling/data path through Tor SOCKS to `.onion`.
6. Force TCP transport path (no WebRTC).

### 7.4 Discovery behavior

Create an endpoint-source abstraction:

- `DhtEndpointSource` (existing public mode).
- `ManualEndpointSource` (MVP Tor mode).
- `ManifestEndpointSource` (MVP+ Tor mode).

Buyer chooses source by profile/mode. Public mode remains unchanged.

### 7.5 CLI/desktop behavior

CLI:

- `antseed seed --tor` (enables Tor profile override at runtime).
- `antseed connect --tor` (same).
- optional flags:
  - `--tor-socks <host:port>`
  - `--tor-control <host:port>`
  - `--onion <addr:port>`
  - `--peer <peerId@addr:port>` (repeatable)
  - `--peer-manifest <url>`

Desktop:

- Add Tor settings in runtime start configuration.
- Persist settings in desktop preferences.
- Validate config before launching process.

## 8. Architecture And Module Plan

### 8.1 `@antseed/node` modules

1. `packages/node/src/tor/tor-config.ts`
2. `packages/node/src/tor/tor-control-client.ts`
3. `packages/node/src/tor/hidden-service-manager.ts`
4. `packages/node/src/tor/socks-dialer.ts`
5. `packages/node/src/discovery/endpoint-source.ts`
6. `packages/node/src/discovery/manual-endpoint-source.ts`
7. `packages/node/src/discovery/manifest-endpoint-source.ts`
8. `packages/node/src/discovery/tor-metadata-resolver.ts`

Integration points:

- `packages/node/src/node.ts` for role startup branching.
- `packages/node/src/p2p/connection-manager.ts` for SOCKS dialing and transport forcing.
- `packages/node/src/discovery/peer-metadata.ts` and codec/validator for endpoint fields.

### 8.2 Protocol changes

Introduce metadata endpoint structure and bump metadata version:

- `METADATA_VERSION: 3`
- Add signed `endpoints` array:
  - `kind: "onion" | "ipv4" | "dns"`
  - `host: string`
  - `port: number`
  - `transport: "tcp"`
  - `priority: number`

Compatibility:

1. New code should parse/accept v2 and v3.
2. Tor mode requires v3 metadata with at least one onion endpoint.
3. Public mode can still consume v2 peers for backward compatibility.

### 8.3 Dependency additions (expected)

Likely add a SOCKS/Tor-compatible client dependency in `@antseed/node`, for example:

- `socks` or `socks-proxy-agent`

Selection criteria:

1. ESM compatibility with Node 20.
2. Works with raw TCP sockets (not only HTTP).
3. Good maintenance and minimal transitive risk.

## 9. Detailed Flows

### 9.1 Seller startup (Tor mode)

1. Validate Tor config.
2. Start local listener on loopback only.
3. Acquire onion endpoint (manual or control-port).
4. Build signed metadata with onion endpoint.
5. Skip DHT/NAT logic.
6. Enter serving state.

Failure handling:

1. If no valid onion endpoint, fail startup hard.
2. If control-port auth fails and no manual fallback, fail startup hard.

### 9.2 Buyer connect (Tor mode)

1. Load endpoints from configured source.
2. Resolve metadata via SOCKS.
3. Verify metadata signature and freshness.
4. Select endpoint by policy (onion preferred/required).
5. Open signaling connection over SOCKS.
6. Proceed with existing auth/frames/payment flows.

Failure handling:

1. If no onion-capable candidate found, fail with actionable error.
2. If SOCKS is unreachable, fail fast with troubleshooting hint.

## 10. Edge Cases And Expected Behavior

1. Tor daemon down: startup/connect fails fast with explicit remediation.
2. SOCKS reachable but control-port unreachable: manual mode can still proceed.
3. Invalid onion hostname format: config validation error.
4. Onion service exists but not yet propagated: retry with backoff; surface status.
5. Manifest source stale/unreachable: use last good cache if policy allows; otherwise fail.
6. Metadata signature valid but endpoint missing onion in Tor mode: reject peer.
7. Buyer in Tor mode receives public IPv4 endpoint only: reject unless `allowDirectFallback=true`.
8. Seller in Tor mode accidentally sets `0.0.0.0`: hard fail with guardrail.
9. WebRTC/native module available: still force TCP in Tor mode.
10. High latency causes handshake timeout: use Tor-specific higher default timeout profile.
11. Clock skew causing stale metadata false positives: allow configurable skew budget.
12. Mixed fleets (public + Tor peers): routing policy must respect mode and user intent.
13. Payments on-chain correlation risk: warn but do not block.
14. Logging accidentally includes onion/private details: redact sensitive values by default.

## 11. Observability

New runtime events/counters:

1. `tor:socks:connected`
2. `tor:socks:error`
3. `tor:hidden-service:ready`
4. `tor:hidden-service:error`
5. `discovery:endpoint-source:update`
6. `connection:transport-forced` (value: `tcp`)

Metrics:

1. Tor mode startup success rate.
2. Metadata resolution success rate via Tor.
3. Connection success latency p50/p95 in Tor mode.
4. Session failure causes in Tor mode.

## 12. Testing Strategy

### 12.1 Unit tests

1. Tor config validation and normalization.
2. Onion endpoint parsing/validation.
3. Metadata v3 encode/decode/sign/verify.
4. Endpoint-source resolution logic.
5. Tor-mode guardrails (`no DHT`, `no NAT`, `loopback bind`, `force TCP`).

### 12.2 Integration tests

1. Buyer/seller with mocked SOCKS server and manual endpoint source.
2. Ensure connection-manager uses SOCKS dialer path for `.onion`.
3. Ensure no DHT/NAT side effects in Tor mode.

### 12.3 E2E tests

1. Local Tor process/container:
  - start seller in Tor mode,
  - connect buyer in Tor mode,
  - perform request/response through proxy,
  - verify successful metering/payment path.
2. Verify listener bind address remains loopback.

## 13. Rollout Plan

### Phase 1: Core Tor MVP (recommended first PR)

1. Config + profile plumbing.
2. Seller loopback-only mode, no DHT/NAT.
3. Buyer manual peer list + SOCKS connect.
4. Force TCP transport in Tor mode.
5. Basic CLI flags (`--tor`, `--peer`, `--onion`).

### Phase 2: Metadata v3 + endpoint signing

1. Metadata endpoint schema.
2. Backward-compatible parser.
3. Tor-mode strict endpoint validation.

### Phase 3: Manifest discovery + desktop UX

1. Manifest endpoint source.
2. Desktop settings UI/launch options.
3. Observability polish and docs.

## 14. Backward Compatibility

1. Default behavior remains `public`.
2. Existing `seed`/`connect` invocations continue unchanged.
3. Public DHT workflow remains supported.
4. Tor mode is opt-in and isolated by profile.

## 15. Risks

1. Tor operational complexity increases support burden.
2. Performance may degrade from Tor latency.
3. Incorrect fallback policy may silently leak direct IP paths.
4. Metadata version migration may fragment peers if not staged carefully.

Mitigations:

1. Clear guardrails and fail-closed defaults in Tor mode.
2. Explicit diagnostics and docs.
3. Staged rollout with compatibility tests.

## 16. Acceptance Criteria

1. In Tor mode seller does not bind external interfaces (`lsof`/runtime check passes).
2. In Tor mode seller does not start DHT and does not execute NAT mapping.
3. Buyer can complete request flow to Tor-mode seller using only onion endpoint.
4. Tor mode does not silently fallback to direct IP unless explicitly configured.
5. Existing public mode behavior/tests remain green.

## 17. Implementation Checklist (for PR series)

1. Add config types/defaults/validation for Tor profile.
2. Add node startup branching for Tor vs public.
3. Add SOCKS dialer path in connection manager.
4. Add endpoint-source abstraction and manual source.
5. Add CLI flags and plumbing into `AntseedNode` config.
6. Add metadata v3 endpoint signing (phase 2).
7. Add tests for guardrails and flows.
8. Update protocol docs (`01-discovery.md`, `02-transport.md`) after merge.

## 18. Open Questions

1. Should Tor mode ever permit mixed endpoint advertisements (`onion + public`)?
2. Should manifest discovery be signed by peer keys, operator key, or both?
3. Do we support ephemeral onion services in MVP, or require manual onion first?
4. What timeout defaults should be profile-specific for Tor (lookup/connect/handshake)?
5. Should desktop expose advanced Tor controls or only a simple on/off + proxy fields?
