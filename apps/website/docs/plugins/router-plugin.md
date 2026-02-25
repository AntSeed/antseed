---
sidebar_position: 2
slug: /router-api
title: Router Plugin
hide_title: true
---

# Router Plugin

Router plugins control how buyer requests are distributed across available sellers. Each router defines its own scoring logic for peer selection. On failure, the router automatically switches to the next-best provider — because AI APIs are stateless, these switches are invisible to the application.

## Default Scoring Weights

The `@antseed/router-core` scores peers with:

```typescript title="scoring weights"
const DEFAULT_WEIGHTS = {
  price:       0.30,   // lower price scores higher (inverted min-max)
  latency:     0.25,   // lower latency scores higher (EMA)
  capacity:    0.20,   // more available capacity scores higher
  reputation:  0.10,   // higher reputation scores higher (0-100)
  freshness:   0.10,   // recently seen peers score higher
  reliability: 0.05,   // lower failure rate scores higher
} as const;
```

All factors are min-max normalized across the eligible candidate pool. Peers below `minReputation` (default: 50) are excluded before scoring. Peers in failure cooldown (exponential backoff after 3 consecutive failures) are also excluded.

## Router Interface

```typescript title="router interface"
interface Router {
  // Select a peer for a request
  selectPeer(
    req: SerializedHttpRequest,
    peers: PeerInfo[]
  ): PeerInfo | null

  // Called after each request completes
  onResult(
    peer: PeerInfo,
    result: {
      success: boolean
      latencyMs: number
      tokens: number
    }
  ): void
}
```

If you don't provide a router, the SDK uses a default that selects the cheapest peer with reputation above a minimum threshold.
