---
sidebar_position: 5
slug: /payments
title: Payments
hide_title: true
---

# Payments

Buyers commit funds before a session. Requests flow freely during the session. At the end, one settlement transaction resolves everything — the provider gets paid, the buyer gets refunded for unused funds, and the protocol takes a small fee.

## Settlement

Settlement computes final cost by summing signed receipt costs, deducting protocol fee, and producing the seller payout. Request-level pricing is resolved from input/output USD-per-1M rates before each receipt is issued.

```text title="settlement formula"
requestCostUSD  = (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000
totalCostUSD    = sum(receipt.costCents) / 100
protocolFeeUSD  = totalCostUSD * protocolFeeRate
sellerPayoutUSD = totalCostUSD - protocolFeeUSD
```

## Payment Channels

Bilateral payment channels between each buyer-seller pair. Channel states progress linearly:

```text title="channel lifecycle"
open -> active -> disputed -> settled -> closed
```

Settlement uses on-chain USDC escrow via the `AntSeedEscrow` smart contract deployed on Base. Buyers lock USDC in escrow at session start. Requests flow freely. Settlement resolves on idle timeout (default: 30 seconds).

| Chain | Status |
|---|---|
| base-local | Development |
| base-sepolia | Testnet |
| base-mainnet | Production |

## Disputes

Disputes are raised when buyer and seller receipts disagree on token usage. Timeout: 72 hours. Auto-resolved if within threshold, otherwise manual intervention. Poor-quality providers face progressive consequences: warnings, stake slashing, routing exclusion.

## Wallet

EVM wallets are derived from the node's Ed25519 identity key. USDC balances use 6-decimal precision. The wallet tracks USDC balance and in-escrow amounts. Manage funds via `antseed deposit`, `antseed withdraw`, and `antseed balance`.
