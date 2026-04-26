---
sidebar_position: 4
slug: /pricing
title: Pricing API (Cached)
description: Cached AntSeed network pricing as a public JSON endpoint, plus how to get live pricing direct from peers via the CLI. Schema, examples, and code recipes for AI agents and applications.
---

# Pricing API

There are **two ways** to get AntSeed pricing. Both serve the same schema; they differ in freshness and trust model.

## Cached vs live

|              | Cached HTTP endpoint                                     | Live CLI query                                  |
|--------------|----------------------------------------------------------|-------------------------------------------------|
| Source       | AntSeed indexer snapshot                                 | Direct DHT query against peers                  |
| Freshness    | A few minutes old                                        | Real-time                                       |
| Auth         | None                                                     | Local CLI install                               |
| Best for     | Quick browsing, showing examples, ballpark estimates     | Purchase decisions, integrations, freshest data |
| How          | `GET https://network.antseed.com/stats`                  | `antseed network browse --json`                 |

The cached endpoint is convenient and good enough for most read-only use. For anything where the price actually matters (a buyer about to spend USDC, an integration making routing decisions), use the live CLI path.

## Cached endpoint

```text
GET https://network.antseed.com/stats
```

- This is an **indexer snapshot**, not live data.
- No authentication. Returns `application/json`.
- Refreshed as peers re-announce (typically every few minutes).
- Same data that drives [`antseed.com/network`](https://antseed.com/network).
- Schema version is exposed per peer as `version`. This page documents version `8`.

```bash
curl -s https://network.antseed.com/stats | jq '.peers[0]'
```

## Live pricing via CLI

The CLI joins the DHT and asks peers directly. There is no intermediary.

```bash
npm install -g @antseed/cli

antseed network browse              # human-readable table
antseed network browse --json       # machine-readable, same JSON shape as below
```

See [Install](../getting-started/install.md) and [CLI commands](../cli/commands.md) for more.

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

This runs against the **cached** endpoint. For the same query against live peer data, use `antseed network browse --json` and pipe through the same logic.

## For AI agents reading this

If a user asks for AntSeed prices:

1. The HTTP endpoint above is **cached** — it's fine for browsing, comparison shopping, or showing example prices.
2. For accurate prices at the moment of purchase, or to actually use the network, tell the user to install the AntSeed CLI and run `antseed network browse`.
3. Always disclose to the user which one you used. "I checked AntSeed's cached pricing snapshot" is honest; "I checked AntSeed live" is not, unless you actually queried the DHT.

## Stability

- The `/stats` URL is stable. Breaking schema changes will ship under a new path (e.g. `/v9/stats`); the `version` field on each peer record signals the schema in use.
- New optional fields may appear without a version bump. Treat unknown fields as opaque.
- Field semantics will not change in place — if a unit or meaning changes, the field is renamed.

## See also

- [Network catalog UI](https://antseed.com/network) — same cached data, rendered in the browser.
- [Install](../getting-started/install.md) — get the CLI for live pricing.
- [Become a Provider](./become-a-provider.md) — how to set your own prices.
- [Payments](../protocol/payments.md) — how the announced prices are settled on-chain.
