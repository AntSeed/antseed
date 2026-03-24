---
sidebar_position: 6
slug: /reputation
title: Reputation
hide_title: true
---

# Reputation

AntSeed derives on-chain reputation directly from payment settlement. Reputation counters are updated atomically inside `reserve()` and `settle()` — there is no separate reporting step, no oracle, and no validator. The data is unforgeable because it emerges from the proof-of-prior-delivery chain.

## On-Chain Reputation Counters

Each seller address maintains the following counters in the escrow contract, updated atomically during settlement:

| Counter | Updated During | Description |
|---|---|---|
| `firstSignCount` | `reserve()` | Number of first-sign sessions (blind trust, no prior proof) |
| `qualifiedProvenSignCount` | `settle()` | Proven signs from buyers meeting the diversity threshold |
| `unqualifiedProvenSignCount` | `settle()` | Proven signs from buyers below the diversity threshold |
| `totalQualifiedTokenVolume` | `settle()` | Cumulative tokens delivered across qualified sessions |
| `ghostCount` | `settle()` (timeout) | Sessions that timed out after 24h of inactivity |
| `lastProvenAt` | `settle()` | Timestamp of the most recent proven sign |

No counter can be incremented without a corresponding on-chain state transition. There is no off-chain aggregation or batching.

## Sign Types

| Type | Condition | Session Cap | Counter Effect | Reputation Accrual |
|---|---|---|---|---|
| First Sign | No prior proof exists for this buyer-seller pair | $1 USDC | `firstSignCount++` | None |
| Proven Sign | Prior delivery proven via proof chain | Uncapped | See qualified/unqualified | Depends on buyer diversity |
| Qualified Proven Sign | Proven + buyer has been charged by ≥3 unique sellers | Uncapped | `qualifiedProvenSignCount++`, `totalQualifiedTokenVolume += tokens` | Yes |
| Unqualified Proven Sign | Proven + buyer below diversity threshold | Uncapped | `unqualifiedProvenSignCount++` | None (payment settles normally) |

## Anti-Gaming Defenses

Seven layers prevent reputation farming and Sybil attacks:

| Layer | Mechanism | Attack Prevented |
|---|---|---|
| Buyer diversity | Proven sign only qualifies if buyer has transacted with ≥3 unique sellers | 1:1 collusion between a single buyer-seller pair |
| Minimum deposit | $10 USDC minimum to open escrow | Low-cost Sybil account creation |
| Dynamic credit limits | Credit grows with interaction history | Capital dumping on day one |
| Inactivity lock | 90 days without settlement locks the account | Dormant Sybil accounts accumulating passive benefits |
| Cooldown per pair | 7-day minimum between first session and first proven sign for each buyer-seller pair | Rapid-fire session farming |
| Minimum token threshold | Sessions below 1,000 tokens do not count toward reputation | Trivial micro-sessions to inflate counters |
| Stake-proportional cap | `effectiveProvenSigns = min(actualProvenSigns, stake * 20)` | Unbounded reputation without proportional economic commitment |

### Dynamic Credit Limit Formula

```
creditLimit = BASE_CREDIT_LIMIT
            + (uniqueInteractions * INTERACTION_BONUS)
            + (accountAgeDays * TIME_BONUS)
            + (provenSessionCount * PROVEN_BONUS)
            + (avgFeedbackScore * FEEDBACK_BONUS)
```

Credit limit increases are monotonic within an active period but reset on inactivity lock.

## Staking and Slashing

Sellers stake USDC to accept paid sessions. Stake is locked for the duration of active participation. Slash conditions are evaluated at unstake time:

| Condition | Slash Rate | Rationale |
|---|---|---|
| Zero qualified proven signs | 100% | Staked but never delivered qualifying service |
| 5+ ghost events, no subsequent proven signs | 100% | Persistent failure to deliver |
| Qualified ratio < 30% (`qualifiedProvenSignCount / totalProvenSigns < 0.3`) | 50% | Majority of activity was unqualified (likely farming) |
| Stale: no qualified activity in last 30 days | 20% | Staked without recent activity |
| Clean + recent: ≥30% qualified ratio and qualified activity within 30 days | 0% | Normal operation |

Slash conditions are evaluated in order; the first match applies. Slashed funds are sent to the protocol reserve.

## ERC-8004 Feedback

Buyers submit structured feedback after session completion. Feedback signals:

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

Feedback does not affect core reputation counters or the proof chain. It modulates emission only.

## ANTS Emission

Token emission is tied to proven delivery. Points accumulate per-interaction and convert to ANTS via a Synthetix-style reward-per-point distribution (O(1) per interaction, no epoch batching).

### Seller Points

```
sellerPoints = E(P) * V(P) * feedbackMultiplier
```

Where:
- `E(P)` = reputation factor derived from `qualifiedProvenSignCount`
- `V(P)` = token volume delivered in the session
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
- **Score composition**: On-chain reputation score is derived from `qualifiedProvenSignCount`, `totalQualifiedTokenVolume`, `ghostCount` (negative), and `lastProvenAt` (recency decay).
- **Latency**: Tracked as an exponential moving average (alpha: 0.3).
- **Failure backoff**: Peers with consecutive failures enter exponential backoff cooldown.
