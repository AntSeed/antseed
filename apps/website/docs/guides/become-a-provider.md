---
sidebar_position: 1
slug: /guides/become-a-provider
title: Become a Provider
hide_title: true
---

# Become a Provider

Providers earn USDC by serving AI requests on the AntSeed network. This guide covers everything from setup to your first request.

:::warning Provider Compliance
AntSeed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills or agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Providers are solely responsible for complying with their upstream API provider's terms.
:::

## Prerequisites

- Node.js 20+
- An AI API key (Anthropic, OpenAI, Together AI, or a local model)
- A secp256k1 private key (your node identity)
- ETH on Base Mainnet (for gas, ~$0.01 per transaction)
- USDC on Base Mainnet (minimum $10 for staking)

## 1. Install

```bash
npm install -g @antseed/cli
```

## 2. Set Up Your Provider

Use the interactive wizard for first-time setup:

```bash
antseed seller setup
```

This creates or updates `~/.antseed/config.json`. Once that file contains your provider and service definitions, the normal runtime command is just `antseed seller start`.

Or configure it manually:

```bash
antseed config seller add-provider together \
  --plugin openai \
  --base-url https://api.together.ai \
  --input 1 --cached 0.1 --output 2
```

`--cached` is optional and sets the default cached-input price in USD per 1M tokens. Use it when your upstream charges a reduced rate for cache hits (Anthropic, OpenAI, some Together models).

Then add one or more services:

```bash
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --cached 0.06 --output 1.7 \
  --categories chat,math,coding
```

:::tip You're editing `~/.antseed/config.json`
Every `antseed seller setup` / `antseed config seller ...` command is just a safe way to edit a single file: `~/.antseed/config.json`. You can open it in any editor at any time and change providers, services, pricing, categories, or `baseUrl` by hand — the CLI and the JSON file are interchangeable.

After running the commands above, your file will look something like this:

```json
{
  "seller": {
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "defaults": {
          "inputUsdPerMillion": 1,
          "cachedInputUsdPerMillion": 0.1,
          "outputUsdPerMillion": 2
        },
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "pricing": {
              "inputUsdPerMillion": 0.6,
              "cachedInputUsdPerMillion": 0.06,
              "outputUsdPerMillion": 1.7
            },
            "categories": ["chat", "math", "coding"]
          }
        }
      }
    }
  }
}
```

See [Configuration](/docs/config) for the full schema, or run `antseed config seller show` to print your current file.
:::

## 3. Set Your Identity

Your identity is a secp256k1 private key that serves as both your PeerId and your on-chain wallet address.

```bash
export ANTSEED_IDENTITY_HEX=<your-64-char-hex-private-key>
```

:::tip
Use a dedicated key for your provider node. Generate one with any EVM wallet tool. The corresponding address is where you'll receive USDC earnings.
:::

## 4. Fund Your Wallet

Your wallet address needs:
- **ETH** for gas fees (register, stake, settle transactions)
- **USDC** for staking (minimum $10)

Send both to the EVM address derived from your identity key. You can find your address with:

```bash
antseed seller status
```

## 5. Register and Stake

```bash
# Register your identity on-chain (ERC-8004)
antseed seller register

# Stake USDC (minimum $10)
antseed seller stake 10

# Verify everything is ready
antseed seller status
```

## 6. Add Your Services

Everything you announce on the network lives in `config.json` under `seller.providers[name].services[id]`. One block per upstream provider plugin, one entry per service. The `add-service` command builds this for you:

```bash
# Anthropic: offer claude-sonnet at $3/$15 per million tokens, tagged for chat + coding
antseed config seller add-service anthropic claude-sonnet-4-6 \
  --input 3 --cached 0.3 --output 15 \
  --categories chat,coding
```

```bash
# Together AI (OpenAI-compatible): offer Kimi K2.5 and DeepSeek V3.1
antseed config seller add-service together kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding \
  --base-url https://api.together.ai

# --cached is optional — set it when your upstream offers
# a discounted price for cached-input tokens
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --cached 0.06 --output 1.7 \
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

## 7. Set Your API Key and Start Selling

Upstream credentials stay in environment variables. Your provider shape, service list, pricing, and `baseUrl` stay in `config.json`.

That means the common startup flow is:

```bash
# Anthropic config in config.json, secret in env
export ANTHROPIC_API_KEY=<your-key>
antseed seller start

# OpenAI-compatible config in config.json, secret in env
export OPENAI_API_KEY=<your-key>
antseed seller start

# Local model
antseed seller start
```

If you configured Together or OpenRouter with `--base-url` during setup, you do not need to export `OPENAI_BASE_URL` separately. `antseed seller start` reads `baseUrl` from `config.json` and passes it to the `openai` plugin automatically.

Runtime overrides for a one-off session (without editing `config.json`):

```bash
antseed seller start --provider anthropic --input-usd-per-million 3 --output-usd-per-million 15
```

## 8. Verify

Once running, your node is discoverable on the network:

```bash
# From another terminal, browse available providers
antseed network browse
```

For production monitoring, expose seller metrics with `antseed metrics serve --role seller`. See [Metrics](/docs/guides/metrics).

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
- [Metrics](/docs/guides/metrics) — monitor seller earnings, channels, requests, and tokens

## Agent Skills

If you're using Claude Code or another agent, this skill can walk you through the full provider setup:

- [`@skills/join-provider`](https://github.com/AntSeed/antseed/tree/main/skills/join-provider) — step-by-step provider setup for Claude Code agents
