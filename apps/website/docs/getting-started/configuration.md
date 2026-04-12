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
| `seller` | Per-provider service offerings (plugin, pricing, categories, upstream model mapping), reserve floor, max concurrent buyers, agent directory |
| `buyer` | Max pricing thresholds, proxy port |
| `payments` | Chain ID (`base-mainnet` by default) |
| `network` | Bootstrap nodes |

## Seller Shape

Everything a seller announces lives under `seller.providers[name]`. The key under `providers` is a user-chosen label, and `plugin` identifies the provider plugin package that powers it. The list of services, pricing, upstream model mapping, and normie-friendly category tags lives under `seller.providers[name].services[id]`.

```json
{
  "seller": {
    "reserveFloor": 10,
    "maxConcurrentBuyers": 5,
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "defaults": {
          "inputUsdPerMillion": 1,
          "outputUsdPerMillion": 2,
          "cachedInputUsdPerMillion": 0.1
        },
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "categories": ["chat", "math", "coding"],
            "pricing": {
              "inputUsdPerMillion": 0.60,
              "outputUsdPerMillion": 1.70,
              "cachedInputUsdPerMillion": 0.06
            }
          },
          "qwen3.5-9b": {
            "upstreamModel": "Qwen/Qwen3.5-9B",
            "categories": ["chat", "fast", "free"],
            "pricing": { "inputUsdPerMillion": 0, "outputUsdPerMillion": 0 }
          }
        }
      }
    }
  }
}
```

Each service entry supports three optional fields:

| Field | Type | Description |
|---|---|---|
| `upstreamModel` | string | The model id the provider plugin will forward requests to. Defaults to the service id itself. |
| `categories` | string[] | Normie-friendly tags announced in peer metadata (e.g. `chat`, `coding`, `math`, `study`, `fast`, `free`). |
| `pricing` | object | Per-service pricing in USD per million tokens. If omitted, the provider's `defaults` are used. |

`baseUrl` on the provider block is forwarded to plugins that honor it (the `openai` plugin uses it as `OPENAI_BASE_URL` for Together, OpenRouter, etc.).

## Adding a Provider (CLI)

Use `antseed config seller add-provider` to create a provider entry and install the matching plugin package:

```bash
# Add a provider backed by the openai plugin, pointed at Together AI
antseed config seller add-provider together \
  --plugin openai \
  --base-url https://api.together.ai \
  --input 1 --output 2

# Add another using the same plugin for OpenRouter
antseed config seller add-provider openrouter \
  --plugin openai \
  --base-url https://openrouter.ai/api/v1

# Remove a provider
antseed config seller remove-provider openrouter
```

## Adding a Service (CLI)

Use `antseed config seller add-service` to add a service entry in one shot:

```bash
antseed config seller add-service openai deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.60 --output 1.70 --cached 0.06 \
  --categories chat,math,coding \
  --base-url https://api.together.ai
```

To remove one:

```bash
antseed config seller remove-service openai deepseek-v3.1
```

You can also edit individual fields directly:

```bash
antseed config seller set providers.openai.services.deepseek-v3.1.pricing.inputUsdPerMillion 0.55
antseed config seller set providers.openai.services.deepseek-v3.1.categories '["chat","math","coding","fast"]'
```

## Buyer Pricing

Buyers can cap what they're willing to pay to avoid expensive providers:

```bash
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

## Identity and Metadata

```bash
antseed config set identity.displayName "Acme Inference - us-east-1"
antseed config seller set publicAddress "peer.example.com:6882"
```

## Provider Authentication

Provider plugins authenticate with their upstream AI service. Credentials live in environment variables — they never belong in `config.json`.

| Provider | Auth env var | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | |
| `openai` | `OPENAI_API_KEY` | Set `providers.<name>.baseUrl` in config.json for Together/OpenRouter/etc. |
| `claude-code` | keychain | Reads from `claude-code` secure storage |
| `local-llm` | none | Ollama/llama.cpp |

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

Only secrets and global toggles are set via env vars — everything else is in `config.json`.

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | Identity private key (64 hex chars, optional 0x prefix) |
| `ANTHROPIC_API_KEY` | Upstream Anthropic API key (used by the `anthropic` provider plugin) |
| `OPENAI_API_KEY` | Upstream OpenAI-compatible API key (used by the `openai` provider plugin) |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Idle time before settling a session (default: 600000 / 10 min) |
| `ANTSEED_DEFAULT_DEPOSIT_USDC` | Default lock amount per session (default: 1) |
| `ANTSEED_DEBUG` | Enable debug logging (set to 1) |
