# 01 - Discovery Protocol

## Overview

The discovery protocol enables buyers to find sellers offering AI inference capacity on the Antseed Network. It combines BitTorrent Mainline DHT for decentralised peer location with an HTTP metadata endpoint for retrieving provider details, and a scoring system for selecting the best peer from the candidate pool.

---

## DHT Layer

**Source:** `node/src/discovery/dht-node.ts`, `node/src/discovery/bootstrap.ts`

The network uses the BitTorrent Mainline DHT (BEP 5) as a decentralised directory of seller nodes.

### Topic Hashing

Sellers announce themselves under a topic derived from their provider name:

```
topic  = "antseed:" + lowercase(providerName)
infoHash = SHA1(topic)                        // 20-byte info hash
```

The `providerTopic()` function lowercases the provider name and prepends the `antseed:` prefix. The `topicToInfoHash()` function produces a 20-byte SHA-1 digest used as the DHT info hash.

### Bootstrap Nodes

| Host                        | Port | Label        |
|-----------------------------|------|--------------|
| router.bittorrent.com       | 6881 | BitTorrent   |
| dht.transmissionbt.com      | 6881 | Transmission |
| router.utorrent.com         | 6881 | uTorrent     |
| dht.libtorrent.org          | 25401| libtorrent   |
| dht.aelitis.com             | 6881 | Vuze         |
| router.silotis.us           | 6881 | Silotis      |

Custom bootstrap nodes can be supplied and are merged (deduplicated by `host:port`) with the official list via `mergeBootstrapNodes()`.

### Default Configuration

| Parameter              | Value          | Constant / Location                          |
|------------------------|----------------|----------------------------------------------|
| Port                   | 6881           | `DEFAULT_DHT_CONFIG.port`                    |
| Re-announce interval   | 15 minutes     | `DEFAULT_DHT_CONFIG.reannounceIntervalMs` (15 * 60 * 1000 = 900 000 ms) |
| Operation timeout      | 10 seconds     | `DEFAULT_DHT_CONFIG.operationTimeoutMs` (10 000 ms) |

### Operations

- **`start()`** -- Binds the DHT socket to the configured port, bootstraps the routing table, and emits a `ready` event. If bootstrap does not complete within `operationTimeoutMs`, the node resolves anyway (partial bootstrap is acceptable).
- **`announce(infoHash, port)`** -- Announces the local peer under the given info hash at the given signaling port. Times out after `operationTimeoutMs`.
- **`lookup(infoHash)`** -- Queries the DHT for peers registered under the given info hash. Collects `{host, port}` pairs until the lookup callback fires or the operation times out.
- **`stop()`** -- Destroys the DHT instance and releases the socket.

---

## Metadata Protocol

### Metadata Version

**Source:** `node/src/discovery/peer-metadata.ts`

```
METADATA_VERSION = 3
```

### Data Structures

#### PeerMetadata

| Field       | Type                    | Description                             |
|-------------|-------------------------|-----------------------------------------|
| peerId      | PeerId (string)         | 64 hex chars (32-byte Ed25519 public key) |
| version     | number                  | Must equal `METADATA_VERSION` (3)       |
| displayName | string                  | Optional human-readable node label      |
| providers   | ProviderAnnouncement[]  | List of provider offerings              |
| region      | string                  | Geographic region identifier            |
| timestamp   | number                  | Unix epoch milliseconds                 |
| signature   | string                  | 128 hex chars (64-byte Ed25519 signature) |

#### ProviderAnnouncement

| Field            | Type     | Description                                                  |
|------------------|----------|--------------------------------------------------------------|
| provider         | string   | Provider name (e.g. "anthropic")                            |
| models           | string[] | List of model identifiers                                    |
| defaultPricing   | object   | Default `{ inputUsdPerMillion, outputUsdPerMillion }`       |
| modelPricing     | object   | Optional per-model map `{ [model]: { inputUsdPerMillion, outputUsdPerMillion } }` |
| modelCategories  | object   | Optional per-model map `{ [model]: string[] }` with lowercase tags |
| maxConcurrency   | number   | Maximum concurrent requests (>= 1)                           |
| currentLoad      | number   | Current number of active requests                            |

### Binary Encoding Format

**Source:** `node/src/discovery/metadata-codec.ts`

All multi-byte integers are big-endian. Strings are UTF-8 encoded.

```
Header:
  [version       : 1 byte   uint8 ]
  [peerId        : 32 bytes        ]   // raw Ed25519 public key
  [regionLen     : 1 byte   uint8 ]
  [region        : N bytes  UTF-8  ]   // N = regionLen
  [timestamp     : 8 bytes  BigUint64 big-endian ]
  [providerCount : 1 byte   uint8 ]

Per provider (repeated providerCount times):
  [providerLen   : 1 byte   uint8 ]
  [provider      : N bytes  UTF-8  ]   // N = providerLen
  [modelCount    : 1 byte   uint8 ]
  Per model (repeated modelCount times):
    [modelLen    : 1 byte   uint8 ]
    [model       : N bytes  UTF-8  ]   // N = modelLen
  [defaultInputUsdPerMillion  : 4 bytes  float32 big-endian ]
  [defaultOutputUsdPerMillion : 4 bytes  float32 big-endian ]
  [modelPricingCount          : 1 byte   uint8 ]
  Per model pricing entry (repeated modelPricingCount times):
    [modelLen   : 1 byte   uint8 ]
    [model      : N bytes  UTF-8  ]
    [inputUsdPerMillion  : 4 bytes  float32 big-endian ]
    [outputUsdPerMillion : 4 bytes  float32 big-endian ]
  [modelCategoryCount         : 1 byte   uint8 ]      // v3+
  Per model category entry (repeated modelCategoryCount times):
    [modelLen   : 1 byte   uint8 ]
    [model      : N bytes  UTF-8  ]
    [categoryCount : 1 byte uint8 ]
    Per category (repeated categoryCount times):
      [categoryLen : 1 byte uint8 ]
      [category    : N bytes UTF-8 ]
  [maxConcurrency: 2 bytes  uint16  big-endian ]
  [currentLoad   : 2 bytes  uint16  big-endian ]

Post-provider sections:
  [displayNameFlag:1]                             // v3+
  if displayNameFlag == 1:
    [displayNameLen:1][displayName:N]
  [offeringCount:2]                               // uint16
  [offeringEntries...]
  [evmAddressFlag:1] + [evmAddress:20 if present]
  [onChainReputationFlag:1] + [reputationData:10 if present]

Trailer:
  [signature     : 64 bytes        ]   // Ed25519 signature
```

The body (everything except the trailing 64-byte signature) is the data that is signed. `encodeMetadataForSigning()` produces this body without the signature for signing and verification purposes.

### Validation Limits

**Source:** `node/src/discovery/metadata-validator.ts`

| Constant                  | Value | Description                                 |
|---------------------------|-------|---------------------------------------------|
| MAX_METADATA_SIZE         | 1000  | Maximum encoded size in bytes               |
| MAX_PROVIDERS             | 10    | Maximum provider entries per metadata       |
| MAX_MODELS_PER_PROVIDER   | 20    | Maximum models per provider entry           |
| MAX_MODEL_NAME_LENGTH     | 64    | Maximum model name length in characters     |
| MAX_REGION_LENGTH         | 32    | Maximum region string length in characters  |
| MAX_DISPLAY_NAME_LENGTH   | 64    | Maximum display name length in characters   |
| MAX_MODEL_CATEGORIES_PER_MODEL | 8 | Maximum categories per model               |
| MAX_MODEL_CATEGORY_LENGTH | 32    | Maximum category length in characters       |

Additional validation rules enforced by `validateMetadata()`:

- `version` must equal `METADATA_VERSION` (3).
- `peerId` must be exactly 64 lowercase hex characters.
- `region` must not be empty.
- `displayName` is optional, but when present it must be non-empty and <= 64 chars.
- `timestamp` must be a positive finite number.
- At least one provider must be present.
- `defaultPricing.inputUsdPerMillion` and `defaultPricing.outputUsdPerMillion` must be non-negative.
- Each `modelPricing[model].inputUsdPerMillion` and `modelPricing[model].outputUsdPerMillion` (if present) must be non-negative.
- `modelCategories` (if present) must reference models listed in `providers[].models`.
- Each category must be lowercase alphanumeric or hyphen: `^[a-z0-9][a-z0-9-]*$`.
- Categories must be non-empty, unique per model, and within per-model/per-tag limits above.
- Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (not enforced; custom tags allowed).
- `maxConcurrency` must be at least 1.
- `currentLoad` must be non-negative and must not exceed `maxConcurrency`.
- `signature` must be exactly 128 lowercase hex characters (64 bytes).
- The full encoded payload must not exceed `MAX_METADATA_SIZE`.

---

## Metadata HTTP Endpoint

### Server Side

**Source:** `node/src/discovery/metadata-server.ts`

The seller runs an HTTP server that exposes its current metadata:

- **Listen address:** `0.0.0.0` on the configured port.
- **Endpoint:** `GET /metadata`
- **Success response:** `200` with `content-type: application/json` body containing JSON-serialized `PeerMetadata`.
- **Not ready response:** `503` with `{"error": "metadata not available"}` when `getMetadata()` returns `null`.
- **Unknown path:** `404` with `{"error": "not found"}`.
- **Wrong method:** `405` with `{"error": "method not allowed"}`.

### Client Side

**Source:** `node/src/discovery/http-metadata-resolver.ts`

The buyer resolves metadata from a discovered peer's HTTP endpoint:

| Parameter              | Default | Description                                          |
|------------------------|---------|------------------------------------------------------|
| timeoutMs              | 5000    | HTTP fetch timeout in milliseconds                   |
| metadataPortOffset     | 0       | Offset from the signaling port to the metadata port  |

The metadata URL is constructed as:

```
http://{host}:{port + metadataPortOffset}/metadata
```

On any non-OK response, network error, timeout, or invalid JSON, the resolver returns `null` (fail-closed).

---

## Peer Lookup

**Source:** `node/src/discovery/peer-lookup.ts`

The `PeerLookup` class orchestrates the full discovery flow:

1. Compute `infoHash = SHA1("antseed:" + lowercase(provider))`.
2. Query the DHT for the info hash to obtain a list of `{host, port}` peer endpoints.
3. For each peer (up to `maxResults`):
   a. Fetch metadata via the configured `MetadataResolver`.
   b. If `requireValidSignature` is `true`, verify the Ed25519 signature over the encoded body using the peer's public key (`peerId`). Discard peers with invalid signatures.
   c. If `allowStaleMetadata` is `false`, discard metadata where `Date.now() - timestamp > maxAnnouncementAgeMs`.
4. Return the list of `{metadata, host, port}` results.

### Default Lookup Configuration

| Parameter                | Default Value    | Description                              |
|--------------------------|------------------|------------------------------------------|
| requireValidSignature    | true             | Reject metadata with invalid signatures  |
| allowStaleMetadata       | false            | Reject stale metadata                    |
| maxAnnouncementAgeMs     | 30 minutes       | 30 * 60 * 1000 = 1 800 000 ms           |
| maxResults               | 50               | Maximum peers returned per lookup        |

---

## Peer Announcement

**Source:** `node/src/discovery/announcer.ts`

The `PeerAnnouncer` class handles the seller-side announcement lifecycle:

1. Build a `PeerMetadata` object from the configured providers, current pricing, current load, and region.
2. Set `version` to `METADATA_VERSION` (3) and `timestamp` to `Date.now()`.
3. Encode the body (without signature) via `encodeMetadataForSigning()`.
4. Sign the body with the seller's Ed25519 private key.
5. For each provider in the metadata, compute `infoHash = SHA1("antseed:" + lowercase(provider))` and announce on the DHT at the configured signaling port.

Periodic re-announcement is managed by `startPeriodicAnnounce()`, which calls `announce()` immediately and then every `reannounceIntervalMs` milliseconds. Load can be updated at any time via `updateLoad(providerName, currentLoad)` and will be reflected in the next announcement cycle.

---

## Peer Scoring

**Source:** `node/src/discovery/peer-selector.ts`

### Scoring Weights

| Dimension   | Default Weight | Description                              |
|-------------|----------------|------------------------------------------|
| price       | 0.35           | Preference for lower price               |
| capacity    | 0.25           | Preference for available capacity        |
| latency     | 0.25           | Preference for lower latency             |
| reputation  | 0.15           | Preference for higher reputation         |

### Score Formulas

All individual scores are normalised to the range [0, 1]. The final composite score is clamped to [0, 1].

```
priceScore    = min(cheapestInputPrice / candidate.inputUsdPerMillion, 1.0)
                (1.0 if candidate price is 0)

capacityScore = (maxConcurrency - currentLoad) / maxConcurrency
                (0 if maxConcurrency is 0)

latencyScore  = clamp(1 - latencyMs / 15000, 0, 1)

reputationScore = clamp(candidate.reputation, 0, 1)

score = clamp(
    price    * priceScore    +
    capacity * capacityScore +
    latency  * latencyScore  +
    reputation * reputationScore,
    0, 1
)
```

The latency baseline is **15 000 ms**. A peer with 0 ms latency scores 1.0; a peer at or above 15 000 ms scores 0.0.

The `cheapestInputPrice` is the minimum positive `inputUsdPerMillion` across all candidates in the pool.

### Selection Strategies

- **`selectBestPeer(candidates, weights)`** -- Returns the single highest-scoring candidate, or `null` if the list is empty.
- **`rankPeers(candidates, weights)`** -- Returns all candidates sorted by descending score.
- **`selectDiversePeers(candidates, count, weights)`** -- Returns up to `count` candidates, preferring geographic diversity. First pass picks the best candidate from each unique region; second pass fills remaining slots by score.

---

## DHT Health Monitoring

**Source:** `node/src/discovery/dht-health.ts`

The `DHTHealthMonitor` tracks operational health of the DHT node.

### Default Health Thresholds

| Threshold              | Default Value | Description                                  |
|------------------------|---------------|----------------------------------------------|
| minNodeCount           | 5             | Minimum DHT routing table nodes              |
| minLookupSuccessRate   | 0.3           | Minimum lookup success ratio (after 5+ lookups) |
| maxAvgLookupLatencyMs  | 15 000        | Maximum average lookup latency (after 5+ samples) |

The node is considered healthy when all applicable thresholds are satisfied. Latency samples are kept in a rolling window of up to 100 entries.
