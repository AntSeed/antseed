---
sidebar_position: 6
slug: /reputation
title: Reputation
hide_title: true
---

# Reputation

AntSeed derives core on-chain seller stats directly from `AntseedChannels`. Completed channels, ghost channels, and settled volume live in the Channels contract itself. An optional `AntseedStats` contract can additionally ingest buyer-signed metadata during settlement to aggregate token and request counters.

## On-Chain Stats

Each seller's ERC-8004 agentId maintains the following core counters in `AntseedChannels`:

| Counter | Updated During | Description |
|---|---|---|
| `channelCount` | `close()` | Number of completed channels |
| `ghostCount` | `withdraw()` when nothing was settled | Timed-out channels with no proven spend |
| `totalVolumeUsdc` | `settle()` / `close()` | Cumulative USDC volume settled |
| `lastSettledAt` | `settle()` / `close()` | Timestamp of most recent settlement |

If the optional `AntseedStats` contract is configured, it can also track:

| Counter | Updated During | Description |
|---|---|---|
| `totalInputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative input tokens, delta-accounted per channel |
| `totalOutputTokens` | `settle()` / `topUp()` settle path | Buyer-signed cumulative output tokens, delta-accounted per channel |
| `totalRequestCount` | `settle()` / `topUp()` settle path | Buyer-signed cumulative request count, delta-accounted per channel |

No counter can be incremented without a corresponding on-chain state transition and buyer-signed metadata hash.

## Staking

From **September 10, 2026 at 09:54:21 UTC (epoch 22)**, seller eligibility is
resolved through AntseedSellerRegistry and ANTS pool positions contribute epoch
power. Legacy USDC stake can remain an eligibility fallback while enabled;
recognized-usage rewards require pool power. See [Recognized Usage](./recognized-usage.md)
and [legacy USDC staking](./legacy-emissions.md#legacy-usdc-staking).

## ERC-8004 Feedback

Buyers submit structured feedback via the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). Feedback signals:

| Signal | Type | Range |
|---|---|---|
| Quality | uint8 | 0-100 |
| Latency | uint8 | 0-100 |
| Accuracy | uint8 | 0-100 |
| Reliability | uint8 | 0-100 |

Feedback and routing reputation do not automatically grant ANTS or apply a
fixed on-chain reward multiplier. Recognized-usage accounting applies the
configured points policies; the registered historical wash-trading policy
can zero future rewards without changing settlement stats.

## ANTS Rewards

**Protocol start: September 10, 2026 at 09:54:21 UTC (epoch 22).**

ANTS rewards use recognized usage, seller-pool power, and epoch-based reward
accounting. Allocation ceilings are 40% for pool rewards, 20% for buyer and
seller/operator usage rewards, 15% for the reserve, 15% for the team, and 10%
for verification. Actual pool and usage rewards depend on the contracts'
eligibility and dynamic allocation rules.

See [Recognized Usage and ANTS Rewards](./recognized-usage.md) for the standard
reward model. **Looking for pre-migration emissions?** The [legacy guide](./legacy-emissions.md)
covers the 65% seller / 5% buyer split and historical claims.

## Buyer Route Scoring

On-chain trust and reputation feed into model-only seller selection. The buyer proxy and desktop share the route ranking exported by `@antseed/node/model-routing`, and `/v1/models/:id` returns peer offers in that same policy order.

The default model routing preferences are:

```typescript
{
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
}
```

The minimum trust score and allow/block lists are hard eligibility rules. Eligible offers are ranked by effective trust, token or image price, cached-input pricing coverage, free-peer preference, recent failures, and cooldown state. If at least one seller for a model advertises cached-input pricing, offers that omit it receive a model-specific reputation reduction; if none advertise it, no seller is penalized. A recognized conversation softly prefers its previous successful seller while that offer remains healthy and eligible.

The lower-level `@antseed/router-core` package also exposes generic router weights for plugin authors:

| Factor | Weight |
|---|---|
| Price | 0.30 |
| Latency | 0.25 |
| Capacity | 0.20 |
| Reputation | 0.10 |
| Freshness | 0.10 |
| Reliability | 0.05 |

### Scoring Rules

- **Model-only eligibility**: Defaults to `minTrustScore: 60`. Buyers can lower `buyer.routingPreferences.minTrustScore`, or set it to `0` to consider unscored and lower-trust peers.
- **Legacy policy filter**: `buyer.minPeerReputation` and hierarchical `maxPricing` remain separate hard policy checks applied before the model-route ranking.
- **On-chain precedence**: When on-chain reputation data is available, it takes precedence over locally reported reputation. Runtime metrics such as latency and failure history are handled separately by router scoring.
- **Score composition**: On-chain score is multi-factor. Settled USDC volume carries the largest weight through an exponent-shaped logarithmic curve, so large settled-volume differences continue to matter and many tiny channels cannot rank highly by themselves. Completed `channelCount`, average settled value per channel, `lastSettledAt` recency, and seller stake age also contribute. `ghostCount` applies a penalty based on the ghost-channel rate.
- **Latency**: Tracked as an exponential moving average (alpha: 0.3).
- **Failure backoff**: Peers with consecutive failures enter exponential backoff cooldown.
