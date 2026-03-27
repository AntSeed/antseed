---
sidebar_position: 5
slug: /payments
title: Payments
hide_title: true
---

# Payments

Buyers pre-deposit USDC into the on-chain AntseedDeposits contract. Each session follows a Reserve-Serve-Settle lifecycle where credits are locked via AntseedSessions (which holds no USDC itself), requests flow freely over the P2P transport, and settlement happens when the seller calls `settle()` or `close()`.

Two EIP-712 signed messages drive the flow: **ReserveAuth** (buyer authorizes a session budget) and **MetadataAuth** (buyer authorizes cumulative spend per request).

## Session Lifecycle

```text title="reserve → serve → settle"
Buyer                          Seller                         Chain
  │                              │                              │
  ├── ReserveAuth ──────────────>│                              │
  │   (EIP-712: channelId,       │                              │
  │    maxAmount, deadline)       │                              │
  │                              ├── reserve(buyerSig) ────────>│
  │                              │   Deposits.lockForSession()  │
  │                              │<──── reserveConfirmed ───────┤
  │                              │                              │
  │   ┌──────────────────────────┤                              │
  │   │ SERVE PHASE              │                              │
  │   │                          │                              │
  │   ├── HTTP Request ─────────>│                              │
  │   │<── HTTP Response ────────┤                              │
  │   ├── MetadataAuth ─────────>│  EIP-712: channelId,         │
  │   │   (cumulativeAmount,     │  cumulativeAmount,            │
  │   │    metadataHash)         │  metadataHash                 │
  │   │         ... N requests   │                              │
  │   └──────────────────────────┘                              │
  │                              │                              │
  │  === SETTLE / CLOSE ========  │                              │
  │                              │                              │
  │                              ├── settle(MetadataAuth) ─────>│
  │                              │   or close(MetadataAuth)     │
  │                              │   Deposits.chargeAndCredit   │
  │                              │   EarningsToSeller()         │
  │                              │<──── confirmed ──────────────┤
  │                              │                              │
```

The seller calls `settle()` with the latest MetadataAuth to charge the buyer for cumulative usage while keeping the session open, or `close()` to finalize and release remaining funds. If the seller disappears, anyone can call `requestTimeout()` after the deadline, followed by `withdraw()` after a 15-minute grace period to release buyer funds.

## EIP-712 Signed Messages

Two EIP-712 typed data messages drive the payment flow. Both share the same domain:

```text title="EIP-712 domain"
name:               "AntseedSessions"
version:            "6"
chainId:            <deployment chain>
verifyingContract:  <sessions contract address>
```

### ReserveAuth

Signed by the buyer to authorize a session budget. One signature per session.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | `keccak256(abi.encode(buyer, seller, salt))` |
| `maxAmount` | `uint128` | Maximum USDC (6 decimals) the seller may lock |
| `deadline` | `uint256` | Unix timestamp after which this auth expires |

### MetadataAuth

Signed by the buyer on each request to authorize cumulative spending.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | Same channel identifier as the ReserveAuth |
| `cumulativeAmount` | `uint256` | Total USDC authorized so far (monotonically increasing) |
| `metadataHash` | `bytes32` | Hash of request metadata (input/output token counts, model, etc.) |

The seller submits the latest MetadataAuth to `settle()` or `close()` on-chain. The contract verifies the buyer's signature and charges the cumulative amount from the locked deposit.

## Session Budget and Budget Exhaustion

The `maxAmount` in the ReserveAuth caps total USDC the seller can charge in a session. As the buyer signs MetadataAuths with increasing `cumulativeAmount`, the budget is consumed.

When the budget is exhausted, the seller settles the current session (calling `close()`) and returns HTTP 402 to the buyer, triggering a new negotiation cycle (new ReserveAuth, new session).

## Settlement

### Active Settlement

The seller calls `settle()` with the latest buyer-signed MetadataAuth at any time during the session. This charges the buyer's locked deposit for the cumulative amount and credits the seller's earnings, while keeping the session open for further requests.

To finalize, the seller calls `close()` with the final MetadataAuth. This charges the cumulative amount, credits the seller, and releases any remaining locked deposit back to the buyer's available balance.

### Timeout

If the seller disappears, anyone can call `requestTimeout()` after the session deadline has passed. This marks the session as timed out. After a 15-minute grace period, the buyer (or anyone) calls `withdraw()` to release the locked funds back to the buyer's deposit.

### Token-to-USDC Conversion

Sellers publish per-model pricing in USD per million tokens (input and output rates separately). The conversion from token consumption to USDC happens at the seller's published rate at the time of the request:

```text title="cost calculation"
requestCostUSD  = (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
totalCostUSDC   = sum(requestCosts) * 1_000_000  (6-decimal USDC)
```

## Wallet

Each node's EVM wallet is derived deterministically from its Ed25519 identity key:

```text title="identity → wallet derivation"
Ed25519 private key (32 bytes)
  → domain-separated hash: keccak256("antseed-evm-v1" || ed25519PrivateKey)
  → secp256k1 private key (32 bytes)
  → EVM address (20 bytes)
```

The signing identity (Ed25519) and the funding wallet (secp256k1/EVM) are separate key types derived from the same seed. The Ed25519 key signs protocol messages (handshakes, receipts). The EVM key signs EIP-712 messages (ReserveAuth, MetadataAuth).

### Funding

The AntseedDeposits contract provides `depositFor(address buyer, uint256 amount)`, allowing any address to fund a buyer's deposit. This decouples the funding source from the node identity — a team treasury, a hardware wallet, or another contract can fund the node without exposing the node's private key.

USDC on Base. 6 decimal places. All on-chain amounts are in USDC atomic units (1 USDC = 1,000,000).

## Supported Chains

| Chain | Chain ID | Status | Contracts |
|---|---|---|---|
| `base-sepolia` | 84532 | Testnet | Deployed |
| `base-mainnet` | 8453 | Production | Planned |
