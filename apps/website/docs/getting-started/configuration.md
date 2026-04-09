---
sidebar_position: 3
slug: /config
title: Configuration
hide_title: true
---

# Configuration

Configuration is stored at `~/.antseed/config.json`. Use `antseed config` commands or edit the file directly.

## Config Sections

| Section | Description |
|---|---|
| `identity` | Display name |
| `seller` | Pricing, max concurrent buyers, service categories, agent directory |
| `buyer` | Max pricing thresholds, proxy port |
| `payments` | Chain ID (`base-mainnet` by default) |
| `network` | Bootstrap nodes |
| `plugins` | Installed plugin packages |

## Pricing

Pricing is in USD per million tokens. Set defaults and optional per-service overrides:

```bash
# Defaults
antseed config seller set pricing.defaults.inputUsdPerMillion 3
antseed config seller set pricing.defaults.cachedInputUsdPerMillion 0.3
antseed config seller set pricing.defaults.outputUsdPerMillion 15

# Per-service override
antseed config seller set pricing.services '{"claude-sonnet-4-6":{"inputUsdPerMillion":3,"cachedInputUsdPerMillion":0.3,"outputUsdPerMillion":15}}'
```

Or set at runtime without modifying the config file:

```bash
antseed seed --provider anthropic --input-usd-per-million 3 --output-usd-per-million 15
```

Buyers can set max pricing thresholds to avoid expensive providers:

```bash
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

## Identity and Metadata

```bash
# Set display name (shown in browse/discovery)
antseed config set identity.displayName "Acme Inference - us-east-1"

# Set service category tags (announced in peer metadata)
antseed config seller set serviceCategories.anthropic.claude-sonnet-4-6 '["coding","privacy"]'
```

Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee`. Custom tags are allowed.

## Provider Authentication

Provider plugins authenticate with their upstream AI service. Credentials are set via environment variables and never leave the machine:

| Provider | Auth |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL` for Together, OpenRouter, etc.) |
| `local-llm` | No auth needed (Ollama/llama.cpp) |

## Service Aliases

When using the `openai` provider, announce buyer-facing service names while forwarding different upstream IDs:

```bash
export ANTSEED_ALLOWED_SERVICES="deepseek-v3.1,kimi-k2.5"
export OPENAI_SERVICE_ALIAS_MAP_JSON='{"deepseek-v3.1":"deepseek-ai/DeepSeek-V3.1","kimi-k2.5":"moonshotai/Kimi-K2.5"}'
antseed seed --provider openai
```

## Ant Agent

Providers can wrap their service with an ant agent — a knowledge-augmented AI service that injects a persona, guardrails, and on-demand knowledge into buyer requests.

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest defining persona, guardrails, knowledge modules, and custom tools. The LLM decides which knowledge to load during the conversation. Buyers see only the final response.

Per-service agents (different agents for different services):

```json
{
  "seller": {
    "agentDir": {
      "social-strategist": "./agents/social",
      "code-reviewer": "./agents/coding",
      "*": "./agents/default"
    }
  }
}
```

See the [`@antseed/ant-agent` README](https://github.com/AntSeed/antseed/tree/main/packages/ant-agent) for the full manifest reference.

## Identity Storage

| Priority | Method | Best for |
|---|---|---|
| 1 | `ANTSEED_IDENTITY_HEX` env var | CLI and server deployments |
| 2 | Desktop keychain (Electron `safeStorage`) | AntSeed Desktop app |
| 3 | Custom `IdentityStore` | KMS/HSM integrations |
| 4 | `~/.antseed/identity.key` (plaintext) | Not recommended for production |

For production servers, pass the key from a secrets manager:

```bash
export ANTSEED_IDENTITY_HEX="$(vault kv get -field=key secret/antseed/identity)"
```

## Runtime Environment Variables

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | Identity private key (64 hex chars, optional 0x prefix) |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Idle time before settling a session (default: 600000 / 10 min) |
| `ANTSEED_DEFAULT_DEPOSIT_USDC` | Default lock amount per session (default: 1) |
| `ANTSEED_DEBUG` | Enable debug logging (set to 1) |
| `ANTSEED_ALLOWED_SERVICES` | Comma-separated list of services to announce |
