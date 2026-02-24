# @antseed/provider-anthropic

Sell Anthropic API capacity on the Antseed P2P network using an API key.

## Installation

```bash
antseed plugin add @antseed/provider-anthropic
```

## Usage

```bash
export ANTHROPIC_API_KEY=sk-ant-...
antseed seed --provider anthropic
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | secret | Yes | -- | Anthropic API key |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 10 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 10 | Output token price (USD per 1M) |
| `ANTSEED_MODEL_PRICING_JSON` | string | No | -- | Per-model pricing as JSON |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 10 | Max concurrent requests |
| `ANTSEED_ALLOWED_MODELS` | string[] | No | -- | Comma-separated model allowlist |

## Per-Model Pricing

Override pricing for specific models:

```bash
export ANTSEED_MODEL_PRICING_JSON='{"claude-sonnet-4-5-20250929":{"inputUsdPerMillion":12,"outputUsdPerMillion":18}}'
```

## How It Works

Uses `BaseProvider` and `StaticTokenProvider` from `@antseed/provider-core` to relay requests to `https://api.anthropic.com` with `x-api-key` authentication.
