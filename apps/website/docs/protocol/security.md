---
sidebar_position: 7
slug: /security
title: Security
hide_title: true
---

# Security

AntSeed enforces security at every layer of the buyer-seller flow — from discovery through settlement — without relying on trusted intermediaries.

## Security Model

All communication happens over an untrusted network. Every trust-critical operation is cryptographically verified:

- **Ed25519 peer identity** — every node has a unique keypair; metadata, connection handshakes, and metering receipts are all signed
- **Replay-resistant authentication** — connection envelopes include nonce + timestamp with skew checks
- **Bounded resource usage** — frame sizes, upload caps, stream durations, and concurrent connections are all hard-limited
- **On-chain settlement** — bilateral signed receipts plus ECDSA-authorized escrow operations ensure payment integrity

## Buyer → Seller Flow

| Stage | Controls |
|---|---|
| **Discovery** | Signed metadata with freshness checks, topic normalization for consistent lookup, private IP filtering enabled by default |
| **Connection** | Ed25519-signed intro envelopes with nonce replay guard, timestamp skew rejection, per-IP connection cap (10), inbound line size/time limits |
| **Transport** | Frame type and size validation (64 MiB max), fail-closed on decode errors, request and stream timeouts |
| **Upload/Stream** | Per-request cap (32 MiB), global pending cap (256 MiB), upload timeout (120s), stream buffer (16 MiB) and duration (5 min) limits |
| **Metering** | Bilateral Ed25519-signed receipts with running totals, auto-ack enabled by default |
| **Payment** | 402 gating until escrow lock is committed, ECDSA-authorized lock/top-up/settlement, dispute path on buyer disconnect |

## Cryptographic Controls

| Use Case | Primitive |
|---|---|
| Node identity and metadata signing | Ed25519 |
| Connection authentication | Ed25519 signature + nonce + timestamp |
| Metering receipts and acks | Ed25519 binary signatures |
| Payment authorization (on-chain) | ECDSA over typed hashes |

## Default Limits

| Parameter | Default |
|---|---|
| Request timeout | 30 s |
| Max stream buffer | 16 MiB |
| Max stream duration | 5 min |
| Per-upload cap | 32 MiB |
| Global pending upload cap | 256 MiB |
| Upload timeout | 120 s |
| Metadata fetch timeout | 2 s |
| Max inbound connections per IP | 10 |

## Identity Key Protection

The Ed25519 private key is the root of trust for your node — it signs metadata, connection handshakes, and metering receipts, and derives your EVM wallet address.

| Environment | Protection |
|---|---|
| **Desktop app** | Encrypted at rest via OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret). Plaintext file deleted after migration. |
| **Server (recommended)** | Inject via `ANTSEED_IDENTITY_HEX` env var from a secrets manager. The variable is cleared from the process environment immediately after read. |
| **Server (default)** | Plaintext file at `~/.antseed/identity.key` with `0600` permissions. |
| **Custom** | Implement the `IdentityStore` interface for KMS, HSM, or any backend. |

## Best Practices

1. Keep `allowPrivateIPs=false` in production.
2. Keep signature verification and stale metadata rejection enabled (both are on by default).
3. Prefer WebRTC transport for end-to-end encryption.
4. Use dedicated wallets for escrow operations.
5. Tune upload/stream caps if workloads are predictable.
6. On servers, use `ANTSEED_IDENTITY_HEX` with a secrets manager instead of storing keys on disk.
7. Back up your identity key — losing it means a new PeerId and EVM wallet address.
