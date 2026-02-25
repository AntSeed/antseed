---
sidebar_position: 6
slug: /reputation
title: Reputation
hide_title: true
---

# Reputation

The reputation system enables buyers to make informed peer selection decisions without relying on a central authority. Reputation requires stake — providers commit economic stake to participate. Stake serves as collateral (slashable), routing signal (more stake = more trust = more traffic), and Sybil resistance.

## Phase 1: Local Metrics

Each node tracks per-peer statistics from direct interaction:

| Metric | Description |
|---|---|
| Success rate | Ratio of successful requests to total |
| Avg latency | Rolling average round-trip time |
| Token accuracy | How closely metered counts match receipts |
| Uptime | Success rate of keepalive probes |

Score range: 0-100. New peers start with a fallback of 50. Scores are local only and not shared in Phase 1.

## Router Scoring Weights

The `@antseed/router-core` default weights for peer selection:

| Factor | Weight |
|---|---|
| Price | 0.30 |
| Latency | 0.25 |
| Capacity | 0.20 |
| Reputation | 0.10 |
| Freshness | 0.10 |
| Reliability | 0.05 |

Minimum reputation filter: peers below `minPeerReputation` (default: 50) are excluded before scoring. Latency is tracked as an exponential moving average (alpha: 0.3). Peers with consecutive failures enter an exponential backoff cooldown. Every transaction is independently verifiable by both parties.

## Phase 2: DHT Attestations

Nodes will publish Ed25519-signed attestations about peers to the DHT. Staked nodes carry higher trust weight, and transitive trust propagates through the network with a decay factor.
