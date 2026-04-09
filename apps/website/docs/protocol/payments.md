---
sidebar_position: 5
slug: /payments
title: Payments
hide_title: true
---

# Payments

Buyers pre-deposit USDC into the on-chain AntseedDeposits contract. Each session follows a Reserve-Serve-Settle lifecycle where credits are locked via AntseedChannels (which holds no USDC itself), requests flow freely over the P2P transport, and settlement happens when the seller calls `settle()` or `close()`.

Two EIP-712 signed messages drive the flow: **ReserveAuth** (buyer authorizes a session budget) and **SpendingAuth** (buyer authorizes cumulative spend per request).

## Session Lifecycle

```text title="reserve → serve → settle"
Buyer                          Seller                         Chain
  │                              │                              │
  ├── ReserveAuth ──────────────>│                              │
  │   (EIP-712: channelId,       │                              │
  │    maxAmount, deadline)       │                              │
  │                              ├── reserve(buyerSig) ────────>│
  │                              │   Deposits.lockForChannel()  │
  │                              │<──── reserveConfirmed ───────┤
  │                              │                              │
  │   ┌──────────────────────────┤                              │
  │   │ SERVE PHASE              │                              │
  │   │                          │                              │
  │   ├── HTTP Request ─────────>│                              │
  │   │<── HTTP Response ────────┤                              │
  │   ├── SpendingAuth ─────────>│  EIP-712: channelId,         │
  │   │   (cumulativeAmount,     │  cumulativeAmount,            │
  │   │    metadataHash)         │  metadataHash                 │
  │   │         ... N requests   │                              │
  │   └──────────────────────────┘                              │
  │                              │                              │
  │  === SETTLE / CLOSE ========  │                              │
  │                              │                              │
  │                              ├── settle(SpendingAuth) ─────>│
  │                              │   or close(SpendingAuth)     │
  │                              │   Deposits.chargeAndCredit   │
  │                              │   EarningsToSeller()         │
  │                              │<──── confirmed ──────────────┤
  │                              │                              │
```

The seller calls `settle()` with the latest SpendingAuth to charge the buyer for cumulative usage while keeping the session open, or `close()` to finalize and release remaining funds. If the seller disappears, the buyer calls `requestClose()` to initiate timeout. After a 15-minute grace period, the buyer calls `withdraw()` to release locked funds.

## EIP-712 Signed Messages

Two EIP-712 typed data messages drive the payment flow. Both share the same domain:

```text title="EIP-712 domain"
name:               "AntseedChannels"
version:            "7"
chainId:            <deployment chain>
verifyingContract:  <channels contract address>
```

### ReserveAuth

Signed by the buyer to authorize a session budget. One signature per session.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | `keccak256(abi.encode(buyer, seller, salt))` |
| `maxAmount` | `uint128` | Maximum USDC (6 decimals) the seller may lock |
| `deadline` | `uint256` | Unix timestamp after which this auth expires |

### SpendingAuth

Signed by the buyer on each request to authorize cumulative spending.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | Same channel identifier as the ReserveAuth |
| `cumulativeAmount` | `uint256` | Total USDC authorized so far (monotonically increasing) |
| `metadataHash` | `bytes32` | Hash of request metadata (input/output token counts, model, etc.) |

The seller submits the latest SpendingAuth to `settle()` or `close()` on-chain. The contract verifies the buyer's signature and charges the cumulative amount from the locked deposit.

## Session Budget and Budget Exhaustion

The `maxAmount` in the ReserveAuth caps total USDC the seller can charge in a session. As the buyer signs SpendingAuths with increasing `cumulativeAmount`, the budget is consumed.

When the budget is exhausted, the seller settles the current session (calling `close()`) and returns HTTP 402 to the buyer, triggering a new negotiation cycle (new ReserveAuth, new session).

## Settlement

### Active Settlement

The seller calls `settle()` with the latest buyer-signed SpendingAuth at any time during the session. This charges the buyer's locked deposit for the cumulative amount and credits the seller's earnings, while keeping the session open for further requests.

To finalize, the seller calls `close()` with the final SpendingAuth. This charges the cumulative amount, credits the seller, and releases any remaining locked deposit back to the buyer's available balance.

### Timeout

If the seller disappears, the buyer calls `requestClose()` on AntseedChannels. This marks the session for timeout. After a 15-minute grace period, the buyer calls `withdraw()` to release the locked funds back to the buyer's deposit.

### Token-to-USDC Conversion

Sellers publish per-model pricing in USD per million tokens (input, cached input, and output rates separately). The conversion from token consumption to USDC happens at the seller's published rate at the time of the request:

```text title="cost calculation"
requestCostUSD  = (freshInputTokens * inputUsdPerMillion + cachedInputTokens * cachedInputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
totalCostUSDC   = sum(requestCosts) * 1_000_000  (6-decimal USDC)
```

`cachedInputUsdPerMillion` defaults to `inputUsdPerMillion` when not set by the seller.

## Wallet

Each node's identity is a secp256k1 private key. The EVM address derived from this key serves as both the PeerId on the network and the on-chain wallet address. Set it via `ANTSEED_IDENTITY_HEX` env var (recommended for production) rather than the plaintext `identity.key` file.

```text title="identity = wallet"
secp256k1 private key (32 bytes)
  → EVM address (20 bytes) = PeerId
```

There is no derivation step or two-key system. One secp256k1 key signs everything — protocol messages (using EIP-191 `personal_sign` with domain tags like `"antseed-data-v1:"` and `"antseed-msg-v1:"`), EIP-712 payment messages (ReserveAuth, SpendingAuth), and on-chain transactions. Verification uses `ecrecover`.

### Funding

The AntseedDeposits contract provides `depositFor(address buyer, uint256 amount)`, allowing any address to fund a buyer's deposit. This decouples the funding source from the node identity — a team treasury, a hardware wallet, or another contract can fund the node without exposing the node's private key.

USDC on Base. 6 decimal places. All on-chain amounts are in USDC atomic units (1 USDC = 1,000,000).

## Smart Contracts

```text title="contract architecture"
AntseedRegistry       Central address book for all protocol contracts
AntseedStaking        Seller staking (holds stake USDC, binds to ERC-8004 agentId)
AntseedDeposits       Buyer deposits, seller payouts (holds buyer USDC)
AntseedChannels       Payment channel lifecycle (swappable, holds NO USDC)
AntseedEmissions      ANTS token emissions (USDC volume-based rewards)
ANTSToken             ANTS ERC-20 token (52M max supply)
```

**Stable contracts** (Staking, Deposits) hold funds and rarely change. The **swappable contract** (Channels) holds no USDC and can be redeployed by re-pointing via the Registry.

Identity uses the deployed [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) IdentityRegistry on Base.

## Supported Chains

| Chain | Chain ID | Status |
|---|---|---|
| `base-mainnet` | 8453 | Production (default) |
| `base-sepolia` | 84532 | Testnet |

Contract addresses are built into the CLI for each chain — no manual configuration needed. The default chain is `base-mainnet`.

### Base Mainnet Contract Addresses

| Contract | Address |
|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| AntseedStaking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| AntseedEmissions | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

All contracts verified on [BaseScan](https://basescan.org).
