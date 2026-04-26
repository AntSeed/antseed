# AntSeed Pricing

AntSeed has no central price list. Each peer announces its own catalog and pricing, and the indexer aggregates them into a single public JSON document.

Full documentation, schema, and examples: **<https://antseed.com/docs/pricing>**

## Live JSON endpoint

```text
GET https://network.antseed.com/stats
```

- No authentication. Returns `application/json`.
- Updated as peers re-announce (typically every few minutes).
- Same data that powers <https://antseed.com/network>.

```bash
curl -s https://network.antseed.com/stats | jq '.peers[0].providers'
```

## Schema (abbreviated)

All prices are USD per **one million tokens**.

```ts
interface StatsResponse {
  peers: PeerMetadata[];
  updatedAt: string;
}

interface PeerMetadata {
  peerId: string;
  version: number;            // schema version, currently 8
  displayName?: string;
  providers: ProviderAnnouncement[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  trustScore?: number;
  onChainStats?: OnChainStats;
}

interface ProviderAnnouncement {
  provider: string;                                    // plugin name, e.g. "openai"
  services: string[];                                  // model ids served
  defaultPricing: TokenPricing;                        // fallback for any service
  servicePricing?: Record<string, TokenPricing>;       // per-model overrides
  serviceCategories?: Record<string, string[]>;        // tags: "chat", "code", "reasoning"
  serviceApiProtocols?: Record<string, string[]>;      // e.g. ["openai-chat-completions"]
  maxConcurrency: number;
  currentLoad: number;
}

interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}
```

The canonical TypeScript types live in [`packages/node/src/discovery/peer-metadata.ts`](packages/node/src/discovery/peer-metadata.ts).

## Recipe — cheapest provider for a model

Effective price is `servicePricing[model] ?? defaultPricing`.

```js
const { peers } = await fetch('https://network.antseed.com/stats').then(r => r.json());

const model = 'deepseek-v3.1';

const offers = peers.flatMap(peer =>
  peer.providers.flatMap(prov => {
    if (!prov.services.includes(model)) return [];
    const price = prov.servicePricing?.[model] ?? prov.defaultPricing;
    return [{
      peer: peer.displayName ?? peer.peerId,
      inputUsdPerM: price.inputUsdPerMillion,
      outputUsdPerM: price.outputUsdPerMillion,
      load: prov.currentLoad,
      capacity: prov.maxConcurrency,
    }];
  })
).sort((a, b) => a.inputUsdPerM - b.inputUsdPerM);
```

## Stability

- The `/stats` URL is stable. Breaking schema changes will ship under a new path (e.g. `/v9/stats`).
- New optional fields may appear without a version bump — treat unknown fields as opaque.
- Field semantics will not change in place; renamed instead.
