---
sidebar_position: 3
slug: /config
title: Configuration
hide_title: true
---

# Configuration

After installation, initialize your node. This generates an Ed25519 identity keypair stored at `~/.antseed/identity.key` and creates default configuration.

```bash title="init"
$ antseed init
Generated node identity (Ed25519)
Created ~/.antseed/identity.key
Installed official plugins
Ready to connect
```

## Identity

Your node identity is an Ed25519 keypair. The private key seed is stored as 64 hex characters in `~/.antseed/identity.key` with `0600` permissions. Your PeerId is the hex-encoded 32-byte public key (64 lowercase hex characters).  
Set `identity.displayName` in config to control the human-readable name announced in peer metadata.

## Selling AI Services

To sell on the network, configure a provider plugin and declare your Skills. The provider handles the actual AI service — the protocol handles discovery, metering, and payments.

:::warning Provider Compliance
AntSeed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills, agent workflows, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`claude-code`, `claude-oauth`) are for local testing only.
:::

```bash title="seed"
$ antseed seed --provider anthropic
Announcing on DHT: antseed:anthropic
Metadata server listening on 0.0.0.0:6882
Seeding capacity...
```

You can also use `--instance <id>` to use a configured plugin instance, or override pricing at runtime with `--input-usd-per-million` and `--output-usd-per-million`.

## Buying AI Services

```bash title="connect"
$ antseed connect --router local
Router "Local Router" loaded
Connected to P2P network
Proxy listening on http://localhost:8377
```

The buyer proxy listens on `localhost:8377` by default. Your existing tools (Claude Code, Codex, etc.) point to this proxy instead of the upstream API. The router handles peer selection and failover transparently.

## Configuration File

Configuration is stored at `~/.antseed/config.json`. Key sections:

| Section | Description |
|---|---|
| `identity` | Display name and wallet address |
| `providers` | Configured provider API keys and endpoints |
| `seller` | Reserve floor, max concurrent buyers, pricing, enabled providers, model category tags |
| `buyer` | Preferred providers, max pricing, min peer reputation, proxy port |
| `payments` | Payment method, platform fee rate, chain config (Base) |
| `network` | Bootstrap nodes |
| `plugins` | Installed plugin packages |

## Metadata Fields

Use config to control metadata advertised to buyers:

```json title="config example"
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "serviceCategories": {
      "anthropic": {
        "claude-sonnet-4-5-20250929": ["coding", "privacy"]
      }
    }
  }
}
```

- `identity.displayName`: optional node label shown in browse/discovery results.
- `seller.serviceCategories`: optional provider/model -> tag array map announced in peer metadata.
- Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are allowed).

```bash title="set metadata fields"
antseed config set identity.displayName "Acme Inference - us-east-1"
antseed config seller set serviceCategories.anthropic.claude-sonnet-4-5-20250929 '["coding","privacy"]'
```

## Middleware (Skills Injection)

Providers can inject Markdown content into buyer requests server-side — before the upstream LLM call — without buyers seeing the additions. Configure this in the `seller.middleware` array:

```json title="config example"
{
  "seller": {
    "middleware": [
      { "file": "./skills/persona.md", "position": "system-prepend" },
      { "file": "./skills/output-format.md", "position": "append", "role": "user" },
      { "file": "./skills/sonnet-rules.md", "position": "system-append", "models": ["claude-sonnet-4-5", "claude-sonnet-4-6"] }
    ]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `file` | Yes | Path to a `.md` file, relative to config file or absolute |
| `position` | Yes | `system-prepend`, `system-append`, `prepend`, or `append` |
| `role` | No | Role for `prepend`/`append`. Defaults to `user` |
| `models` | No | Scope to specific model IDs. Omit to apply to all models. Must not be an empty list |

When `models` is set, the entry is only injected when the request's `model` field matches one of the listed IDs. Global entries (no `models`) apply to every request regardless of model.

## Authentication

Provider plugins authenticate with their upstream AI service. Credentials are stored locally and never leave the seller's machine. Authentication methods depend on the provider plugin:

| Provider | Auth Method |
|---|---|
| `anthropic` | API key via ANTHROPIC_API_KEY env var |
| `claude-code` | OAuth tokens from Claude Code keychain (automatic) — **testing only** |
| `claude-oauth` | OAuth access/refresh token pair — **testing only** |
| `openai` | API key via OPENAI_API_KEY env var (optional OPENAI_BASE_URL for OpenAI-compatible APIs) |
| `local-llm` | No auth needed (local Ollama/llama.cpp) |

## OpenAI-Compatible Model Aliases

When using the `openai` provider plugin, you can announce buyer-facing model names while forwarding different upstream model IDs.

Useful env vars:

- `ANTSEED_ALLOWED_MODELS`: announced model list (what buyers request)
- `OPENAI_UPSTREAM_MODEL_PREFIX`: prefix added before forwarding upstream
- `OPENAI_MODEL_ALIAS_MAP_JSON`: explicit announcedService -> upstreamService map

Example: announce `kimi2.5`, forward to Together as `together/kimi2.5`:

```bash
export ANTSEED_ALLOWED_MODELS="kimi2.5"
export OPENAI_UPSTREAM_MODEL_PREFIX="together/"
```

Example with explicit alias map:

```bash
export ANTSEED_ALLOWED_MODELS="kimi2.5,deepseek-v3"
export OPENAI_MODEL_ALIAS_MAP_JSON='{"kimi2.5":"together/kimi2.5","deepseek-v3":"openrouter/deepseek/deepseek-chat"}'
```
