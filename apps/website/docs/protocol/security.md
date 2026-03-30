---
sidebar_position: 7
slug: /security
title: Security
hide_title: true
---

# Security

AntSeed separates signing authority from fund custody. The node identity that signs protocol messages and payment authorizations never holds funds directly. The wallet that holds your money deposits into a contract and never touches the node.

## Identity

Each node has a single secp256k1 private key. The corresponding EVM address is both the PeerId on the network and the on-chain signing identity. There is no key derivation step and no two-key system — one key handles everything.

| Function | Mechanism |
|---|---|
| **P2P identity** | EIP-191 `personal_sign` with domain tags (`"antseed-data-v1:"`, `"antseed-msg-v1:"`), verified via `ecrecover` |
| **Payment authorization** | EIP-712 signatures (ReserveAuth, SpendingAuth) |
| **PeerId** | EVM address (40 hex chars, no `0x` prefix) |

## Signing Identity vs Funding Wallet

The node's secp256k1 key is the **signing identity**. It signs both protocol messages (handshakes, metadata, metering receipts) and EIP-712 payment messages (`ReserveAuth` to authorize session budgets, `SpendingAuth` to authorize cumulative spending). It never holds funds directly.

The **funding wallet** is any external wallet the user controls — hardware wallet, multisig, or EOA. It deposits USDC into the AntseedDeposits contract via `depositFor(buyer, amount)`, where `buyer` is the signing identity's address. The funding wallet has no ongoing role after deposit.

This separation means:

- The signing identity can run unattended without risking the funding wallet
- The funding wallet never interacts with the application
- Worst-case exposure from a compromised signing identity is bounded by the current deposit balance

## Key Storage

| Environment | Protection |
|---|---|
| **Desktop app** | Electron `safeStorage` API encrypts the secp256k1 private key at rest using the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). On first launch after upgrade, plaintext `identity.key` is auto-encrypted and the original deleted. |
| **CLI / Server** | Plaintext `identity.key` in the data directory (`~/.antseed/`). Use `ANTSEED_IDENTITY_HEX` env var with a secrets manager for production deployments. |

## Auto vs Manual Approval

Payment signatures can be issued in two modes:

| Mode | Flow | Use Case |
|---|---|---|
| **Auto** | Node receives 402 → signs ReserveAuth internally → sends to seller → seller calls `reserve()` | Server/CLI deployments, unattended operation |
| **Manual** | Node receives 402 → propagates to UI → user reviews and approves → desktop signs with keychain-encrypted key → seller calls `reserve()` | Desktop app, interactive sessions |

Both modes produce identical on-chain outcomes. The difference is whether the signing step requires user interaction. Each ReserveAuth is scoped to a specific seller, capped by `maxAmount`, and expires at `deadline`.

## Risk Bounds

| Scenario | Signing Identity Exposed | Funding Wallet Exposed | Maximum Loss |
|---|---|---|---|
| **Node compromised** | Yes | No | Current deposit balance |
| **Signing key extracted** | Yes | No | Current deposit balance |
| **Funding wallet compromised** | No | Yes | Funding wallet balance (deposits unaffected once deposited) |
| **Both compromised** | Yes | Yes | Deposit balance + funding wallet balance |
| **Deposits contract exploit** | N/A | N/A | All deposited funds across all users |

In the common attack surface — node compromise — the funding wallet is never at risk. The attacker can sign ReserveAuths against the existing deposit balance but cannot access the funding wallet or deposit additional funds.

## Protocol-Level Controls

All communication happens over an untrusted network. Every trust-critical operation is cryptographically verified:

- **secp256k1 peer identity** — every node has a unique keypair; metadata, connection handshakes, and metering receipts are all signed with EIP-191 `personal_sign`
- **Replay-resistant authentication** — connection envelopes include nonce + timestamp with skew checks
- **Bounded resource usage** — frame sizes, upload caps, stream durations, and concurrent connections are all hard-limited
- **On-chain settlement** — EIP-712 signed ReserveAuth and SpendingAuth with per-seller, per-session, time-bounded authorization

## Buyer-Seller Flow Controls

| Stage | Controls |
|---|---|
| **Discovery** | Signed metadata with freshness checks, topic normalization, private IP filtering |
| **Connection** | EIP-191 signed intro envelopes with nonce replay guard, timestamp skew rejection, per-IP connection cap (10) |
| **Transport** | Frame type and size validation (64 MiB max), fail-closed on decode errors, request and stream timeouts |
| **Upload/Stream** | Per-request cap (32 MiB), global pending cap (256 MiB), upload timeout (120s), stream buffer (16 MiB) and duration (5 min) limits |
| **Metering** | Bilateral EIP-191 signed receipts with running totals, auto-ack enabled by default |
| **Payment** | 402 gating until ReserveAuth is committed on-chain via `reserve()`, bounded by maxAmount and deadline |

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

1. Use `depositFor()` on AntseedDeposits from a hardware wallet or multisig. Never fund the signing identity directly.
2. Deposit only what you need for a session. Top up as needed rather than pre-loading large amounts into AntseedDeposits.
3. Keep `allowPrivateIPs=false` in production.
4. Keep signature verification and stale metadata rejection enabled (both on by default).
5. Prefer WebRTC transport for end-to-end encryption.
6. On servers, use `ANTSEED_IDENTITY_HEX` with a secrets manager instead of storing keys on disk.
7. Back up your secp256k1 private key — it is the only way to recover your PeerId (EVM address) and on-chain wallet.
