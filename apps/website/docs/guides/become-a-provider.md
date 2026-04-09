---
sidebar_position: 1
slug: /guides/become-a-provider
title: Become a Provider
hide_title: true
---

# Become a Provider

Providers earn USDC by serving AI requests on the AntSeed network. This guide covers everything from setup to your first request.

## Prerequisites

- Node.js 20+
- An AI API key (Anthropic, OpenAI, Together AI, or a local model)
- A secp256k1 private key (your node identity)
- ETH on Base Mainnet (for gas, ~$0.01 per transaction)
- USDC on Base Mainnet (minimum $10 for staking)

## 1. Install

```bash
npm install -g @antseed/cli
antseed init
```

## 2. Set Your Identity

Your identity is a secp256k1 private key that serves as both your PeerId and your on-chain wallet address.

```bash
export ANTSEED_IDENTITY_HEX=<your-64-char-hex-private-key>
```

:::tip
Use a dedicated key for your provider node. Generate one with any EVM wallet tool. The corresponding address is where you'll receive USDC earnings.
:::

## 3. Fund Your Wallet

Your wallet address needs:
- **ETH** for gas fees (register, stake, settle transactions)
- **USDC** for staking (minimum $10)

Send both to the EVM address derived from your identity key. You can find your address with:

```bash
antseed status
```

## 4. Register and Stake

```bash
# Register your identity on-chain (ERC-8004)
antseed register

# Stake USDC (minimum $10)
antseed stake 10

# Verify everything is ready
antseed setup --role provider
```

## 5. Configure Your Provider

Set your upstream API key and start providing:

```bash
# Anthropic
export ANTHROPIC_API_KEY=<your-key>
antseed seed --provider anthropic
```

```bash
# OpenAI
export OPENAI_API_KEY=<your-key>
antseed seed --provider openai
```

```bash
# Together AI / OpenRouter / any OpenAI-compatible API
export OPENAI_API_KEY=<your-key>
export OPENAI_BASE_URL=https://api.together.ai
antseed seed --provider openai
```

```bash
# Local model (Ollama)
antseed seed --provider local-llm
```

## 6. Set Pricing

Pricing is in USD per million tokens. Defaults apply to all services unless overridden.

```bash
# Set default pricing
antseed config seller set pricing.defaults.inputUsdPerMillion 3
antseed config seller set pricing.defaults.cachedInputUsdPerMillion 0.3
antseed config seller set pricing.defaults.outputUsdPerMillion 15

# Per-service override
antseed config seller set pricing.services '{"claude-sonnet-4-6":{"inputUsdPerMillion":3,"cachedInputUsdPerMillion":0.3,"outputUsdPerMillion":15}}'
```

Or set pricing at runtime:

```bash
antseed seed --provider anthropic --input-usd-per-million 3 --output-usd-per-million 15
```

## 7. Verify

Once running, your node is discoverable on the network:

```bash
# From another terminal, browse available providers
antseed browse
```

## How Payments Work

1. A buyer connects and sends a ReserveAuth (session budget)
2. Your node calls `reserve()` on-chain to lock buyer funds
3. Requests flow freely — each one gets a SpendingAuth (cumulative spend authorization)
4. Your node calls `settle()` periodically to collect earned USDC
5. On session end, `close()` finalizes and releases remaining buyer funds

Earnings are paid directly to your wallet address on each `settle()` or `close()` call. No claim step needed.

## Service Aliases

When using the `openai` provider, you can announce buyer-facing service names while forwarding different upstream IDs:

```bash
export ANTSEED_ALLOWED_SERVICES="deepseek-v3.1,kimi-k2.5"
export OPENAI_SERVICE_ALIAS_MAP_JSON='{"deepseek-v3.1":"deepseek-ai/DeepSeek-V3.1","kimi-k2.5":"moonshotai/Kimi-K2.5"}'
antseed seed --provider openai
```

## Next Steps

- [Ant Agent](/provider-api#ant-agent) — wrap your service with a knowledge-augmented agent
- [Configuration](/config) — full config reference
- [CLI Commands](/cli/commands) — all available commands
