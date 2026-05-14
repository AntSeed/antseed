# 05 - Reputation Protocol

## Overview

The reputation system enables buyers to make informed peer selection decisions without relying on a central authority. The current implementation derives reputation from buyer-readable on-chain settlement stats and uses local runtime metrics only for routing tie-breakers such as latency and failure cooldowns.

There is no central reputation authority.

---

## Current Implementation

### PeerInfo Reputation Field

Each peer advertises an optional reputation score in its `PeerInfo`:

```typescript
// node/src/types/peer.ts
export interface PeerInfo {
  // ...
  /** Reputation score (0-100). */
  reputationScore?: number;
  // ...
}
```

- Type: `number | undefined`
- Range: 0-100
- Optional: peers without a score receive a fallback value of **0** during selection and are not blocked unless the buyer explicitly configures a higher minimum reputation

### Router Plugin Peer Scoring

**Source:** `@antseed/router-core/src/peer-scorer.ts`

Buyer-side peer selection is implemented in **router plugins**, not in the core node. Each router plugin is free to define its own scoring logic. The official `@antseed/router-local` plugin delegates composite candidate scoring to `@antseed/router-core`:

| Factor      | Weight | Description                                              |
|-------------|--------|----------------------------------------------------------|
| price       | 0.30   | Lower price scores higher                                |
| latency     | 0.25   | Lower latency scores higher (tracked via EMA)            |
| capacity    | 0.20   | Higher available capacity (`maxConcurrency - currentLoad`) scores higher |
| reputation  | 0.10   | Higher reputation scores higher                          |
| freshness   | 0.10   | Recently seen peers score higher                         |
| reliability | 0.05   | Peers with fewer failures score higher                   |

All factors are min-max normalised across the eligible candidate pool before weighting. Reputation is normalised from the 0-100 integer range to a 0-1 float:

```
reputationFactor = peerReputation / 100
```

When a peer has no `reputationScore`, the value **0** is used (treated as unknown/unverified). When on-chain channel stats are available, official routers compute the effective reputation from `AntseedChannels` before falling back to locally reported scores. That on-chain score is multi-factor: settled USDC volume carries the largest weight, completed channels, average channel value, recent settlement, and seller stake age also contribute, and ghost-channel rate applies a penalty.

### Minimum Reputation Filter

Router plugins apply a minimum reputation filter before scoring. In `@antseed/router-local`:

- Config field: `BuyerConfig.minPeerReputation` (`@antseed/cli/src/config/defaults.ts`)
- Default value: **0** (no reputation gate)
- Passed to the router as `minReputation` in the plugin config
- Behavior: when a buyer explicitly raises `minReputation`, any peer whose effective reputation is below that threshold is excluded from the candidate pool before scoring

## Local Runtime Signals

Official routers keep local runtime metrics for candidate scoring and operational safety, but these metrics do **not** create a parallel reputation score and are not published to the DHT.

| Metric | Use |
|--------|-----|
| Latency EMA | Tie-breaking and composite router scoring |
| Failure streak / cooldown | Temporarily avoids peers that are failing for this buyer |
| Current load / capacity | Prefers peers with available concurrency |
| Freshness | Prefers recently observed peers |

These signals are buyer-local and transient. They help choose between otherwise eligible candidates, while the durable reputation path remains: buyer-computed on-chain reputation first, optional `PeerInfo.reputationScore` fallback second, and `0` for unknown reputation.

---

## Phase 2: DHT-Published Attestations & Staking (Future)

Phase 2 extends the reputation system with signed attestations published to the DHT and staking-weighted trust.

### Signed Attestations

Nodes publish attestations about peers they have interacted with. Each attestation is a signed message stored in the DHT:

```typescript
interface ReputationAttestation {
  /** PeerId of the node making the attestation. */
  attesterPeerId: PeerId;
  /** PeerId of the peer being attested. */
  subjectPeerId: PeerId;
  /** Composite score (0-100). */
  score: number;
  /** Breakdown of individual metrics. */
  metrics: {
    successRate: number;
    avgLatencyMs: number;
    tokenAccuracy: number;
    uptimeRate: number;
  };
  /** Unix timestamp (ms) when the attestation was created. */
  timestamp: number;
  /** secp256k1 signature (EIP-191 personal_sign) over the canonical encoding of all other fields. */
  signature: string;
}
```

### Staking Weight

Attestations from staked nodes carry more weight in reputation aggregation:

- Nodes that have staked tokens have a higher trust multiplier applied to their attestations
- This disincentivizes Sybil attacks: creating many fake identities to manipulate reputation requires proportional stake
- The staking weight is applied multiplicatively to the attestation score during aggregation

### Trust Propagation

Phase 2 introduces transitive trust with a decay factor:

- If node A trusts node B, and node B attests positively about node C, node A incorporates B's attestation about C with a decay multiplier
- Each hop in the trust chain reduces the weight by the decay factor
- This limits the influence of distant, unverified attestations while still allowing reputation information to propagate through the network

### Aggregated Reputation

A peer's DHT-published reputation is computed by aggregating all attestations about that peer:

1. Collect all attestations for the subject peer from the DHT
2. Weight each attestation by the attester's stake and trust distance
3. Compute the weighted average score
4. The result replaces (or supplements) the locally computed score in `PeerInfo.reputationScore`

---

## Summary

| Aspect                  | Current                                      | Phase 2 (Future)                        |
|-------------------------|----------------------------------------------|-----------------------------------------|
| Data source             | On-chain settlements + optional reported score | DHT-published signed attestations       |
| Storage                 | Chain data, local peer cache                 | DHT (distributed)                       |
| Trust model             | Buyer-verifiable settlement history          | Transitive trust with decay             |
| Sybil resistance        | Seller staking + settlement cost             | Staking-weighted attestations           |
| Score range             | 0-100                                        | 0-100                                   |
| Selection weight        | 10% of composite score                       | Router-defined                          |
| Minimum threshold       | Configurable (default: 0)                    | Configurable (default: 0)               |
| Central authority       | None                                         | None                                    |
