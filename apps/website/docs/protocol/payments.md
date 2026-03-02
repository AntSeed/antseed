---
sidebar_position: 5
slug: /payments
title: Payments
hide_title: true
---

# Payments

Antseed uses a pull-payment escrow model on Base with USDC.

## Flow

1. Buyer deposits USDC into escrow.
2. Buyer signs `SpendingAuth` (EIP-712) for a seller/session cap.
3. Seller serves requests and submits `charge()` on-chain.
4. Seller requests top-up near cap; buyer may approve with nonce+1 auth.
5. Seller claims earnings; buyer withdraws remaining balance.

## Cost Model

```text title="request cost"
requestCostUSD = (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
```

Costs are charged in USDC base units (6 decimals).

## Messages

Payment channel frames use `0x50-0x5F`:

- `0x50` `SpendingAuth`
- `0x51` `AuthAck`
- `0x53` `SellerReceipt`
- `0x54` `BuyerAck`
- `0x55` `TopUpRequest`

## Withdrawals

Withdrawals are two-step:

- `antseed withdraw <amount>` starts a 1-hour timelock.
- `antseed withdraw --execute` executes after the timelock.

Pending withdrawal is best-effort; charges during timelock can reduce the executable amount.

## Networks

| Chain | Status |
|---|---|
| base-local | Development |
| base-sepolia | Testnet |
| base-mainnet | Production |
