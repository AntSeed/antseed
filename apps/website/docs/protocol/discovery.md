---
sidebar_position: 2
slug: /discovery
title: Peer Discovery
sidebar_label: Discovery
hide_title: true
---

# Peer Discovery

The discovery protocol uses a DHT network (built on BEP 5) as a decentralized directory of seller nodes, combined with an HTTP metadata endpoint for retrieving provider details and Skills. All nodes bootstrap through dedicated AntSeed infrastructure.

## DHT Topic Hashing

Sellers announce multiple topic types. Each topic is SHA1-hashed for DHT lookup.

| Topic Type | Plain Topic String | Key Normalization |
|---|---|---|
| Provider | `antseed:{provider}` | `trim + lowercase` |
| Model (canonical) | `antseed:service:{model}` | `trim + lowercase` |
| Model (search fallback) | `antseed:service-search:{model}` | `trim + lowercase`, then remove spaces, `-`, `_` (keep `.`) |
| Capability | `antseed:{capability}` or `antseed:{capability}:{name}` | `trim + lowercase` |

`model-search` topics are announced only when the compact key differs from the canonical key.

Example:

- `kimi 2.5` -> canonical `antseed:service:kimi 2.5`, search `antseed:service-search:kimi2.5`
- `kimi-2.5` -> canonical `antseed:service:kimi-2.5`, search `antseed:service-search:kimi2.5`
- `kimi_2.5` -> canonical `antseed:service:kimi_2.5`, search `antseed:service-search:kimi2.5`

Buyer model discovery queries canonical model topic first, then also queries `model-search` when keys differ.

## Bootstrap Nodes

| Host | Port |
|---|---|
| `dht1.antseed.com` | 6881 |
| `dht2.antseed.com` | 6881 |

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
  "peerId": "a1b2c3d4...40 hex chars (EVM address)",
  "version": 12,
  "displayName": "Acme Inference - us-east-1",
  "publicAddress": "peer.example.com:6882",
  "providers": [{
    "provider": "openai",
    "services": ["kimi-k2.6", "deepseek-v4-flash"],
    "defaultPricing": {
      "inputUsdPerMillion": 0.6,
      "cachedInputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 2.5
    },
    "servicePricing": {
      "kimi-k2.6": { "inputUsdPerMillion": 0.6, "cachedInputUsdPerMillion": 0.06, "outputUsdPerMillion": 2.5 },
      "deepseek-v4-flash": { "inputUsdPerMillion": 0.25, "cachedInputUsdPerMillion": 0.025, "outputUsdPerMillion": 1 }
    },
    "serviceCategories": {
      "kimi-k2.6": ["coding", "privacy"]
    },
    "serviceApiProtocols": {
      "kimi-k2.6": ["openai-chat-completions"]
    },
    "serviceCapabilities": {
      "kimi-k2.6": {
        "contextWindow": 256000,
        "maxOutputTokens": 64000,
        "inputs": ["text"],
        "reasoning": true,
        "toolUse": true,
        "structuredOutput": true
      }
    },
    "maxConcurrency": 5,
    "currentLoad": 2
  }],
  "region": "us-east",
  "timestamp": 1708272000000,
  "capabilities": ["verification.response-auth.v1"],
  "sellerContract": "1f228613116e2d08014dfdcc198377c8dedf18c9",
  "verifications": {
    "domains": [
      { "domain": "provider.example.com", "methods": ["dns-txt"] }
    ],
    "github": [
      { "username": "example-org", "repository": "antseed-verification" }
    ]
  },
  "signature": "eip191...130 hex chars"
}
```

Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are allowed).

Metadata v11 added `serviceUnitBillingModels`; v12 adds `serviceCapabilities` and widens service catalog and service-map counts to support up to 512 entries. Image providers advertise `openai-images` and may attach an `output_images` billing model:

```json
{
  "serviceApiProtocols": { "flux.1-schnell": ["openai-images"] },
  "serviceUnitBillingModels": {
    "flux.1-schnell": {
      "openai-images": {
        "version": 1,
        "components": [
          { "unit": "output_images", "priceUsd": 0.003 }
        ]
      }
    }
  },
  "serviceCapabilities": {
    "flux.1-schnell": {
      "inputs": ["text", "image"],
      "outputs": ["image"],
      "supportedParameters": ["background", "output_format", "quality", "size"]
    }
  }
}
```

Capability fields are optional; absence means unknown. `inputs` and `outputs` declare accepted and produced modalities (`text`, `image`, `audio`, `video`, `pdf`); `supportedParameters` lists extra request-body parameter names the service accepts (lowercase snake_case, announced in code-unit sorted order). Unit-billing components may match `model`, `size`, `quality`, or `resolution`. Discovery only includes capability and billing entries for services currently advertised by the provider.

Capabilities are hints, not enforced contracts. The buyer proxy performs one advisory check: when a peer announces `supportedParameters` for the routed service and the request body carries parameters outside that list, the proxy logs a warning and forwards the request unchanged — the upstream provider remains the authority on which parameters it accepts.

:::warning Metadata version compatibility
Buyers reject metadata versions newer than they understand. A v10/v11 buyer therefore drops a v12 seller, while a v12 buyer continues to accept v10 and v11 sellers. Upgrade buyers before sellers using the [metadata v12 migration guide](/docs/guides/metadata-v12-upgrade).
:::

`publicAddress` is optional. When present, buyers should prefer it over the raw host learned from the DHT announcement. This is intended for deployments where DHT traffic exits from one IP but buyers must connect to another address, such as a Kubernetes load balancer.

`sellerContract` is optional. When present, buyers use the contract as the on-chain seller address and verify separately that the peer identity is an authorized operator of that contract.

`verifications` is optional. It carries external ownership claims that are included in the signed metadata. Domain and GitHub proofs bind to `peerId` — not to `sellerContract` — because the peer identity is the key that signs discovery metadata and operates the node.

## Domain and GitHub Verification Claims

Domain verification supports two proof transports:

- DNS TXT at `_antseed.<domain>` with value `antseed-peer=<peer-id-without-0x>`
- HTTPS well-known JSON at `https://<domain>/.well-known/antseed.json`

A DNS-backed claim looks like:

```json
{
  "domain": "provider.example.com",
  "methods": ["dns-txt"]
}
```

The matching DNS record is:

```text
_antseed.provider.example.com TXT "antseed-peer=a1b2c3d4...40hex"
```

An HTTPS well-known proof uses this JSON shape:

```json
{
  "type": "antseed-domain-verification",
  "peerId": "a1b2c3d4...40hex",
  "domain": "provider.example.com"
}
```

GitHub verification fetches a public file from:

```text
https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json
```

The proof file shape is:

```json
{
  "type": "antseed-github-verification",
  "peerId": "a1b2c3d4...40hex",
  "username": "example-org"
}
```

The repository name is part of the metadata claim, not the proof file. If no repository is provided, verifiers use the profile repository named after the username.

Verifiers reject redirected proof URLs. Domain and GitHub proofs must be served directly from the claimed domain or GitHub account path.

## Peer Scoring

The weights below belong to the generic router-core scorer. Model-only routing
in the buyer proxy and desktop uses the shared Price + Trust ranking described
in [Reputation](./reputation.md#buyer-route-scoring).

| Dimension | Weight | Description |
|---|---|---|
| Price | 0.30 | Lower price scores higher (inverted min-max) |
| Latency | 0.25 | Lower latency scores higher (EMA-based) |
| Capacity | 0.20 | More available capacity scores higher |
| Reputation | 0.10 | Higher reputation scores higher (0-100) |
| Freshness | 0.10 | Recently seen peers score higher |
| Reliability | 0.05 | Lower failure rate and streak scores higher |

The generic scorer normalizes its factors across eligible candidates. The
lower-level `minPeerReputation` filter defaults to `0`, but model-only routing
also applies `buyer.routingPreferences.minTrustScore`, which defaults to `60`.
Setting the first filter to zero does not disable the second. Peers in a failure
cooldown are also excluded.

Buyers can filter by capability, Skill, minimum reputation, and price ceiling.
