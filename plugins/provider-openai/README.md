# @antseed/provider-openai

Provide OpenAI-compatible API capacity on the AntSeed P2P network (OpenAI, Together, OpenRouter, and similar).

> **Important:** Simply reselling raw API access without adding value may violate your API provider's terms of service. AntSeed is designed for providers who build differentiated services on top of API access — for example, running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agents, fine-tuned models, or offering a managed product experience. Always review your API provider's usage policies before offering capacity on the network.

## Installation

```bash
antseed plugin add @antseed/provider-openai
```

## Usage

```bash
export OPENAI_API_KEY=sk-...
antseed seed --provider openai
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `OPENAI_API_KEY` | secret | Yes | -- | OpenAI-compatible upstream API key |
| `OPENAI_BASE_URL` | string | No | `https://api.openai.com` | Upstream base URL |
| `OPENAI_PROVIDER_FLAVOR` | string | No | `generic` | Special handling profile (`generic`, `openrouter`) |
| `OPENAI_UPSTREAM_PROVIDER` | string | No | -- | Optional OpenRouter upstream provider selector |
| `OPENAI_UPSTREAM_MODEL_PREFIX` | string | No | -- | Optional prefix added to announced model names when forwarding upstream (example: `together/`) |
| `OPENAI_MODEL_ALIAS_MAP_JSON` | string | No | -- | Optional JSON map of `announcedModel -> upstreamModel` |
| `OPENAI_EXTRA_HEADERS_JSON` | string | No | -- | Extra headers as JSON object |
| `OPENAI_BODY_INJECT_JSON` | string | No | -- | JSON object merged into request body |
| `OPENAI_STRIP_HEADER_PREFIXES` | string[] | No | -- | Comma-separated header prefixes to strip |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 10 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 10 | Output token price (USD per 1M) |
| `ANTSEED_MODEL_PRICING_JSON` | string | No | -- | Per-model pricing as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 10 | Max concurrent requests |
| `ANTSEED_ALLOWED_MODELS` | string[] | No | -- | Comma-separated model allowlist |

Example: announce `kimi2.5` on AntSeed while forwarding to Together model `together/kimi2.5` upstream:

```bash
export ANTSEED_ALLOWED_MODELS="kimi2.5"
export OPENAI_UPSTREAM_MODEL_PREFIX="together/"
```

Example: explicit per-model alias mapping:

```bash
export ANTSEED_ALLOWED_MODELS="kimi2.5,deepseek-v3"
export OPENAI_MODEL_ALIAS_MAP_JSON='{"kimi2.5":"together/kimi2.5","deepseek-v3":"openrouter/deepseek/deepseek-chat"}'
```

When both are set, `OPENAI_MODEL_ALIAS_MAP_JSON` entries take precedence over `OPENAI_UPSTREAM_MODEL_PREFIX` for matching announced models.

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to OpenAI-compatible APIs with `Authorization: Bearer` authentication.
