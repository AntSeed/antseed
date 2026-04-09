---
sidebar_position: 3
slug: /payments
title: Payments
hide_title: true
---

# Payments

AntSeed uses USDC on Base Mainnet for all payments. Buyers pre-deposit USDC, providers earn per request, and everything settles on-chain automatically.

## For Buyers

### Depositing USDC

The recommended way to deposit is through the payments portal:

```bash
antseed payments
# Opens at http://localhost:3118
```

In the portal:
1. Connect a funded wallet (MetaMask, Coinbase Wallet, etc.)
2. Enter the amount to deposit
3. Approve the USDC transfer and confirm the deposit

The contract's `deposit(buyer, amount)` pulls USDC from your connected wallet and credits your node's address. Your node's identity key never needs to hold USDC or ETH.

:::tip Third-Party Funding
Anyone can deposit on behalf of a buyer — a team treasury, a hardware wallet, or another contract. The funding source is decoupled from the node identity.
:::

### Checking Balance

```bash
antseed balance
```

### Withdrawing

Withdrawals are initiated through the payments portal or CLI:

```bash
antseed withdraw 5
```

### How Costs Are Calculated

Providers publish per-service pricing in USD per million tokens:

| Rate | Description |
|---|---|
| `inputUsdPerMillion` | Cost per 1M input tokens |
| `cachedInputUsdPerMillion` | Cost per 1M cached input tokens (lower) |
| `outputUsdPerMillion` | Cost per 1M output tokens |

```
requestCost = (freshInput * inputRate + cachedInput * cachedRate + output * outputRate) / 1,000,000
```

USDC has 6 decimal places. All on-chain amounts are in atomic units (1 USDC = 1,000,000).

### Session Budget

Each session starts with a ReserveAuth that locks a budget from your deposit. As you send requests, the budget is consumed. When exhausted, the session settles and a new one starts automatically. This is transparent — you just keep sending requests.

## For Providers

### Earning USDC

Providers earn USDC automatically on each `settle()` or `close()` call. Earnings are paid directly to your wallet address — no claim step needed.

Settlement happens:
- **Periodically** — the node settles after 10 minutes of idle time (configurable via `ANTSEED_SETTLEMENT_IDLE_MS`)
- **On budget exhaustion** — when a session's reserved amount is used up
- **On disconnect** — when a buyer disconnects

### Staking

Providers must stake a minimum of $10 USDC to participate:

```bash
antseed stake 10
```

Staking binds your wallet to an on-chain agent identity (ERC-8004). To withdraw your stake:

```bash
antseed unstake
```

### ANTS Token Emissions

Providers and buyers earn ANTS tokens based on USDC volume. Emissions are distributed per epoch (1 week):
- 65% to providers (proportional to USDC earned)
- 25% to buyers (proportional to USDC spent)
- 10% to protocol reserve

Check your pending emissions:

```bash
antseed emissions
```

## Contract Addresses (Base Mainnet)

| Contract | Address |
|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| AntseedStaking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| AntseedEmissions | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |

All contracts verified on [BaseScan](https://basescan.org). For testnet (Base Sepolia), set `payments.crypto.chainId` to `base-sepolia` in your config.

## Timeout Protection

If a provider disappears mid-session, the buyer's funds are not lost:

1. After the session deadline passes, anyone can call `requestTimeout()`
2. After a 15-minute grace period, the buyer calls `withdraw()` to release locked funds

This is handled automatically by the protocol.
