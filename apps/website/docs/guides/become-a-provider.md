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

:::info Seller ANTS emissions
Starting from the current epoch, seller ANTS emissions are tracked but routed into a dedicated Provider Pool and locked for now. These incentives are not freely claimable yet. Future claimability is expected after stronger provider validation, audit, attestation, and proof systems are introduced, and may be subject to verification or slashing.
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
Every `antseed seller setup` / `antseed config seller ...` command is just a safe way to edit a single file: `~/.antseed/config.json`. You can open it in any editor at any time and change providers, services, pricing, capabilities, unit billing, categories, or `baseUrl` by hand — the CLI and the JSON file are interchangeable.

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

### Optional: Verify your domain and GitHub account

Production providers can attach public ownership proofs to their signed peer metadata. This helps buyers and directories recognize that a peer is operated by the same party that controls a domain or GitHub account.

These proofs bind to your **peer ID** — the EVM address derived from `ANTSEED_IDENTITY_HEX`. If your deployment uses a seller contract or staking proxy, do not put the contract address in the proof. Buyers verify seller-contract delegation separately.

To verify a domain with DNS, create a TXT record at `_antseed.<domain>`:

```text
Name:  _antseed.provider.example.com
Type:  TXT
Value: antseed-peer=<your-peer-id-without-0x>
```

Then add the claim to `~/.antseed/config.json`:

```json
{
  "seller": {
    "verifications": {
      "domains": [
        {
          "domain": "provider.example.com",
          "methods": ["dns-txt"]
        }
      ]
    }
  }
}
```

To verify GitHub, create a public repository containing `antseed.json` at the root:

```json
{
  "type": "antseed-github-verification",
  "peerId": "<your-peer-id-without-0x>",
  "username": "example-org"
}
```

Then add:

```json
{
  "seller": {
    "verifications": {
      "github": [
        {
          "username": "example-org",
          "repository": "antseed-verification"
        }
      ]
    }
  }
}
```

You can combine both `domains` and `github` under the same `seller.verifications` object. See [Configuration](/docs/config#domain-and-github-verification) for the full proof formats, including HTTPS well-known domain verification.

## 4. Recommended: Set a Custom Base RPC URL

Production sellers should use their own Base JSON-RPC endpoint instead of relying on public defaults. Public RPCs are useful for testing, but they can be rate limited, slow during traffic spikes, or unavailable when your node needs to reserve, settle, register, or stake on-chain.

Set the standard environment variable in your deployment shell:

```bash
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start
```

You can also pass it for a one-off seller run:

```bash
antseed seller start --base-rpc-url https://base-mainnet.infura.io/v3/<key>
```

For durable config-file based deployments, store it under `payments.crypto.rpcUrl`:

```bash
antseed config set payments.crypto.rpcUrl "https://base-mainnet.g.alchemy.com/v2/<key>"
```

Runtime precedence is: `--base-rpc-url` flag, then `ANTSEED_BASE_RPC_URL`, then `payments.crypto.rpcUrl`, then AntSeed's built-in Base defaults.

## 5. Fund Your Wallet

Your wallet address needs:
- **ETH** for gas fees (register, stake, settle transactions)
- **USDC** for staking (minimum $10)

Send both to the EVM address derived from your identity key. You can find your address with:

```bash
antseed seller status
```

## 6. Register and Stake

```bash
# Register your identity on-chain (ERC-8004)
antseed seller register

# Stake USDC (minimum $10)
antseed seller stake 10

# Verify everything is ready
antseed seller status
```

## 7. Add Your Services

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
  --capabilities '{"contextWindow":131072,"inputs":["text"],"toolUse":true}' \
  --categories chat,fast,free
```

```bash
# OpenAI Images: announce image inputs and charge per delivered image
antseed config seller add-service openai gpt-image-1 \
  --input 0 --output 0 \
  --categories image,creative \
  --capabilities '{"inputs":["text","image"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.04}]}}'
```

The `--upstream` flag maps the buyer-facing service name to the upstream model id. Omit it when they're the same.

Capability fields are optional discovery hints. Unit billing is currently supported by the `openai` provider for `openai-images`; startup warns if a different plugin ignores the setting. Image services remain advertised but are skipped by periodic health checks to avoid generating paid probe images.

You only have to do this once per service. To see what you've configured:

```bash
antseed config seller show
```

## 8. Set Your API Key and Start Selling

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

## 9. Verify

Once running, your node is discoverable on the network:

```bash
# From another terminal, browse available providers
antseed network browse
```

For production monitoring, expose seller metrics with `antseed metrics serve --role seller`. See [Metrics](/docs/guides/metrics).

:::warning Upgrade buyers before sellers
This release emits discovery metadata v12. Older buyers reject newer metadata and will not see upgraded sellers. Follow the [metadata v12 upgrade guide](/docs/guides/metadata-v12-upgrade) when rolling out a mixed buyer/seller fleet.
:::

## How Payments Work

1. A buyer connects and sends a ReserveAuth (session budget)
2. Your node calls `reserve()` on-chain to lock buyer funds
3. Requests flow freely — each one gets a SpendingAuth (cumulative spend authorization)
4. Your node calls `settle()` periodically to collect earned USDC
5. On session end, `close()` finalizes and releases remaining buyer funds

USDC earnings are paid directly to your wallet address on each `settle()` or `close()` call. No claim step needed for USDC.

Seller-side ANTS emissions are different: they are currently tracked but locked in the Provider Pool while stronger validation systems are developed. Provider ANTS claims may become available later and may be subject to verification or slashing.

:::warning Real usage only
ANTS incentives are designed for real provider contribution. Farming, fake volume, sybil behavior, spam, or value extraction may be capped, excluded, delayed, locked, or subject to future slashing.
:::

## Next Steps

- [Ant Agent](/docs/provider-api#ant-agent) — wrap your service with a knowledge-augmented agent
- [Configuration](/docs/config) — full config reference
- [CLI Commands](/docs/commands) — all available commands
- [Metrics](/docs/guides/metrics) — monitor seller earnings, channels, requests, and tokens

## Agent Skills

If you're using Claude Code or another agent, this skill can walk you through the full provider setup:

- [`@skills/join-provider`](https://github.com/AntSeed/antseed/tree/main/skills/join-provider) — step-by-step provider setup for Claude Code agents
