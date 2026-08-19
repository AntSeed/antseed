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

Sellers stake USDC via AntseedStaking, binding their stake to an ERC-8004 agentId. Minimum stake: 10 USDC. An unstaked seller cannot have `reserve()` called on AntseedChannels.

## ERC-8004 Feedback

Buyers submit structured feedback via the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`). Feedback signals:

| Signal | Type | Range |
|---|---|---|
| Quality | uint8 | 0-100 |
| Latency | uint8 | 0-100 |
| Accuracy | uint8 | 0-100 |
| Reliability | uint8 | 0-100 |

Feedback produces a multiplier on the seller's emission rate:

```
feedbackMultiplier = 0.5 + (avgFeedbackScore / 100)
// Range: 0.5x (score=0) to 1.5x (score=100)
```

Feedback does not affect core stats counters. It modulates emission only.

## ANTS Emission

Token emission is tied to proven delivery. Points accumulate per-interaction and convert to ANTS via a Synthetix-style reward-per-point distribution (O(1) per interaction, no epoch batching).

### Seller Points

```
sellerPoints = V(P) * feedbackMultiplier
```

Where:
- `V(P)` = USDC volume settled in the session
- `feedbackMultiplier` = feedback-derived multiplier (0.5x to 1.5x)

### Buyer Points

```
buyerPoints = usagePoints + feedbackPoints + diversityBonus
```

- `usagePoints`: proportional to USDC spent in qualified sessions
- `feedbackPoints`: awarded for submitting feedback (incentivizes signal)
- `diversityBonus`: bonus for transacting with more unique sellers

### Distribution Split

| Recipient | Share |
|---|---|
| Seller / Provider Pool | 50% |
| Buyer | 20% |
| Protocol reserve | 15% |
| Contributors / team | 15% |

Seller rewards are capped at 50% of the seller bucket per seller per epoch. Buyer rewards are capped at 5% of the buyer bucket per buyer per epoch. Cap overages are redirected to the Protocol Reserve.

ANTS tokens are non-transferable until network maturity. This prevents early speculation from distorting incentives.

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
