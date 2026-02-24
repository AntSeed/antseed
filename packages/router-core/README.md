# @antseed/router-core

Shared infrastructure for building Antseed router plugins. Provides multi-factor peer scoring and per-peer metrics tracking.

## Installation

```bash
pnpm add @antseed/router-core
```

Peer dependency: `@antseed/node >= 0.1.0`

## Key Exports

### scoreCandidates

Scores and ranks peers using a weighted multi-factor algorithm:

| Factor | Description |
|--------|-------------|
| **price** | Lower price scores higher |
| **latency** | Lower latency EMA scores higher |
| **capacity** | More available capacity scores higher |
| **reputation** | Higher trust/reputation scores higher |
| **freshness** | More recently seen peers score higher |
| **reliability** | Lower failure rate scores higher |

```ts
import { scoreCandidates, DEFAULT_WEIGHTS } from '@antseed/router-core';

const scored = scoreCandidates(peers, {
  weights: DEFAULT_WEIGHTS,
  metrics: tracker,
  now: Date.now(),
  maxPeerStalenessMs: 300_000,
});
// Returns ScoredCandidate[] sorted by score descending
```

### PeerMetricsTracker

Tracks per-peer performance metrics for routing decisions.

```ts
import { PeerMetricsTracker } from '@antseed/router-core';

const tracker = new PeerMetricsTracker({ maxFailures: 3, failureCooldownMs: 30_000 });

// Record results
tracker.recordSuccess(peerId, latencyMs);
tracker.recordFailure(peerId);

// Check if peer is on cooldown
tracker.isOnCooldown(peerId, Date.now());
```

### Tool Hints

```ts
import { WELL_KNOWN_TOOL_HINTS, formatToolHints } from '@antseed/router-core';
```

## Default Scoring Weights

```ts
const DEFAULT_WEIGHTS = {
  price: 0.25,
  latency: 0.25,
  capacity: 0.15,
  reputation: 0.15,
  freshness: 0.10,
  reliability: 0.10,
};
```
