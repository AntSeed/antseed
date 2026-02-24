# @antseed/router-local-chat

Latency-prioritized router for the Antseed desktop chat application. Optimizes peer selection for interactive conversations where response time matters most.

## Installation

```bash
antseed plugin add @antseed/router-local-chat
```

## Usage

```bash
antseed connect --router local-chat
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `ANTSEED_MIN_REPUTATION` | number | No | 50 | Minimum peer reputation (0-100) |
| `ANTSEED_MAX_FAILURES` | number | No | 3 | Max failures before cooldown |
| `ANTSEED_FAILURE_COOLDOWN_MS` | number | No | 30000 | Cooldown duration after failures (ms) |
| `ANTSEED_MAX_PEER_STALENESS_MS` | number | No | 300000 | Max age of peer info before deprioritizing |

## Scoring Weights

Tuned for interactive chat -- latency is weighted highest:

| Factor | Weight |
|--------|--------|
| latency | 0.35 |
| capacity | 0.20 |
| price | 0.15 |
| reputation | 0.15 |
| freshness | 0.10 |
| reliability | 0.05 |

## How It Works

Uses `scoreCandidates` and `PeerMetricsTracker` from `@antseed/router-core`. Peers that fail repeatedly are placed on cooldown. Stale peers are deprioritized. Among equal-scored peers, deterministic tie-breaking ensures consistent routing.
