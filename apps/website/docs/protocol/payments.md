---
sidebar_position: 5
slug: /payments
title: Payments
hide_title: true
---

# Payments

Buyers pre-deposit USDC into an on-chain escrow contract. Each session follows a Reserve-Serve-Settle lifecycle where credits are locked, requests flow freely over the P2P transport, and settlement happens lazily when the buyer starts their next session.

The key primitive is the **SpendingAuth** — an EIP-712 signed authorization that simultaneously authorizes the current session and proves delivery of the previous one.

## Session Lifecycle

```text title="reserve → serve → settle"
Buyer                          Seller                         Chain
  │                              │                              │
  ├── SpendingAuth ─────────────>│                              │
  │   (EIP-712 signed)           │                              │
  │                              ├── reserve(auth) ────────────>│
  │                              │   locks credits from         │
  │                              │   buyer's deposit            │
  │                              │<──── reserveConfirmed ───────┤
  │                              │                              │
  │   ┌──────────────────────────┤                              │
  │   │ SERVE PHASE              │                              │
  │   │                          │                              │
  │   ├── HTTP Request ─────────>│                              │
  │   │<── SellerReceipt ────────┤  Ed25519-signed receipt      │
  │   ├── BuyerAck ─────────────>│  acknowledgement             │
  │   │         ... N requests   │                              │
  │   └──────────────────────────┘                              │
  │                              │                              │
  │  === NEXT SESSION =========  │                              │
  │                              │                              │
  ├── SpendingAuth(N+1) ───────>│                              │
  │   previousConsumption = X    │                              │
  │   previousSessionId = N      │                              │
  │                              ├── reserve(auth) ────────────>│
  │                              │   settles session N           │
  │                              │   (seller paid, excess        │
  │                              │    returned to buyer)         │
  │                              │   locks credits for N+1       │
  │                              │<──── confirmed ──────────────┤
  │                              │                              │
```

Settlement of session N is triggered atomically during `reserve()` for session N+1. If the buyer never returns, the seller calls `settleTimeout()` after 24 hours.

## SpendingAuth (EIP-712)

The SpendingAuth is the buyer's signed authorization for a session. It is an [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data signature verified on-chain.

```text title="EIP-712 domain"
name:               "AntSeedEscrow"
version:            "1"
chainId:            <deployment chain>
verifyingContract:  <escrow contract address>
```

| Field | Type | Description |
|---|---|---|
| `seller` | `address` | Seller's EVM address (derived from their Ed25519 identity) |
| `sessionId` | `bytes32` | Unique identifier for this session |
| `maxAmount` | `uint256` | Maximum USDC (6 decimals) the seller may charge |
| `nonce` | `uint256` | Buyer's current nonce; incremented on each reserve |
| `deadline` | `uint256` | Unix timestamp after which this auth expires |
| `previousConsumption` | `uint256` | Tokens delivered in the previous session |
| `previousSessionId` | `bytes32` | Session ID of the previous session (`bytes32(0)` if first) |

The `previousConsumption` and `previousSessionId` fields form the **proof chain**. When the buyer signs a SpendingAuth attesting that the previous session delivered X tokens, they are providing a cryptographic proof of delivery that the contract verifies during `reserve()`.

## Proof Chain

Each SpendingAuth is a link in a chain. The chain builds trust incrementally:

```text title="proof chain progression"
Session 1 (First Sign)
  previousSessionId:   0x0000...0000
  previousConsumption: 0
  maxAmount:           ≤ FIRST_SIGN_CAP ($1)
  Trust basis:         None — blind trust, hard-capped

Session 2 (Proven Sign)
  previousSessionId:   session1.id
  previousConsumption: 15420  (tokens delivered in session 1)
  maxAmount:           uncapped
  Trust basis:         Buyer proved session 1 delivery on-chain

Session N
  previousSessionId:   session(N-1).id
  previousConsumption: actual consumption of session N-1
  maxAmount:           uncapped
  Trust basis:         Full chain of proven deliveries
```

### Trust Tiers

| Tier | Condition | Max Authorization |
|---|---|---|
| First Sign | No prior session with this seller (`previousSessionId = 0x0`) | `FIRST_SIGN_CAP` ($1 USDC) |
| Proven Sign | At least one prior proven delivery with this seller | Uncapped (up to buyer's deposit) |
| Qualified Proven Sign | Buyer has proven deliveries with ≥3 distinct sellers | Uncapped, higher reputation weight |

First Sign caps protect buyers from committing significant funds to an unknown seller. Once the buyer signs over a non-zero `previousConsumption`, the on-chain record proves the seller delivered, and subsequent sessions are uncapped.

Qualified Proven Sign indicates the buyer is an active network participant, not a sybil pair with a single seller. The diversity threshold (≥3 sellers) is checked against on-chain settlement history.

## Bilateral Receipts

During the serve phase, each request produces a bilateral receipt pair:

### SellerReceipt

Signed by the seller's Ed25519 identity key after processing each request.

| Field | Type | Description |
|---|---|---|
| `sessionId` | `bytes32` | Current session identifier |
| `requestIndex` | `uint32` | Sequential request number within session |
| `runningTotal` | `uint256` | Cumulative USDC cost through this request |
| `inputTokens` | `uint32` | Input tokens for this request |
| `outputTokens` | `uint32` | Output tokens for this request |
| `responseHash` | `bytes32` | SHA-256 hash of the response payload |
| `timestamp` | `uint64` | Unix timestamp (ms) |

### BuyerAck

The buyer's Ed25519 signature over the SellerReceipt, confirming they received the response matching `responseHash`.

Bilateral receipts form the per-request audit trail. They are stored locally by both parties and are not submitted on-chain during normal operation. The SpendingAuth chain is the settlement mechanism — receipts exist for dispute evidence and offline verification.

## Settlement

### Lazy Settlement

Settlement is not an explicit step. When the seller calls `reserve()` with a new SpendingAuth, the contract atomically:

1. Validates the `previousSessionId` matches an active reservation
2. Settles the previous session: transfers `previousConsumption` to seller, returns excess to buyer's deposit
3. Updates on-chain counters (session count, total volume) for both parties
4. Locks `maxAmount` for the new session

This means sellers are paid as a side effect of the buyer's continued usage.

### Timeout Settlement

If a buyer does not return within 24 hours of the last session:

```text title="settleTimeout() behavior"
Caller:     Anyone (typically the seller)
Condition:  block.timestamp > reservation.timestamp + 24 hours
Effect:     Full refund of locked amount to buyer's deposit
            Seller receives nothing
            Ghost mark recorded on seller's on-chain record
```

The full-refund-on-timeout design is intentional: the seller had 24 hours to serve a session that would trigger lazy settlement via the next SpendingAuth. If the buyer didn't return, the seller cannot prove delivery unilaterally (only the buyer's SpendingAuth can attest to consumption). Ghost marks accumulate on the seller's record and affect reputation scoring.

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

The signing identity (Ed25519) and the funding wallet (secp256k1/EVM) are separate key types derived from the same seed. The Ed25519 key signs protocol messages (handshakes, receipts). The EVM key signs on-chain transactions and EIP-712 SpendingAuths.

### Funding

The escrow contract provides `depositFor(address buyer, uint256 amount)`, allowing any address to fund a buyer's deposit. This decouples the funding source from the node identity — a team treasury, a hardware wallet, or another contract can fund the node without exposing the node's private key.

USDC on Base. 6 decimal places. All on-chain amounts are in USDC atomic units (1 USDC = 1,000,000).

## Supported Chains

| Chain | Chain ID | Status | Escrow Contract |
|---|---|---|---|
| `base-sepolia` | 84532 | Testnet | Deployed |
| `base-mainnet` | 8453 | Production | Planned |
