# @antseed/router-local-proxy

Local HTTP proxy router for AI coding tools. Drop-in replacement for `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` that routes requests through the Antseed P2P network.

## Installation

```bash
antseed plugin add @antseed/router-local-proxy
```

## Usage

```bash
antseed connect --router local-proxy

# Then configure your tools:
export ANTHROPIC_BASE_URL=http://localhost:8377
```

Works with Claude Code, Aider, Continue.dev, OpenAI Codex, and any tool that supports custom base URLs.

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `ANTSEED_MIN_REPUTATION` | number | No | 50 | Minimum peer reputation (0-100) |
| `ANTSEED_PREFERRED_PROVIDERS` | string[] | No | -- | Ordered list of preferred providers |
| `ANTSEED_MAX_PRICING_JSON` | string | No | -- | Max pricing config as JSON |
| `ANTSEED_MAX_FAILURES` | number | No | 3 | Max failures before cooldown |
| `ANTSEED_FAILURE_COOLDOWN_MS` | number | No | 30000 | Cooldown duration after failures (ms) |
| `ANTSEED_MAX_PEER_STALENESS_MS` | number | No | 300000 | Max age of peer info before deprioritizing |

## Max Pricing

Set maximum prices you're willing to pay:

```bash
export ANTSEED_MAX_PRICING_JSON='{"defaults":{"inputUsdPerMillion":20,"outputUsdPerMillion":60}}'
```

Or with per-provider overrides:

```bash
export ANTSEED_MAX_PRICING_JSON='{"defaults":{"inputUsdPerMillion":20,"outputUsdPerMillion":60},"providers":{"anthropic":{"models":{"claude-sonnet-4-5-20250929":{"inputUsdPerMillion":15,"outputUsdPerMillion":75}}}}}'
```

## How It Works

Uses `scoreCandidates` and `PeerMetricsTracker` from `@antseed/router-core`. Scores peers on price, latency, capacity, reputation, freshness, and reliability. Enforces max pricing limits and preferred provider ordering. Peers that exceed price limits or fail repeatedly are excluded.
