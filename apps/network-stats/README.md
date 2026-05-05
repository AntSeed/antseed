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

## Layout

- `src/` — Express backend: DHT poller, on-chain indexer, HTTP API.
- `web/` — Vite + React dashboard that consumes `/stats` (TanStack Query for polling).

In production, `pnpm build` outputs both `dist/` (server) and `dist/web/` (SPA), and the
Express server serves the SPA from `/` via `express.static` alongside the JSON API.

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
| `NETWORK_STATS_RPC_URL` | resolved per chain | Override the JSON-RPC endpoint used by the on-chain indexer + backfill |

A gitignored `.env.local` in this directory is auto-loaded on startup, so
local dev can keep an Alchemy/QuickNode URL out of the shell.

## Development

From the monorepo root:

```bash
pnpm dev:network-stats
```

This builds `@antseed/node` + the server, then runs `vite` (port 5180), `tsc --watch`,
and `node --watch dist/index.js` concurrently. Open http://localhost:5180 — Vite
proxies `/stats` and `/health` to the backend on port 4000.

```bash
pnpm build
pnpm test
```
