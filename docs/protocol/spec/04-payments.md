# 04 - Payments

This document specifies the bilateral payment protocol for the Antseed Network, covering settlement, session lifecycle, disputes, crypto escrow, and balance tracking using Base/EVM.

> **Implementation status (2026-02-22):** On-chain bilateral USDC escrow settlement is implemented in `@antseed/node` and `AntseedEscrow.sol` on Base.

## 1. Settlement

Settlement uses bilateral receipts with running totals and dual signatures. Both the buyer and seller maintain a running total of the session cost, signed by both parties.

### Bilateral Receipt Settlement

After each request, the seller sends a receipt containing:
- Session ID (bytes32)
- Running total (cumulative USDC cost in base units)
- Request count
- Response hash (SHA-256 of response body)
- Seller Ed25519 signature

The buyer verifies and counter-signs with a BuyerAck containing:
- Session ID
- Running total
- Request count
- Buyer Ed25519 signature

### Off-chain Settlement Calculation

```
calculateSettlement(sessionId, receipts, platformFeeRate) -> SettlementResult
```

Computes the final cost for a session from receipt totals. Used for off-chain cost estimation.

Pricing is resolved during request handling from dual offer rates:

```
requestCostUsd =
  (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
```

The per-request `requestCostUsd` is converted to `costCents` and persisted in each receipt. Settlement then sums receipt costs.

### Helper Functions

**isSettlementWithinEscrow(settlementCostUSD, escrowAmountUSD) -> boolean**

Returns `true` if `settlementCostUSD <= escrowAmountUSD`.

**calculateRefund(escrowAmountUSD, settlementCostUSD) -> number**

Returns `max(0, escrowAmountUSD - settlementCostUSD)`.

## 2. Session Lifecycle

Sessions follow a bilateral lifecycle managed on-chain:

```
Lock -> Active -> Settled | Disputed | Expired
```

| State | Description |
|---|---|
| `Lock` | Buyer signs lock authorization; seller commits on-chain via `commit_lock` |
| `Active` | Lock committed, requests being served with bilateral receipts |
| `Settled` | Both parties agree on running total; seller submits `settle` on-chain with buyer's ECDSA signature and reputation score |
| `Disputed` | Seller opens dispute on-chain with last acked running total |
| `Expired` | Lock expires after 1 hour if no activity; buyer reclaims funds |

### Lock Flow

1. Buyer generates session ID (random bytes32) and signs lock message with ECDSA
2. Buyer sends `SessionLockAuth` (0x50) to seller via P2P
3. Seller recovers buyer address via `ecrecover`, calls `commit_lock` on-chain
4. Seller sends `SessionLockConfirm` (0x51) or `SessionLockReject` (0x52) back
5. If confirmed, session enters Active state

### Top-Up Flow

When running total exceeds 80% of locked amount:
1. Seller sends `TopUpRequest` (0x55) to buyer
2. Buyer signs `extend_lock` authorization with ECDSA
3. Buyer sends `TopUpAuth` (0x58) to seller
4. Seller calls `extend_lock` on-chain

### Settlement Flow

1. Buyer signs settlement message (session ID, running total, score) with ECDSA
2. Buyer sends `SessionEnd` (0x56) to seller
3. Seller calls `settle` on-chain with buyer's signature and score
4. Contract transfers running total to seller, refunds remainder to buyer
5. Reputation score recorded on-chain

## 3. Dispute Resolution

### Lock Expiry

- Locks expire after 1 hour if no settlement occurs
- Buyer can call `release_expired_lock` to reclaim funds after expiry

### Dispute Window

- If buyer disconnects (ghost scenario), seller opens dispute with last acked running total
- 24-hour dispute window for buyer to respond
- If buyer does not respond, dispute resolves in seller's favor

### Ghost Buyer Handling

When a buyer disconnects unexpectedly:
- If buyer acked some work: seller opens dispute with `lastAckedTotal`
- If no acks but work was done: seller opens dispute with `runningTotal`
- If no work done: lock expires naturally after 1 hour

## 4. Reputation

On-chain weighted reputation score based on session history:
- Recorded via the `settle` function alongside each settlement
- Score range: 0-100 (provided by buyer at session end)
- Weighted average stored on-chain per seller address
- Tracks: session count, dispute count, weighted average score
- Buyers verify claimed reputation against on-chain data during peer discovery

## 5. Crypto Escrow

The `AntseedEscrow.sol` Solidity contract on Base holds USDC funds in escrow during sessions.

### Token

- **Token:** ERC-20 USDC on Base
- **Decimals:** 6

### Contract Functions

| Function | Description |
|---|---|
| `deposit(amount)` | Buyer deposits USDC into their escrow account |
| `withdraw(amount)` | Buyer withdraws available (uncommitted) USDC |
| `commit_lock(buyer, sessionId, amount, buyerSig)` | Seller commits a buyer-signed lock on-chain |
| `extend_lock(sessionId, additionalAmount, buyerSig)` | Seller extends lock with buyer authorization |
| `settle(sessionId, runningTotal, score, buyerSig)` | Seller submits settlement with buyer's ECDSA signature |
| `open_dispute(sessionId, claimedAmount)` | Seller opens dispute for ghost buyer scenario |
| `respond_dispute(sessionId)` | Buyer responds to dispute |
| `release_expired_lock(sessionId)` | Buyer reclaims funds from expired lock |
| `get_buyer_account(buyer)` | Read buyer's deposited/committed/available balances |
| `get_session(sessionId)` | Read session state |
| `get_reputation(seller)` | Read seller's on-chain reputation |

## 6. Signature Verification

### ECDSA (On-chain)

Used for lock authorization, settlement, and extend-lock messages. Verified on-chain via `ecrecover`.

Message hashes built with `solidityPackedKeccak256`:
- **Lock:** `keccak256(sessionId, seller, amount)`
- **Settlement:** `keccak256(sessionId, runningTotal, score)`
- **Extend Lock:** `keccak256(sessionId, seller, additionalAmount)`

### Ed25519 (Off-chain P2P)

Used for bilateral receipt signing and acknowledgement between peers. Not verified on-chain.

## 7. Account Structure

On-chain storage uses Solidity mappings:
- `buyerAccounts[address]` -> `{ deposited, committed }`
- `sessions[bytes32]` -> `{ buyer, seller, lockedAmount, status, createdAt }`
- `reputation[address]` -> `{ totalWeightedScore, sessionCount, disputeCount }`

## 8. Wallet Management

Ed25519 identity keypair is derived to an EVM address:
1. Take Ed25519 public key (32 bytes)
2. Apply `keccak256` hash
3. Take last 20 bytes as EVM address
4. Derive deterministic EVM private key for ECDSA signing via `Wallet` from ethers.js

Functions:
- `identityToEvmWallet(identity)` -> ethers.Wallet (for ECDSA signing)
- `identityToEvmAddress(identity)` -> 0x-prefixed EVM address
- `getWalletInfo(identity, rpcUrl, usdcAddress, chainId)` -> WalletInfo with ETH and USDC balances

## 9. Balance Tracking

### On-chain Buyer Accounts

Each buyer has an on-chain account in the escrow contract:
- `deposited`: total USDC deposited
- `committed`: total USDC locked in active sessions
- `available`: `deposited - committed` (available for new locks or withdrawal)

### Local Transaction History

The `BalanceManager` maintains a local transaction history for display purposes.

| TransactionType | Description |
|---|---|
| `escrow_lock` | USDC locked into escrow for a session |
| `escrow_release` | Escrowed USDC released to seller on settlement |
| `escrow_refund` | Escrowed USDC refunded to buyer |
| `dispute_resolution` | Transaction recorded for dispute resolution |

## 10. P2P Messages

Bilateral payment messages use message types 0x50-0x58:

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `SessionLockAuth` | Buyer -> Seller | Buyer's signed lock authorization |
| 0x51 | `SessionLockConfirm` | Seller -> Buyer | Lock committed on-chain |
| 0x52 | `SessionLockReject` | Seller -> Buyer | Lock rejected |
| 0x53 | `SellerReceipt` | Seller -> Buyer | Running-total receipt after each request |
| 0x54 | `BuyerAck` | Buyer -> Seller | Buyer acknowledges receipt |
| 0x55 | `TopUpRequest` | Seller -> Buyer | Request additional lock funds |
| 0x56 | `SessionEnd` | Buyer -> Seller | Buyer initiates settlement |
| 0x58 | `TopUpAuth` | Buyer -> Seller | Buyer authorizes top-up |

## 11. Off-chain Dispute Detection

The off-chain dispute detection module (`disputes.ts`) provides helper functions for detecting discrepancies between buyer and seller receipt totals. This is retained for local discrepancy analysis.

### Constants

| Constant | Value | Description |
|---|---|---|
| `DISPUTE_TIMEOUT_MS` | `259200000` (72 hours) | Time after which an unresolved off-chain dispute expires |

### Functions

- `createDispute(channel, initiatorPeerId, reason, buyerReceipts, sellerReceipts)` -> PaymentDispute
- `detectDiscrepancy(buyerReceipts, sellerReceipts, thresholdPercent)` -> DiscrepancyResult
- `resolveDispute(dispute, resolution)` -> PaymentDispute
- `isDisputeExpired(dispute)` -> boolean
- `calculateDisputedAmount(buyerReceipts, sellerReceipts)` -> number

## 12. Supported Chains

| ChainId | Network |
|---|---|
| `base-local` | Local Base dev chain (Anvil) |
| `base-sepolia` | Base Sepolia testnet |
| `base-mainnet` | Base mainnet |
