# 06 - Security Overview (Buyer-Seller Flow)

This document provides a system-level security overview of the buyer-seller flow implemented in `@antseed/node`.

## 1. Security Objectives

The buyer-seller flow enforces:

1. **Peer authenticity** — every node is identified by a unique Ed25519 keypair; all trust-critical messages are signed.
2. **Metadata integrity** — discovery metadata is signed and freshness-checked before use.
3. **Bounded resource usage** — frame sizes, upload caps, stream durations, and connection counts are hard-limited.
4. **Billing accountability** — usage is tracked via bilateral signed receipts and settled through on-chain escrow.
5. **Fail-closed behavior** — timeouts and disconnects deterministically finalize sessions without hanging state.

## 2. Trust Boundaries

| Boundary | Trusted? | Security Assets |
|---|---|---|
| Local node process | Yes (operator-controlled) | Identity key, session state, metering DB, wallet signer |
| DHT network | No — verified via signatures | Peer endpoints and topic results |
| Metadata fetch | No — verified via signatures + freshness | Signed peer metadata payload |
| P2P transport (WebRTC/TCP) | Authenticated via intro envelopes | Request/response frames, payment frames |
| On-chain escrow | Trust-minimized (contract + chain consensus) | Session locks, settlement balances, disputes |

## 3. Buyer → Seller Flow and Controls

### 3.1 Discovery and Metadata Resolution

- Topic normalization (`trim + lowercase`) with compact model-search fallback for consistent lookups.
- Private/loopback IPs filtered by default (`allowPrivateIPs=false`).
- Metadata signature verification enabled by default (`requireValidSignature=true`).
- Metadata freshness checked by default (`allowStaleMetadata=false`, max age 30 min).
- Endpoint deduplication and parallel resolution — one slow endpoint does not block others.
- Metadata HTTP fetch enforces timeout and failure cooldown to suppress retries to bad endpoints.

### 3.2 Connection Establishment and Peer Authentication

- Signed auth envelopes include `peerId`, timestamp, nonce, and Ed25519 signature.
- Timestamp skew checks (`INTRO_AUTH_MAX_SKEW_MS = 30s`) reject stale or future envelopes.
- Nonce replay guard rejects previously seen nonces.
- Inbound initial line limited to `8KB` with `10s` timeout.
- `server.maxConnections = 256`, per-IP connection cap of `10`.
- Signaling parser caps buffered data at `64KB`.

### 3.3 Framing, Proxy Transport, and Stream Safety

- Frame decoder validates message type and payload length (`MAX_PAYLOAD_SIZE = 64 MiB`).
- Decode/dispatch errors fail the connection (fail-closed).
- Request timeout: 30s. Stream idle timeout enforced and reset on each chunk.
- Streaming bounded by max wall duration (default 5 min) and buffer cap (default 16 MiB).
- Chunked uploads enforce per-request cap (32 MiB), global pending cap (256 MiB), timeout (120s), and explicit abort with 413/408 plus buffer zeroing.

### 3.4 Request Routing and Metering

- Seller rejects requests with `402` when escrow is configured and lock is not committed.
- Session state tracked per buyer and finalized on disconnect, idle timeout, or shutdown.
- Seller emits bilateral receipts after each request with `runningTotal` tracking.
- Buyer acks receipts with Ed25519 signatures (auto-ack enabled by default).
- Metering events and signed receipts persisted locally.

### 3.5 Payment Authorization, Settlement, and Disputes

- Buyer authorizes lock/top-up with ECDSA signatures over deterministic message hashes.
- Seller recovers buyer address from lock signature before on-chain commit.
- Buyer and seller exchange Ed25519-signed running-total artifacts off-chain.
- Settlement submits buyer ECDSA authorization plus score.
- On buyer disconnect with committed lock: seller opens dispute using `lastAckedTotal` or `runningTotal`.
- Escrow client maintains per-address nonce cursor to prevent local tx nonce reuse.

## 4. Cryptographic Control Plane

| Use Case | Primitive | Scope |
|---|---|---|
| Node identity | Ed25519 keypair | Peer ID and metadata signing |
| Connection auth | Ed25519 signature + nonce + timestamp | Spoofing and replay prevention |
| Metadata integrity | Ed25519 signature over encoded metadata | Discovery payload authenticity |
| Payment auth (on-chain) | ECDSA over typed hashes | Lock, top-up, settlement authorizations |
| Receipt/ack integrity | Ed25519 binary signatures | Running-total acknowledgment trail |

## 5. Operational Best Practices

1. Keep `allowPrivateIPs=false` in production.
2. Keep metadata signature verification and freshness checks enabled (both on by default).
3. Prefer WebRTC transport for end-to-end encryption.
4. Use dedicated wallets for escrow operations and monitor settlement events.
5. Persist and back up metering/payment state for audit and incident reconstruction.
6. Keep upload/stream caps at defaults or tighter for internet-facing sellers.

## 6. Security Review Checklist

Use this checklist before shipping buyer-seller flow changes:

1. Are new P2P message types bounded by payload size and decode validation?
2. Are all new session transitions fail-closed on timeout/disconnect?
3. Are all payment-critical values signed and re-verified at each trust boundary?
4. Are lookup/discovery changes preserving signature verification and staleness checks?
5. Are DoS guards (size/time/concurrency) present for any new stream or upload path?
6. Are contract ABI changes covered by integration tests against the deployed artifact?
