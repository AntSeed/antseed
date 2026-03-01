---
sidebar_position: 2
slug: /discovery
title: Peer Discovery
sidebar_label: Discovery
hide_title: true
---

# Peer Discovery

The discovery protocol uses the BitTorrent Mainline DHT (BEP 5) as a decentralized directory of seller nodes, combined with an HTTP metadata endpoint for retrieving provider details and Skills.

## DHT Topic Hashing

Sellers announce multiple topic types. Each topic is SHA1-hashed for DHT lookup.

| Topic Type | Plain Topic String | Key Normalization |
|---|---|---|
| Provider | `antseed:{provider}` | `trim + lowercase` |
| Model (canonical) | `antseed:model:{model}` | `trim + lowercase` |
| Model (search fallback) | `antseed:model-search:{model}` | `trim + lowercase`, then remove spaces, `-`, `_` (keep `.`) |
| Capability | `antseed:{capability}` or `antseed:{capability}:{name}` | `trim + lowercase` |

`model-search` topics are announced only when the compact key differs from the canonical key.

Example:

- `kimi 2.5` -> canonical `antseed:model:kimi 2.5`, search `antseed:model-search:kimi2.5`
- `kimi-2.5` -> canonical `antseed:model:kimi-2.5`, search `antseed:model-search:kimi2.5`
- `kimi_2.5` -> canonical `antseed:model:kimi_2.5`, search `antseed:model-search:kimi2.5`

Buyer model discovery queries canonical model topic first, then also queries `model-search` when keys differ.

## Bootstrap Nodes

| Host | Port |
|---|---|
| `router.bittorrent.com` | 6881 |
| `dht.transmissionbt.com` | 6881 |
| `router.utorrent.com` | 6881 |

## DHT Configuration

| Parameter | Value |
|---|---|
| Port | 6881 |
| Re-announce interval | 15 minutes |
| Operation timeout | 10 seconds |

## Metadata Endpoint

Each seller runs an HTTP server exposing `GET /metadata` which returns JSON-serialized `PeerMetadata` with pricing, capacity, and optional metadata tags/protocol hints.  
By default, metadata is fetched from `http://{host}:{port}/metadata` (`metadataPortOffset = 0`).

## PeerMetadata

```json title="metadata structure"
{
  "peerId": "a1b2c3d4...64 hex chars",
  "version": 4,
  "displayName": "Acme Inference - us-east-1",
  "providers": [{
    "provider": "anthropic",
    "models": ["claude-sonnet-4-6", "claude-haiku-4-5"],
    "defaultPricing": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15
    },
    "modelPricing": {
      "claude-sonnet-4-6": { "inputUsdPerMillion": 3, "outputUsdPerMillion": 15 },
      "claude-haiku-4-5": { "inputUsdPerMillion": 1, "outputUsdPerMillion": 5 }
    },
    "modelCategories": {
      "claude-sonnet-4-6": ["coding", "privacy"]
    },
    "modelApiProtocols": {
      "claude-sonnet-4-6": ["anthropic-messages"]
    },
    "maxConcurrency": 5,
    "currentLoad": 2
  }],
  "region": "us-east",
  "timestamp": 1708272000000,
  "signature": "ed25519...128 hex chars"
}
```

Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are allowed).

## Peer Scoring

| Dimension | Weight | Description |
|---|---|---|
| Price | 0.30 | Lower price scores higher (inverted min-max) |
| Latency | 0.25 | Lower latency scores higher (EMA-based) |
| Capacity | 0.20 | More available capacity scores higher |
| Reputation | 0.10 | Higher reputation scores higher (0-100) |
| Freshness | 0.10 | Recently seen peers score higher |
| Reliability | 0.05 | Lower failure rate and streak scores higher |

All factors are min-max normalized across the eligible candidate pool. Peers below `minPeerReputation` (default: 50) are excluded before scoring. Peers in a failure cooldown (exponential backoff) are also excluded.

Buyers can filter by capability, Skill, minimum reputation, and price ceiling.
