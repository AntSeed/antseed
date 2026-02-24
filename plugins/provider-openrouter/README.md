# @antseed/provider-openrouter

Sell OpenRouter API capacity on the Antseed P2P network. Supports multiple LLM providers through a single API key.

## Installation

```bash
antseed plugin add @antseed/provider-openrouter
```

## Usage

```bash
export OPENROUTER_API_KEY=sk-or-...
antseed seed --provider openrouter
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | secret | Yes | -- | OpenRouter API key |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 10 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 10 | Output token price (USD per 1M) |
| `ANTSEED_MODEL_PRICING_JSON` | string | No | -- | Per-model pricing as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 10 | Max concurrent requests |
| `ANTSEED_ALLOWED_MODELS` | string[] | No | -- | Comma-separated model allowlist |

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to the OpenRouter API with `Authorization: Bearer` authentication.
