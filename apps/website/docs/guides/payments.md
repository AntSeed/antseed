---
sidebar_position: 3
slug: /guides/payments
title: Payments
hide_title: true
---

# Payments

AntSeed uses USDC on Base Mainnet for all payments. Buyers pre-deposit USDC, providers earn per request, and everything settles on-chain automatically.

## For Buyers

### Depositing USDC

The recommended way to deposit is `antseed buyer deposit`:

```bash
antseed buyer deposit
```

It prints your node's funding address and a QR code (an EIP-681 payment request any mobile wallet can scan). Send USDC on Base to that address from anywhere — another wallet, an exchange withdrawal, a card on-ramp — and the incoming funds are deposited into your credits automatically: your node signs a gasless authorization and a permissionless relayer submits the transaction for a fixed USDC fee ($0.05 on Base Mainnet). Your node's hot wallet never needs ETH.

Prefer a browser wallet? While watching, the command also serves the connected-wallet checkout page and prints its link (`http://127.0.0.1:3118?token=…`). Open it, connect MetaMask / Coinbase Wallet / Rabby, and the deposit goes straight into the Deposits contract — the command detects the credit and finishes either way.

While `antseed buyer start` is running, this sweeping also happens automatically in the background whenever USDC lands in the hot wallet (disable with `buyer.autoSweep: false` in your config).

| Option | Purpose |
|---|---|
| `--amount <usdc>` | Amount to prefill in the QR payment request and browser checkout |
| `--no-watch` | Print the address and QR code without waiting for funds |
| `--onchain <usdc>` | Direct on-chain deposit from the hot wallet (requires ETH for gas) |

:::tip Third-Party Funding
Anyone can fund a buyer — a team treasury, a hardware wallet, or another contract. The funding source is decoupled from the node identity.
:::

### Sweeping Hot-Wallet USDC Manually

`antseed buyer deposit` and the running buyer sweep incoming USDC for you; `antseed buyer sweep` triggers the same gasless sweep once, on demand:

```bash
antseed buyer sweep
```

The CLI signs an EIP-3009 authorization offline and broadcasts it over the P2P network. A permissionless relayer submits the transaction, pays the gas, and keeps a fixed USDC fee ($0.05 on Base Mainnet); the rest is credited to your deposits balance. If a buyer daemon (`antseed buyer start`) is running, the request goes out over its existing seller connections — otherwise the CLI joins the network with a temporary node.

| Option | Purpose |
|---|---|
| `--amount <usdc>` | Amount to sweep (default: full hot-wallet balance, clamped to your credit-limit headroom) |
| `--timeout <secs>` | How long to wait for on-chain confirmation (default: 120) |

The swept amount must exceed the fixed relay fee, and a first-ever deposit must net at least 1 USDC after the fee. Your funds never move unless a relayer lands the transaction — the authorization simply expires after an hour.

### Checking Balance and Activity

```bash
antseed buyer balance    # wallet + deposits balances
antseed buyer activity   # tokens, spending history, measured savings, active channels
```

`antseed buyer activity` mirrors the desktop app's Activity view: lifetime tokens/spent/saved, a per-day spending chart (`--days 7|30|90`), active channels with their locked amounts and channel IDs, and ANTS emissions available to claim (`antseed buyer emissions claim`). It needs the buyer connection running (`antseed buyer start`).

### Withdrawing

```bash
antseed buyer withdraw 5
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

### Base RPC Endpoint

Production providers should use a dedicated Base JSON-RPC endpoint so reserve, settle, close, register, and stake calls are not dependent on public RPC rate limits.

```bash
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start
```

For a one-off run, use `antseed seller start --base-rpc-url <url>`. For durable config, set `payments.crypto.rpcUrl` in `~/.antseed/config.json`.

### Relaying Deposit Sweeps

Sellers relay buyer deposit sweeps by default: the node verifies and simulates each incoming sweep request, submits it on-chain, and earns the fixed relay fee (minus gas). Opt out with `relayer.enabled: false` in your config, or tune the profitability floor with `relayer.minProfitBaseUnits`.

### Staking

Providers must stake a minimum of $10 USDC to participate:

```bash
antseed seller stake 10
```

Staking binds your wallet to an on-chain agent identity (ERC-8004). To withdraw your stake:

```bash
antseed seller unstake
```

### ANTS Token Emissions

Providers and buyers earn ANTS tokens based on eligible USDC volume. Emissions are distributed per epoch (1 week):
- 50% to providers (proportional to USDC earned, capped at 50% of the seller bucket per seller per epoch)
- 20% to buyers (proportional to USDC spent, capped at 5% of the buyer bucket per buyer per epoch)
- 15% to protocol reserve, plus seller and buyer cap overages
- 15% to contributors/team

Check your pending emissions:

```bash
antseed seller emissions info
```

## Contract Addresses (Base Mainnet)

| Contract | Address |
|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| AntseedStaking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| AntseedDepositRelay | `0x34a44542e76f9b4cff3a31902eDF14AbF2C3B3DD` |
| AntseedEmissionsV2 | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |

All contracts verified on [BaseScan](https://basescan.org). For testnet (Base Sepolia), set `payments.crypto.chainId` to `base-sepolia` in your config.

## Timeout Protection

If a provider disappears mid-session, the buyer's funds are not lost:

1. The buyer (or their deposits operator) calls `requestClose()` on AntseedChannels — callable anytime while the channel is active
2. After a 15-minute grace period (so the seller can still submit a final SpendingAuth), the buyer calls `withdraw()` to release remaining locked funds back to their deposit

If the seller is still online, the buyer can instead request a cooperative close and skip the grace period. Desktop and CLI expose both paths.
