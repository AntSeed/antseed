# 04 - Payments

This document specifies the pull-payment protocol for Antseed on Base/EVM.

> **Implementation status (2026-03-01):** Pull-payment with EIP-712 SpendingAuth is implemented in `@antseed/node` and `AntseedEscrow.sol`.

## 1. Overview

- Buyers pre-deposit USDC into escrow.
- Buyers authorize seller spending with signed EIP-712 `SpendingAuth` messages.
- Sellers call `charge()` on-chain against the latest valid authorization.
- Off-chain bilateral receipts (`SellerReceipt` + `BuyerAck`) provide delivery/accounting proofs per request.

## 2. Pull-Payment Lifecycle

```text
Deposit -> SpendingAuth -> Charge* -> TopUp (optional) -> Claim/Withdraw
```

1. Buyer signs and sends `SpendingAuth` (nonce=1).
2. Seller verifies signature and returns `AuthAck`.
3. Seller processes requests and periodically submits on-chain `charge()` transactions.
4. Near authorization cap, seller sends `TopUpRequest`; buyer may approve by signing nonce+1 auth.
5. Seller claims earnings; buyer can request and execute withdrawals with timelock.

## 3. Settlement and Pricing

Per-request pricing uses advertised USD-per-1M token rates:

```text
requestCostUSD = (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
```

Request cost is converted to USDC base units (6 decimals) for charging.

## 4. Contract API (AntseedEscrow)

### Buyer

- `deposit(uint256 amount)`
- `requestWithdrawal(uint256 amount)`
- `executeWithdrawal()`
- `cancelWithdrawal()`
- `getBuyerBalance(address buyer)` -> `(available, pendingWithdrawal, withdrawalReadyAt)`

### Seller

- `charge(address buyer, uint256 amount, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes sig)`
- `claimEarnings()`
- `stake(uint256 amount)`
- `unstake(uint256 amount)`
- `getSessionAuth(address buyer, address seller, bytes32 sessionId)` -> `(nonce, authMax, authUsed, deadline)`

### Platform / Reputation

- `sweepFees()`
- `rateSeller(address seller, uint8 score)`
- `canRate(address buyer, address seller)`
- `getReputation(address seller)` -> `ReputationData`

## 5. Signature Schemes

### EIP-712 (on-chain spending authorization)

`SpendingAuth(address seller, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline)`

- Signed by buyer wallet.
- Verified off-chain by seller and on-chain in `charge()`.

### Ed25519 (off-chain receipts)

- Seller signs receipt proof: `(sessionId || runningTotal || requestCount || responseHash)`.
- Buyer signs ack proof: `(sessionId || runningTotal || requestCount)`.
- Used for accounting/proof exchange; not consumed by contract.

## 6. Withdrawal Semantics

`requestWithdrawal()` starts a 1-hour timelock and records a pending withdrawal.

Pending withdrawal is a best-effort reservation. Seller `charge()` is still enforced against current escrow balance, so charges during timelock can reduce what is withdrawable at execution time.

## 7. Reputation Model

On-chain reputation is returned from `getReputation()` as:

- `avgRating`
- `ratingCount`
- `stakedAmount`
- `totalTransactions`
- `totalVolume`
- `uniqueBuyersServed`
- `ageDays`

## 8. P2P Payment Messages (0x50-0x5F)

| Type | Name | Direction | Description |
|---|---|---|---|
| 0x50 | `SpendingAuth` | Buyer -> Seller | Buyer EIP-712 authorization |
| 0x51 | `AuthAck` | Seller -> Buyer | Seller accepted auth |
| 0x53 | `SellerReceipt` | Seller -> Buyer | Signed running-total receipt |
| 0x54 | `BuyerAck` | Buyer -> Seller | Buyer signed receipt acknowledgment |
| 0x55 | `TopUpRequest` | Seller -> Buyer | Seller requests new auth cap |

## 9. Chains

| ChainId | Network |
|---|---|
| `base-local` | Local Base dev chain (Anvil) |
| `base-sepolia` | Base Sepolia testnet |
| `base-mainnet` | Base mainnet |
