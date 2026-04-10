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

## 5. Add Your Services

Everything you announce on the network lives in `config.json` under `seller.providers[name].services[id]`. One block per upstream provider plugin, one entry per service. The `add-service` command builds this for you:

```bash
# Anthropic: offer claude-sonnet at $3/$15 per million tokens, tagged for chat + coding
antseed config seller add-service anthropic claude-sonnet-4-6 \
  --input 3 --cached 0.3 --output 15 \
  --categories chat,coding
```

```bash
# Together AI (OpenAI-compatible): offer Kimi K2.5 and DeepSeek V3.1
antseed config seller add-service openai kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding \
  --base-url https://api.together.ai

antseed config seller add-service openai deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --output 1.7 \
  --categories chat,math,coding
```

```bash
# Local model (Ollama) — one announced service per local model
antseed config seller add-service local-llm llama3.2:3b \
  --input 0 --output 0 \
  --categories chat,fast,free
```

The `--upstream` flag maps the buyer-facing service name to the upstream model id. Omit it when they're the same.

You only have to do this once per service. To see what you've configured:

```bash
antseed config seller show
```

## 6. Set Your API Key and Start Seeding

Upstream credentials stay in environment variables — nothing about auth goes into `config.json`:

```bash
# Anthropic
export ANTHROPIC_API_KEY=<your-key>
antseed seed --provider anthropic

# OpenAI-compatible (Together AI, OpenRouter, etc.)
export OPENAI_API_KEY=<your-key>
antseed seed --provider openai

# Local model
antseed seed --provider local-llm
```

Runtime overrides for a one-off session (without editing `config.json`):

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

## Next Steps

- [Ant Agent](/docs/provider-api#ant-agent) — wrap your service with a knowledge-augmented agent
- [Configuration](/docs/config) — full config reference
- [CLI Commands](/docs/commands) — all available commands

## Agent Skills

If you're using Claude Code or another agent, this skill can walk you through the full provider setup:

- [`@skills/join-provider`](https://github.com/AntSeed/antseed/tree/main/skills/join-provider) — step-by-step provider setup for Claude Code agents
