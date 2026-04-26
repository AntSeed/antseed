# 01 - Discovery Protocol

## Overview

The discovery protocol enables buyers to find sellers offering AI inference capacity on the Antseed Network. It uses a DHT network (built on BEP 5) combined with an HTTP metadata endpoint for retrieving provider details, and a scoring system for selecting the best peer from the candidate pool.

---

## DHT Layer

**Source:** `node/src/discovery/dht-node.ts`, `node/src/discovery/bootstrap.ts`

The network uses the BitTorrent Mainline DHT (BEP 5) as a decentralised directory of seller nodes.

### Topic Hashing

Sellers announce a small fixed set of topics on the DHT — one subnet, the wildcard, the per-peer topic, and any capability topics. Service-level topics were intentionally removed: the signed metadata document carries the full service catalog (`providers[].services`, pricing, categories, protocols), so service filtering is metadata-driven and the announce cycle stays O(1) in the seller's service count regardless of how many services a provider exposes.

```
ANTSEED_WILDCARD_TOPIC           = "antseed:*"
subnetTopic(index)               = "antseed:subnet:" + index
peerTopic(peerId)                = "antseed:peer:" + normalizeHex(peerId)
capabilityTopic(capability)      = "antseed:" + normalize(capability)
capabilityTopic(capability,id)   = "antseed:" + normalize(capability) + ":" + normalize(id)

normalize(x) = trim(lowercase(x))
normalizeHex(x) = trim(lowercase(x)).removeLeading("0x")
subnet(peer) = parseInt(peerId[0:2], 16) % SUBNET_COUNT   // SUBNET_COUNT = 16
infoHash     = SHA1(topic)      // 20-byte info hash
```

The announcer always publishes the peer's `subnetTopic`, the wildcard topic (kept during the subnet rollout for older buyers), the per-peer topic, and any configured capability topics. Service filtering is performed against the signed metadata fetched after enumeration.

`topicToInfoHash()` produces the SHA-1 digest used as the DHT info hash.

### Bootstrap Nodes

| Host                  | Port | Label      |
|-----------------------|------|------------|
| dht1.antseed.com      | 6881 | AntSeed-1  |
| dht2.antseed.com      | 6881 | AntSeed-2  |

Custom bootstrap nodes can be supplied and are merged (deduplicated by `host:port`) with the official list via `mergeBootstrapNodes()`.

### Default Configuration

| Parameter              | Value          | Constant / Location                          |
|------------------------|----------------|----------------------------------------------|
| Port                   | 6881           | `DEFAULT_DHT_CONFIG.port`                    |
| Re-announce interval   | 5 minutes      | `DEFAULT_DHT_CONFIG.reannounceIntervalMs` (5 * 60 * 1000 = 300 000 ms) |
| Operation timeout      | 25 seconds     | `DEFAULT_DHT_CONFIG.operationTimeoutMs` (25 000 ms) |
| Subnet count           | 16             | `SUBNET_COUNT` in `dht-node.ts`              |

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
METADATA_VERSION = 7
```

### Data Structures

#### PeerMetadata

| Field       | Type                    | Description                             |
|-------------|-------------------------|-----------------------------------------|
| peerId      | PeerId (string)         | 40 hex chars (20-byte EVM address)      |
| version     | number                  | Must equal `METADATA_VERSION` (7)       |
| displayName | string                  | Optional human-readable node label      |
| publicAddress | string                | Optional public `host:port` buyers should dial instead of the raw DHT source address |
| providers   | ProviderAnnouncement[]  | List of provider offerings              |
| region      | string                  | Geographic region identifier            |
| timestamp   | number                  | Unix epoch milliseconds                 |
| signature   | string                  | 130 hex chars (65-byte secp256k1 signature) |

#### ProviderAnnouncement

| Field            | Type     | Description                                                  |
|------------------|----------|--------------------------------------------------------------|
| provider         | string   | Provider name (e.g. "anthropic")                            |
| services         | string[] | List of service identifiers                                  |
| defaultPricing   | object   | Default `{ inputUsdPerMillion, cachedInputUsdPerMillion?, outputUsdPerMillion }` |
| servicePricing     | object   | Optional per-service map `{ [service]: { inputUsdPerMillion, cachedInputUsdPerMillion?, outputUsdPerMillion } }` |
| serviceCategories  | object   | Optional per-service map `{ [service]: string[] }` with lowercase tags |
| serviceApiProtocols| object   | Optional per-service map `{ [service]: string[] }` of supported service API protocols |
| maxConcurrency   | number   | Maximum concurrent requests (>= 1)                           |
| currentLoad      | number   | Current number of active requests                            |

### Binary Encoding Format

**Source:** `node/src/discovery/metadata-codec.ts`

All multi-byte integers are big-endian. Strings are UTF-8 encoded.

```
Header:
  [version       : 1 byte   uint8 ]
  [peerId        : 20 bytes        ]   // EVM address
  [regionLen     : 1 byte   uint8 ]
  [region        : N bytes  UTF-8  ]   // N = regionLen
  [timestamp     : 8 bytes  BigUint64 big-endian ]
  [providerCount : 1 byte   uint8 ]

Per provider (repeated providerCount times):
  [providerLen   : 1 byte   uint8 ]
  [provider      : N bytes  UTF-8  ]   // N = providerLen
  [serviceCount  : 1 byte   uint8 ]
  Per service (repeated serviceCount times):
    [serviceLen  : 1 byte   uint8 ]
    [service     : N bytes  UTF-8  ]   // N = serviceLen
  [defaultInputUsdPerMillion       : 4 bytes  float32 big-endian ]
  [defaultOutputUsdPerMillion      : 4 bytes  float32 big-endian ]
  [defaultCachedInputUsdPerMillion : 4 bytes  float32 big-endian ]   // v7+; defaults to defaultInputUsdPerMillion
  [servicePricingCount          : 1 byte   uint8 ]
  Per service pricing entry (repeated servicePricingCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [inputUsdPerMillion       : 4 bytes  float32 big-endian ]
    [outputUsdPerMillion      : 4 bytes  float32 big-endian ]
    [cachedInputUsdPerMillion : 4 bytes  float32 big-endian ]   // v7+; defaults to inputUsdPerMillion
  [serviceCategoryCount       : 1 byte   uint8 ]      // v3+
  Per service category entry (repeated serviceCategoryCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [categoryCount : 1 byte uint8 ]
    Per category (repeated categoryCount times):
      [categoryLen : 1 byte uint8 ]
      [category    : N bytes UTF-8 ]
  [serviceApiProtocolCount    : 1 byte   uint8 ]      // v4+
  Per service API protocol entry (repeated serviceApiProtocolCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [protocolCount : 1 byte uint8 ]
    Per protocol (repeated protocolCount times):
      [protocolLen : 1 byte uint8 ]
      [protocol    : N bytes UTF-8 ]
  [maxConcurrency: 2 bytes  uint16  big-endian ]
  [currentLoad   : 2 bytes  uint16  big-endian ]

Post-provider sections:
  [displayNameFlag:1]                             // v3+
  if displayNameFlag == 1:
    [displayNameLen:1][displayName:N]
  [publicAddressFlag:1]                           // v5+
  if publicAddressFlag == 1:
    [publicAddressLen:1][publicAddress:N]
  [offeringCount:2]                               // uint16
  [offeringEntries...]
  [evmAddressFlag:1] + [evmAddress:20 if present]
  [onChainStatsFlag:1] + [statsData:10 if present]

Trailer:
  [signature     : 65 bytes        ]   // secp256k1 signature
```

The body (everything except the trailing 65-byte signature) is the data that is signed. `encodeMetadataForSigning()` produces this body without the signature for signing and verification purposes.

### Validation Limits

**Source:** `node/src/discovery/metadata-validator.ts`

| Constant                  | Value | Description                                 |
|---------------------------|-------|---------------------------------------------|
| MAX_METADATA_SIZE         | 1000  | Maximum encoded size in bytes               |
| MAX_PROVIDERS             | 10    | Maximum provider entries per metadata       |
| MAX_SERVICES_PER_PROVIDER | 20    | Maximum services per provider entry         |
| MAX_SERVICE_NAME_LENGTH   | 64    | Maximum service name length in characters   |
| MAX_REGION_LENGTH         | 32    | Maximum region string length in characters  |
| MAX_DISPLAY_NAME_LENGTH   | 64    | Maximum display name length in characters   |
| MAX_PUBLIC_ADDRESS_LENGTH | 255   | Maximum public address length in characters |
| MAX_SERVICE_CATEGORIES_PER_SERVICE | 8 | Maximum categories per service           |
| MAX_SERVICE_CATEGORY_LENGTH | 32  | Maximum category length in characters       |
| MAX_SERVICE_API_PROTOCOLS_PER_SERVICE | 4 | Maximum protocol entries per service |

Additional validation rules enforced by `validateMetadata()`:

- `version` must equal `METADATA_VERSION` (7).
- `peerId` must be exactly 40 lowercase hex characters.
- `region` must not be empty.
- `displayName` is optional, but when present it must be non-empty and <= 64 chars.
- `publicAddress` is optional, but when present it must be a valid `host:port` and is signed as part of the metadata.
- `timestamp` must be a positive finite number.
- At least one provider must be present.
- `defaultPricing.inputUsdPerMillion` and `defaultPricing.outputUsdPerMillion` must be non-negative.
- `defaultPricing.cachedInputUsdPerMillion` (if present) must be non-negative. Defaults to `inputUsdPerMillion` when omitted.
- Each `servicePricing[service].inputUsdPerMillion` and `servicePricing[service].outputUsdPerMillion` (if present) must be non-negative.
- Each `servicePricing[service].cachedInputUsdPerMillion` (if present) must be non-negative. Defaults to the service's `inputUsdPerMillion` when omitted.
- `serviceCategories` (if present) must reference services listed in `providers[].services`.
- Each category must be lowercase alphanumeric or hyphen: `^[a-z0-9][a-z0-9-]*$`.
- Categories must be non-empty, unique per service, and within per-service/per-tag limits above.
- Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (not enforced; custom tags allowed).
- `serviceApiProtocols` (if present) must reference services listed in `providers[].services`.
- `serviceApiProtocols` entries must be known protocol IDs, non-empty, unique per service, and within per-service limits above.
- `maxConcurrency` must be at least 1.
- `currentLoad` must be non-negative and must not exceed `maxConcurrency`.
- `signature` must be exactly 130 lowercase hex characters (65 bytes).
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

| Parameter              | Default | Description                                                         |
|------------------------|---------|---------------------------------------------------------------------|
| timeoutMs              | 2000    | HTTP fetch timeout in milliseconds                                  |
| metadataPortOffset     | 0       | Offset from the signaling port to the metadata port                 |
| failureCooldownMs      | 30000   | How long to skip an endpoint after it fails                         |

The metadata URL is constructed as:

```
http://{host}:{port + metadataPortOffset}/metadata
```

On any non-OK response, network error, timeout, or invalid JSON, the resolver returns `null` (fail-closed) and marks both the specific endpoint and the peer's host as failed for `failureCooldownMs`. Subsequent resolution attempts for any port on the same host are skipped immediately until the cooldown expires.

All peers returned by a DHT lookup are resolved in parallel, so a single slow or unreachable endpoint does not delay the others.

---

## Peer Lookup

**Source:** `node/src/discovery/peer-lookup.ts`

The `PeerLookup` class orchestrates the full discovery flow:

1. Build lookup topic(s):
   - all-peer lookup: `SHA1(subnetTopic(i))` for every subnet, plus `SHA1(ANTSEED_WILDCARD_TOPIC)` as a transition fallback
   - service "lookup": there is no DHT-level service lookup. Service filtering happens against the signed metadata returned by `findAll()` — see `AntseedNode.discoverPeers(service)`.
   - capability lookup: `SHA1(capabilityTopic(capability[, name]))`
   - per-peer lookup (`findByPeerId`): `SHA1(peerTopic(peerId))`
2. Query the DHT for the topic hash(es) to obtain `{host, port}` peer endpoints.
   `DHTNode.lookupMany(hashes)` shares one temporary `peer` listener across all hashes so the 17-way subnet fan-out doesn't trip Node's default EventEmitter listener cap.
   Per-infohash lookup failures are absorbed (return zero endpoints for that hash) so a misbehaving subnet does not abort the whole enumeration.
3. For each peer (up to `maxResults`):
   a. Fetch metadata via the configured `MetadataResolver`.
   b. If `requireValidSignature` is `true`, verify the secp256k1 signature over the encoded body using ecrecover and compare the recovered address to the peer's `peerId`. Discard peers with invalid signatures.
   c. If `allowStaleMetadata` is `false`, discard metadata where `Date.now() - timestamp > maxAnnouncementAgeMs`.
4. Return the list of `{metadata, host, port}` results.

### Default Lookup Configuration

| Parameter                | Default Value    | Description                              |
|--------------------------|------------------|------------------------------------------|
| requireValidSignature    | true             | Reject metadata with invalid signatures  |
| allowStaleMetadata       | false            | Reject stale metadata                    |
| maxAnnouncementAgeMs     | 30 minutes       | 30 * 60 * 1000 = 1 800 000 ms           |
| maxResults               | 200              | Maximum peers returned per lookup        |

---

## Peer Announcement

**Source:** `node/src/discovery/announcer.ts`

The `PeerAnnouncer` class handles the seller-side announcement lifecycle:

1. Build a `PeerMetadata` object from the configured providers, current pricing, current load, and region.
2. Set `version` to `METADATA_VERSION` (7) and `timestamp` to `Date.now()`.
3. Encode the body (without signature) via `encodeMetadataForSigning()`.
4. Sign the body with the seller's secp256k1 private key (via EIP-191 personal_sign).
5. Announce DHT topics in parallel at the configured signaling port (constant in service count):
   - subnet topic (`subnetTopic(subnetOf(peerId))`)
   - wildcard topic (`ANTSEED_WILDCARD_TOPIC`) — kept during the subnet rollout so older buyers still find this peer
   - per-peer topic (`peerTopic(peerId)`)
   - capability topics when offerings are configured (one per offering plus one per unique capability name)

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
