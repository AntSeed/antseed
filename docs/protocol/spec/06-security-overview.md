# 06 - Security Overview (Buyer-Seller Flow)

This document provides a system-level security overview of the buyer-seller flow implemented in `@antseed/node`.

It covers:

- Threat model and trust boundaries
- Transport, discovery, and payment controls
- Residual risks and hardening priorities

> **Implementation status (2026-03-01):** This overview maps to the current `packages/node` buyer/seller flow, including DHT discovery, P2P transport, proxy framing, metering receipts, and escrow integration paths.

## 1. Security Objectives

The buyer-seller flow is designed to preserve:

1. **Peer authenticity**: peers should be able to verify who they are talking to.
2. **Metadata integrity**: discovery metadata should be signed and freshness-checked.
3. **Bounded resource usage**: malformed or abusive traffic should be capped and rejected early.
4. **Billing accountability**: usage and settlement should be auditable via signed artifacts and on-chain state.
5. **Deterministic failure behavior**: timeout and disconnect paths should fail closed without hanging sessions.

## 2. Trust Boundaries and Assets

| Boundary | Trusted by default? | Security-relevant assets | Primary risks |
|---|---|---|---|
| Local node process | Yes (operator-controlled) | Identity key, session state, metering DB, wallet signer | Host compromise, key exfiltration |
| DHT network | No | Peer endpoints and topic results | Poisoned discovery, Sybil flooding |
| Metadata fetch channel | No | Signed peer metadata payload | Tampering, stale replay, endpoint spoofing |
| P2P transport (WebRTC/TCP) | Partially | Request/response frames, payment frames | MITM, malformed frames, DoS |
| On-chain escrow | Trust minimized to contract + chain consensus | Session locks, disputes, settlement balances | ABI drift, signer misuse, contract misconfiguration |

## 3. Buyer -> Seller Flow and Controls

### 3.1 Discovery and Metadata Resolution

**Threats**
- Topic fragmentation and lookup misses due to inconsistent model naming.
- DHT poisoning with private IPs, duplicate endpoints, or stale metadata.
- Forged metadata claims.

**Controls**
- Topic normalization enforces `trim + lowercase`; model search topics also remove spaces, `_`, and `-` for compact lookup keys.
- Buyer lookup uses both canonical and compact model topics when they differ.
- Private/loopback IPs are filtered by default (`allowPrivateIPs=false`).
- Metadata signature verification is enabled by default (`requireValidSignature=true`).
- Metadata freshness is checked (`allowStaleMetadata=false`, max age 30 min).
- Endpoint deduplication and parallel resolution prevent bad endpoints from blocking good ones.
- Metadata HTTP fetch includes timeout and failure cooldown caches to suppress repeated retries.

### 3.2 Connection Establishment and Peer Authentication

**Threats**
- Spoofed intro/hello messages.
- Replay of previous intro envelopes.
- Inbound socket flood during handshake.

**Controls**
- Initial wire messages include signed auth envelopes (`peerId`, timestamp, nonce, signature).
- Timestamp skew checks (`INTRO_AUTH_MAX_SKEW_MS = 30s`) reject stale/future envelopes.
- Nonce replay guard tracks seen nonces and rejects replays.
- Inbound initial line is limited (`8KB`) and timed out (`10s`).
- ConnectionManager limits inbound pressure with `server.maxConnections = 256` and per-IP connection cap (`10`).
- Signaling parser caps buffered signaling data (`64KB`).

### 3.3 Framing, Proxy Transport, and Stream Safety

**Threats**
- Oversized frames and malformed payloads.
- Long-running or stalled streams consuming memory.
- Large upload bodies causing memory pressure.

**Controls**
- Frame decoder validates message type and payload length (`MAX_PAYLOAD_SIZE = 64 MiB`).
- Decode/dispatch errors fail the underlying connection, preventing partial undefined state.
- Request timeout defaults to 30s; stream idle timeout is enforced and reset on every chunk.
- Streaming responses are bounded by max wall duration (`maxStreamDurationMs`, default 5 min).
- Streaming body buffering is capped (`maxStreamBufferBytes`, default 16 MiB).
- Chunked upload handling enforces:
  - per-request cap (default 32 MiB),
  - global pending upload cap (default 256 MiB),
  - upload timeout (default 120s),
  - explicit abort with 413/408 and buffer zeroing.
- Pending upload buffers are zeroed on completion, abort, and connection teardown.

### 3.4 Request Routing and Metering Path

**Threats**
- Unpaid request execution when escrow is enabled.
- Session desynchronization on disconnects.
- Cost disagreement due to weak metering signals.

**Controls**
- Seller rejects inference requests with `402` when escrow is configured and lock is not committed.
- Session state is tracked per buyer connection and finalized on disconnect, idle timeout, or shutdown.
- Metering events and signed receipts are persisted locally with append/update semantics.
- Seller emits bilateral receipts after each request and tracks `runningTotal`, `ackedRequestCount`, and `lastAckedTotal`.
- Buyer acks receipts with Ed25519 signatures (auto-ack optional but enabled by default).

### 3.5 Payment Authorization, Settlement, and Disputes

**Threats**
- Forged lock/top-up/settlement authorizations.
- Ghost buyer disconnect after consuming work.
- Nonce collisions or transaction-order races.

**Controls**
- Buyer authorizes lock and top-up with ECDSA signatures over deterministic message hashes.
- Seller recovers buyer address from lock signature before on-chain commit.
- Buyer and seller exchange Ed25519-signed running-total artifacts off-chain.
- Session end settlement submits buyer ECDSA authorization plus score.
- On buyer disconnect with committed lock:
  - seller opens dispute with `lastAckedTotal` when available,
  - otherwise uses `runningTotal`,
  - or waits for natural expiry if no work done.
- Escrow client reserves nonces from pending count and maintains a per-address nonce cursor to avoid local tx nonce reuse.

## 4. Cryptographic Control Plane

| Use case | Primitive | Scope |
|---|---|---|
| Node identity | Ed25519 keypair | Peer ID and metadata signing |
| Connection auth envelope | Ed25519 signature + nonce + timestamp | Prevent spoofing and replay in intro/hello |
| Metadata integrity | Ed25519 signature over encoded metadata | Verify discovery payload authenticity |
| Payment auth (on-chain) | ECDSA over typed hashes | Lock, top-up, settlement authorizations |
| Receipt/ack integrity | Ed25519 binary message signatures | Running-total acknowledgment trail |

## 5. Operational Baseline (Recommended)

1. Keep `allowPrivateIPs=false` in production.
2. Keep metadata signature verification enabled and stale metadata disabled.
3. Keep upload/stream caps at defaults or stricter limits for internet-facing sellers.
4. Prefer WebRTC transport when available; treat TCP fallback as untrusted network transport.
5. Use dedicated wallets for escrow operations and monitor dispute/settlement events.
6. Persist and back up metering/payment state for audit and incident reconstruction.
7. Run periodic compatibility checks that contract ABI and client expectations match.

## 6. Residual Risks and Priority Hardening

1. **TCP fallback confidentiality**: TCP fallback provides authentication but not transport encryption.
2. **Metadata transport confidentiality/integrity in transit**: metadata fetch uses plain HTTP; payload signature protects integrity, but not privacy or traffic analysis.
3. **Metadata schema enforcement gap**: `validateMetadata()` exists but lookup currently enforces signature+freshness only.
4. **Session cardinality limits**: current in-memory maps are keyed by peer ID (`buyerPeerId` or `sellerPeerId`), which limits concurrent parallel sessions per counterparty.
5. **Heuristic metering**: current token accounting uses byte-based estimation (`~4 chars/token`), not provider-native tokenizer attestations.
6. **Contract/client drift risk**: escrow client ABI expectations and contract artifacts must remain synchronized; drift can break settlement safety.

## 7. Security Review Checklist

Use this checklist before shipping buyer/seller flow changes:

1. Are new P2P message types bounded by payload size and decode validation?
2. Are all new session transitions fail-closed on timeout/disconnect?
3. Are all payment-critical values signed and re-verified at each trust boundary?
4. Are lookup/discovery changes preserving signature verification and staleness checks?
5. Are DoS guards (size/time/concurrency) present for any new stream or upload path?
6. Are contract ABI changes covered by integration tests against the exact deployed artifact?
