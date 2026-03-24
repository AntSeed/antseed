---
sidebar_position: 7
slug: /security
title: Security
hide_title: true
---

# Security

AntSeed separates signing authority from fund custody. The node identity that signs protocol messages and payment authorizations never holds funds. The wallet that holds funds never touches the application.

## Identity Derivation

A single Ed25519 seed deterministically produces two independent keypairs:

| Keypair | Derivation | Purpose |
|---|---|---|
| **P2P identity** | Ed25519 directly from seed | Peer authentication, metadata signing, metering receipts |
| **EVM wallet** | `secp256k1` via `keccak256(ed25519_seed \|\| "evm-payment-key")` | EIP-712 SpendingAuth signatures |

The domain-separated derivation ensures the two keypairs are cryptographically independent. One seed, deterministic recovery, no additional key management.

## Signing Identity vs Funding Wallet

The EVM wallet derived from the node seed is the **signing identity**. It is used exclusively to sign EIP-712 `SpendingAuth` messages that authorize a seller to pull payment from escrow. It never holds funds.

The **funding wallet** is any external wallet the user controls — hardware wallet, multisig, or EOA. It deposits USDC into the escrow contract via `depositFor(buyer, amount)`, where `buyer` is the signing identity's address. The funding wallet has no ongoing role after deposit.

This separation means:

- The signing identity can run unattended without risking the funding wallet
- The funding wallet never interacts with the application
- Worst-case exposure from a compromised signing identity is bounded by the current escrow balance

## Key Storage

| Environment | Protection |
|---|---|
| **Desktop app** | Electron `safeStorage` API encrypts the Ed25519 seed at rest using the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). On first launch after upgrade, plaintext `identity.key` is auto-encrypted and the original deleted. |
| **CLI / Server** | Plaintext `identity.key` in the data directory (`~/.antseed/`). Use `ANTSEED_IDENTITY_HEX` env var with a secrets manager for production deployments. |

## Auto vs Manual Approval

SpendingAuth signatures can be issued in two modes:

| Mode | Flow | Use Case |
|---|---|---|
| **Auto** | Node receives 402 → signs SpendingAuth internally → sends to seller → seller calls `reserve()` | Server/CLI deployments, unattended operation |
| **Manual** | Node receives 402 → propagates to UI → user reviews and approves → desktop signs with keychain-encrypted key → seller calls `reserve()` | Desktop app, interactive sessions |

Both modes produce identical on-chain outcomes. The difference is whether the signing step requires user interaction. Each SpendingAuth is scoped to a specific seller, capped by `maxAmount`, and expires at `deadline`.

## Risk Bounds

| Scenario | Signing Identity Exposed | Funding Wallet Exposed | Maximum Loss |
|---|---|---|---|
| **Node compromised** | Yes | No | Current escrow balance |
| **Signing key extracted** | Yes | No | Current escrow balance |
| **Funding wallet compromised** | No | Yes | Funding wallet balance (escrow unaffected once deposited) |
| **Both compromised** | Yes | Yes | Escrow balance + funding wallet balance |
| **Escrow contract exploit** | N/A | N/A | All deposited funds across all users |

In the common attack surface — node compromise — the funding wallet is never at risk. The attacker can sign SpendingAuths against the existing escrow balance but cannot access the funding wallet or deposit additional funds.

## Protocol-Level Controls

All communication happens over an untrusted network. Every trust-critical operation is cryptographically verified:

- **Ed25519 peer identity** — every node has a unique keypair; metadata, connection handshakes, and metering receipts are all signed
- **Replay-resistant authentication** — connection envelopes include nonce + timestamp with skew checks
- **Bounded resource usage** — frame sizes, upload caps, stream durations, and concurrent connections are all hard-limited
- **On-chain settlement** — EIP-712 signed SpendingAuths with per-seller, per-session, time-bounded authorization

## Buyer-Seller Flow Controls

| Stage | Controls |
|---|---|
| **Discovery** | Signed metadata with freshness checks, topic normalization, private IP filtering |
| **Connection** | Ed25519-signed intro envelopes with nonce replay guard, timestamp skew rejection, per-IP connection cap (10) |
| **Transport** | Frame type and size validation (64 MiB max), fail-closed on decode errors, request and stream timeouts |
| **Upload/Stream** | Per-request cap (32 MiB), global pending cap (256 MiB), upload timeout (120s), stream buffer (16 MiB) and duration (5 min) limits |
| **Metering** | Bilateral Ed25519-signed receipts with running totals, auto-ack enabled by default |
| **Payment** | 402 gating until SpendingAuth is committed on-chain via `reserve()`, bounded by maxAmount and deadline |

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

## Best Practices

1. Use `depositFor()` from a hardware wallet or multisig. Never fund the signing identity directly.
2. Deposit only what you need for a session. Top up as needed rather than pre-loading large amounts.
3. Keep `allowPrivateIPs=false` in production.
4. Keep signature verification and stale metadata rejection enabled (both on by default).
5. Prefer WebRTC transport for end-to-end encryption.
6. On servers, use `ANTSEED_IDENTITY_HEX` with a secrets manager instead of storing keys on disk.
7. Back up your Ed25519 seed — it is the only way to recover both your PeerId and your signing identity address.
