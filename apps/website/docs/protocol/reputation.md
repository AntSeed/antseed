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
| Seller | 65% |
| Buyer | 25% |
| Protocol reserve | 10% |

ANTS tokens are non-transferable until network maturity. This prevents early speculation from distorting incentives.

## Router Scoring

On-chain reputation feeds into the router's peer selection algorithm. The `@antseed/router-core` default weights:

| Factor | Weight |
|---|---|
| Price | 0.40 |
| Latency | 0.30 |
| Capacity | 0.20 |
| Reputation | 0.10 |

### Scoring Rules

- **Minimum reputation filter**: Peers below `minPeerReputation` (default: 50) are excluded before scoring.
- **On-chain precedence**: When on-chain reputation data is available, it takes precedence over the local trust score. Local metrics (success rate, latency, uptime) serve as tiebreakers and fill in during the bootstrapping period before a seller has on-chain history.
- **Score composition**: On-chain score is derived primarily from `channelCount`, `ghostCount`, and `totalVolumeUsdc` from `AntseedChannels`, optionally supplemented by token/request counts from `AntseedStats`, combined with ERC-8004 feedback signals.
- **Latency**: Tracked as an exponential moving average (alpha: 0.3).
- **Failure backoff**: Peers with consecutive failures enter exponential backoff cooldown.
