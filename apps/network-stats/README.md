# @antseed/network-stats

Standalone service that polls the AntSeed network as an anonymous buyer and exposes live peer/model stats over HTTP.

## What it does

- Connects to the network via DHT discovery every 15 minutes
- Extracts: active peer count + list of available services
- Caches result to `cache/network.json`
- Exposes a simple Express API for XHR consumption by the website

## API

```
GET /stats   →  { peers: number, services: string[], updatedAt: string }
GET /health  →  { ok: true }
```

### `GET /stats/buyer/:address`

Returns aggregated on-chain stats for a specific buyer EVM address, across
every seller the buyer has settled with.

**Path params:**
- `address` — a lowercase 0x-prefixed 40-hex-char EVM address

**Responses:**

- `200 OK` — `{ buyer, totals, bySeller, indexer? }`. When the buyer has
  never settled on-chain, `totals` is `null` and `bySeller` is `[]`.
- `400 Bad Request` — buyer address does not match `/^0x[0-9a-f]{40}$/`
- `503 Service Unavailable` — this instance has no indexer configured

**Example:**

```bash
curl https://network.antseed.com/stats/buyer/0xabc...def
```

Response:
```json
{
  "buyer": "0xabc...def",
  "totals": {
    "totalRequests": "1234",
    "totalInputTokens": "10000",
    "totalOutputTokens": "20000",
    "totalSettlements": 42,
    "uniqueSellers": 3,
    "firstBlock": 44469600,
    "lastBlock": 44890000
  },
  "bySeller": [
    {
      "agentId": 12,
      "peerId": "abc...",
      "publicAddress": "0xabc...",
      "totalRequests": "900",
      "totalInputTokens": "8000",
      "totalOutputTokens": "15000",
      "settlementCount": 30,
      "firstBlock": 44469600,
      "lastBlock": 44890000
    }
  ],
  "indexer": {
    "lastBlock": 44890000,
    "lastBlockTimestamp": 1760000000,
    "latestBlock": 44890000,
    "synced": true
  }
}
```

## Usage

```bash
pnpm install
pnpm build
pnpm start
```

Environment variables:

| Variable     | Default | Description                        |
|--------------|---------|------------------------------------|
| `PORT`       | `4000`  | HTTP port to listen on             |
| `CACHE_PATH` | `cache/network.json` | Path to write JSON cache |

## Development

```bash
pnpm build
pnpm test
```
