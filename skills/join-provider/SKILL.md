# Join AntSeed as a Provider

Help the user set up an AntSeed node to provide AI services on the peer-to-peer network. Walk them through installation, initialization, provider configuration, pricing, and starting the seeder.

## Terms of Use — Read First

> **AntSeed is designed for providers who add value on top of AI APIs — not for raw resale of API keys or subscription access.**
>
> Acceptable use cases include: running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agent workflows, serving fine-tuned or self-hosted models, or building a managed product experience.
>
> **Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for local testing and development only.** Reselling personal subscription credentials (e.g., Claude Pro/Team plans) violates Anthropic's Terms of Service and is not permitted.
>
> Always review your upstream API provider's usage policies before offering capacity on the network. AntSeed provides the infrastructure; compliance with third-party terms is the provider's responsibility.

## Overview

A **provider** offers AI services (Anthropic, OpenRouter, local LLMs, etc.) on the AntSeed network. Buyers pay per-token in USDC. The provider runs a seeder daemon that announces availability on the DHT and handles incoming inference requests.

## Step 1: Install the CLI

```bash
npm install -g @antseed/cli
```

Verify with `antseed --version`. Requires Node.js 20+.

## Step 2: Initialize the node

```bash
antseed init
```

This does three things:
- Installs all trusted plugins (provider + router) from npm
- Generates an Ed25519 identity keypair at `~/.antseed/identity.key`
- Creates default config at `~/.antseed/config.json`

If the user already knows their provider type and API key, shortcut with:

```bash
antseed init --auth-type apikey --api-key <KEY>
```

## Step 3: Configure provider credentials

Ask the user which AI provider they want to use:

| Provider | Plugin | Auth | Notes |
|---|---|---|---|
| Anthropic | `@antseed/provider-anthropic` | API key (`x-api-key`) | Commercial API key required |
| OpenAI-compatible | `@antseed/provider-openai` | API key | OpenAI, Together, OpenRouter and similar |
| Local LLM | `@antseed/provider-local-llm` | None (Ollama/llama.cpp) | Self-hosted, no restrictions |
| Claude Code | `@antseed/provider-claude-code` | Auto-loaded from keychain | **Testing only** — not for production |
| Claude OAuth | `@antseed/provider-claude-oauth` | OAuth token pair | **Testing only** — not for production |

For API key providers:

```bash
antseed config add-provider -t <type> -k <API_KEY>
```

For Claude Code keychain (no key needed):

```bash
antseed config add-provider -t claude-code
```

For local LLM (Ollama must be running):

```bash
antseed config add-provider -t local-llm
```

## Step 4: Set pricing

Help the user set competitive pricing. Defaults are in USD per 1 million tokens.

```bash
# Global defaults
antseed config seller set pricing.defaults.inputUsdPerMillion 12
antseed config seller set pricing.defaults.outputUsdPerMillion 36

# Per-provider overrides (optional)
antseed config seller set pricing.providers.anthropic.defaults.inputUsdPerMillion 15
antseed config seller set pricing.providers.anthropic.defaults.outputUsdPerMillion 45

# Per-service overrides (optional)
antseed config seller set pricing.providers.anthropic.services.claude-3-haiku.inputUsdPerMillion 5
antseed config seller set pricing.providers.anthropic.services.claude-3-haiku.outputUsdPerMillion 15
```

Also configure capacity limits:

```bash
# Max simultaneous buyer sessions
antseed config seller set maxConcurrentBuyers 5

# Messages to reserve for yourself
antseed config seller set reserveFloor 10
```

## Step 5: Start seeding

```bash
antseed seed --provider <type>
```

Example: `antseed seed --provider anthropic`

The seeder will:
1. Validate credentials with the provider API
2. Join the P2P network and announce on the DHT
3. Listen for buyer connections via WebRTC/TCP
4. Log active sessions with latency and token usage

Output displays: Peer ID, DHT port, signaling port, effective pricing, and live session stats.

To override pricing at runtime without saving to config:

```bash
antseed seed --provider anthropic \
  --input-usd-per-million 15 \
  --output-usd-per-million 45 \
  --reserve 20
```

## Step 6: Monitor with dashboard (optional)

In a separate terminal:

```bash
antseed dashboard
```

Opens a web UI at `http://localhost:3117` showing live network stats, active sessions, and earnings.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `~/.antseed/identity.key` exists
- [ ] `~/.antseed/config.json` has provider credentials
- [ ] `antseed seed --provider <type>` starts without errors
- [ ] Seeder announces on DHT (log shows peer ID and ports)
- [ ] Dashboard shows the node as active (optional)

## Troubleshooting

- **"No provider configured"**: Run `antseed config add-provider -t <type> -k <KEY>`
- **"Invalid credentials"**: Verify the API key works directly: `curl -H "x-api-key: <KEY>" https://api.anthropic.com/v1/messages ...`
- **"DHT announce failed"**: Check firewall allows UDP on the DHT port (random high port). Try `--verbose` flag.
- **Native module errors**: Run `antseed init` again to reinstall plugins, or manually: `npm install -g @antseed/cli`
