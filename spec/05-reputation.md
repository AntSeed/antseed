# 05 - Reputation Protocol

## Overview

The reputation system enables buyers to make informed peer selection decisions without relying on a central authority. In Phase 1, each node tracks local experience-based metrics. Phase 2 introduces DHT-published signed attestations and staking-weighted trust.

There is no central reputation authority at any phase.

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
- Optional: peers without a score receive a fallback value of **50** during selection

### Router Plugin Peer Scoring

**Source:** `@antseed/router-local-proxy/src/router.ts`

Buyer-side peer selection is implemented in **router plugins**, not in the core node. Each router plugin is free to define its own scoring logic. The official `@antseed/router-local-proxy` plugin computes a composite score for each candidate peer using four weighted factors:

| Factor     | Weight | Description                                              |
|------------|--------|----------------------------------------------------------|
| price      | 0.40   | Lower price scores higher                                |
| latency    | 0.30   | Lower latency scores higher (tracked via EMA)            |
| capacity   | 0.20   | Higher available capacity (`maxConcurrency - currentLoad`) scores higher |
| reputation | 0.10   | Higher reputation scores higher                          |

```typescript
// @antseed/router-local-proxy/src/router.ts
const WEIGHTS = {
  price: 0.40,
  latency: 0.30,
  capacity: 0.20,
  reputation: 0.10,
} as const;
```

All factors are min-max normalised across the eligible candidate pool before weighting. Reputation is normalised from the 0-100 integer range to a 0-1 float:

```
reputationFactor = peerReputation / 100
```

When a peer has no `reputationScore`, the value **0** is used (treated as unknown/unverified).

### Minimum Reputation Filter

Router plugins apply a minimum reputation filter before scoring. In `@antseed/router-local-proxy`:

- Config field: `BuyerConfig.minPeerReputation` (`@antseed/cli/src/config/defaults.ts`)
- Default value: **50**
- Passed to the router as `minReputation` in the plugin config
- Behavior: any peer whose `reputationScore` is below `minReputation` is excluded from the candidate pool before scoring

### Discovery-Layer Scoring (peer-selector.ts)

**Source:** `node/src/discovery/peer-selector.ts`

A separate scoring module exists in the core node with its own default weights:

```typescript
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  price: 0.35,
  capacity: 0.25,
  latency: 0.25,
  reputation: 0.15,
};
```

This module uses a four-factor model (no load factor) and expects `candidate.reputation` as a 0-1 float directly. The reputation weight is the same: **0.15** (15% of composite score).

---

## Phase 1: Peer-to-Peer Local Attestation Model

In Phase 1, each node tracks its own experience with peers locally. Attestations are not published to the DHT.

### Local Metrics Tracked

Each node maintains per-peer statistics based on direct interaction:

| Metric                     | Description                                                        |
|----------------------------|--------------------------------------------------------------------|
| Request success/failure rate | Ratio of successfully completed requests to total requests sent   |
| Average latency            | Rolling average round-trip time for requests to the peer           |
| Token estimate accuracy    | How closely the peer's metered token counts match receipt values (receipt verification disputes) |
| Uptime                     | Success rate of keepalive probes to the peer                       |

### Score Computation

The local reputation score is a weighted combination of the tracked metrics:

```
reputationScore = w1 * successRate
                + w2 * latencyScore
                + w3 * tokenAccuracy
                + w4 * uptimeRate
```

The result is clamped to the 0-100 integer range and stored in the node's local peer table.

### Properties

- **Local only**: each node's view of a peer's reputation is based solely on its own interactions
- **No publication**: scores are not shared with other nodes in Phase 1
- **Subjective**: two nodes may have different reputation scores for the same peer based on their individual experiences
- **Bootstrapping**: new peers with no interaction history receive the fallback reputation of 50

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
  /** Ed25519 signature over the canonical encoding of all other fields. */
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

| Aspect                  | Phase 1 (Current)              | Phase 2 (Future)                        |
|-------------------------|--------------------------------|-----------------------------------------|
| Data source             | Local interaction metrics      | DHT-published signed attestations       |
| Storage                 | Local peer table               | DHT (distributed)                       |
| Trust model             | Direct experience only         | Transitive trust with decay             |
| Sybil resistance        | None (local only)              | Staking-weighted attestations           |
| Score range             | 0-100                          | 0-100                                   |
| Selection weight        | 15% of composite score         | 15% of composite score                  |
| Minimum threshold       | Configurable (default: 50)     | Configurable (default: 50)              |
| Central authority       | None                           | None                                    |
