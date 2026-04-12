# @antseed/provider-openai

Provide OpenAI-compatible API capacity on the AntSeed P2P network (OpenAI, Together, OpenRouter, and similar).

> **Important:** Simply reselling raw API access without adding value may violate your API provider's terms of service. AntSeed is designed for providers who build differentiated services on top of API access — for example, running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agents, fine-tuned models, or offering a managed product experience. Always review your API provider's usage policies before offering capacity on the network.

## Installation

```bash
antseed plugin add @antseed/provider-openai
```

## Usage

```bash
# Secrets go in env vars
export OPENAI_API_KEY=sk-...

# Everything else lives in config.json, set via the CLI
antseed config seller add-provider together --plugin openai --base-url https://api.together.ai
antseed config seller add-service together kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding

antseed seller start
```

## Configuration

Only upstream authentication and runtime toggles go in env vars. Pricing, categories, upstream model mapping, and the list of announced services all live under `seller.providers.<name>.services[id]` in `~/.antseed/config.json` (see [Configuration](/docs/config)).

If you set `baseUrl` in `config.json`, you do not need to export `OPENAI_BASE_URL` separately. `antseed seller start` reads the provider block and passes `baseUrl` into the plugin runtime automatically.

### Secrets (env vars)

| Key | Required | Description |
|-----|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI-compatible upstream API key |

### Runtime toggles (env vars, optional)

| Key | Default | Description |
|-----|---------|-------------|
| `OPENAI_PROVIDER_FLAVOR` | `generic` | Special handling profile (`generic`, `openrouter`) |
| `OPENAI_UPSTREAM_PROVIDER` | -- | Optional OpenRouter upstream provider selector |
| `OPENAI_EXTRA_HEADERS_JSON` | -- | Extra headers as JSON object |
| `OPENAI_BODY_INJECT_JSON` | -- | JSON object merged into request body |
| `OPENAI_STRIP_HEADER_PREFIXES` | -- | Comma-separated header prefixes to strip |

### Per-service config (config.json)

```bash
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --output 1.7 --cached 0.06 \
  --categories chat,math,coding

antseed config seller add-service together kimi-k2.5 \
  --upstream "moonshotai/Kimi-K2.5" \
  --input 0.5 --output 2.8 \
  --categories math,coding
```

The CLI reads `seller.providers.<name>.services[id]` and turns it into the flat env keys (`ANTSEED_SERVICE_ALIAS_MAP_JSON`, `ANTSEED_SERVICE_PRICING_JSON`, `ANTSEED_ALLOWED_SERVICES`) that this plugin's `configSchema` consumes internally. Categories are written directly onto `provider.serviceCategories` by the seller start path, not via env var. You should not set those env keys directly.

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to OpenAI-compatible APIs with `Authorization: Bearer` authentication.
