---
sidebar_position: 4
slug: /pricing
title: Pricing API
description: Live AI inference pricing across the AntSeed network as a public JSON endpoint. Schema, example response, and code snippets for agents and applications.
---

# Pricing API

AntSeed has no central price list. Every peer announces its own catalog and pricing, and the indexer aggregates them into a single public JSON document. This page documents that document.

The same data drives [`antseed.com/network`](https://antseed.com/network).

## Endpoint

```text
GET https://network.antseed.com/stats
```

- No authentication.
- Returns `application/json`.
- Updated as peers re-announce (typically every few minutes).
- Schema version is exposed in each peer record as `version`. This page documents version `8`.

```bash
curl -s https://network.antseed.com/stats | jq '.peers[0]'
```

## Top-level shape

```ts
interface StatsResponse {
  peers: PeerMetadata[];
  updatedAt: string;          // ISO timestamp of the snapshot
  indexer?: { /* sync status */ };
}
```

## `PeerMetadata`

```ts
interface PeerMetadata {
  peerId: string;             // 40-char lowercase hex
  version: number;            // metadata schema version (currently 8)
  displayName?: string;
  providers: ProviderAnnouncement[];
  region: string;             // e.g. "us-east", "unknown"
  timestamp: number;          // unix ms when this peer last announced
  stakeAmountUSDC?: number;   // staked USDC backing this peer
  trustScore?: number;        // 0..1 reputation score
  onChainChannelCount?: number;
  onChainStats?: OnChainStats;
  signature: string;          // peer-signed announcement
}
```

## `ProviderAnnouncement`

A single peer can run multiple provider plugins (e.g. `openai`, `anthropic`, `openai-responses`). Each is announced separately:

```ts
interface ProviderAnnouncement {
  provider: string;                                        // plugin name, e.g. "openai"
  services: string[];                                      // model ids served, e.g. ["deepseek-v3.1"]
  defaultPricing: TokenPricing;                            // fallback for any service without a per-model entry
  servicePricing?: Record<string, TokenPricing>;           // per-model price overrides
  serviceCategories?: Record<string, string[]>;            // tags like "chat", "code", "reasoning"
  serviceApiProtocols?: Record<string, ApiProtocol[]>;     // e.g. ["openai-chat-completions"]
  maxConcurrency: number;
  currentLoad: number;                                     // active requests right now
}
```

## `TokenPricing`

All prices are USD per **one million tokens**.

```ts
interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;     // discount for cache-hit input tokens
}
```

## Example response (truncated)

```json
{
  "peers": [
    {
      "peerId": "4668854ba3e8b094e6f48fbeb59cec1cfde162f2",
      "version": 8,
      "displayName": "Dark Signal",
      "region": "unknown",
      "timestamp": 1777194949071,
      "providers": [
        {
          "provider": "openai-responses",
          "services": ["gpt-5.4", "gpt-5.5"],
          "defaultPricing": { "inputUsdPerMillion": 0.4, "outputUsdPerMillion": 2 },
          "servicePricing": {
            "gpt-5.4": {
              "inputUsdPerMillion": 0.25,
              "outputUsdPerMillion": 1.5,
              "cachedInputUsdPerMillion": 0.05
            }
          },
          "serviceCategories": { "gpt-5.4": ["chat", "code"] },
          "serviceApiProtocols": { "gpt-5.4": ["openai-responses"] },
          "maxConcurrency": 10,
          "currentLoad": 0
        }
      ]
    }
  ],
  "updatedAt": "2026-04-26T..."
}
```

## Recipe — find the cheapest provider for a model

Effective price for a given service is `servicePricing[model] ?? defaultPricing`.

```js
const res = await fetch('https://network.antseed.com/stats');
const { peers } = await res.json();

const model = 'deepseek-v3.1';

const offers = peers.flatMap(peer =>
  peer.providers.flatMap(prov => {
    if (!prov.services.includes(model)) return [];
    const price = prov.servicePricing?.[model] ?? prov.defaultPricing;
    return [{
      peer: peer.displayName ?? peer.peerId,
      inputUsdPerM: price.inputUsdPerMillion,
      outputUsdPerM: price.outputUsdPerMillion,
      cachedInputUsdPerM: price.cachedInputUsdPerMillion,
      load: prov.currentLoad,
      capacity: prov.maxConcurrency,
    }];
  })
);

offers.sort((a, b) => a.inputUsdPerM - b.inputUsdPerM);
console.log(offers);
```

## Stability

- The `/stats` URL is stable. Breaking schema changes will ship under a new path (e.g. `/v9/stats`); the `version` field on each peer record signals the schema in use.
- New optional fields may appear without a version bump. Treat unknown fields as opaque.
- Field semantics will not change in place — if a unit or meaning changes, the field is renamed.

## See also

- [Live pricing UI](https://antseed.com/network) — same data, rendered.
- [Become a Provider](./become-a-provider.md) — how to set your own prices.
- [Payments](../protocol/payments.md) — how the announced prices are settled on-chain.
