# Join AntSeed as a Buyer (Client)

Help the user set up an AntSeed node to consume AI services from the peer-to-peer network. Walk them through installation, initialization, buyer configuration, and connecting their existing tools (Claude Code, Aider, Continue.dev, etc.) through the local proxy.

## Overview

A **buyer** (client) routes AI requests through the AntSeed network instead of directly to an API provider. A local HTTP proxy intercepts requests and forwards them to the best available peer on the network. The buyer pays per-token in USDC. From the tool's perspective, it's just hitting a different base URL.

## Step 1: Install the CLI

```bash
npm install -g @antseed/cli
```

Verify with `antseed --version`. Requires Node.js 20+.

## Step 2: Initialize the node

```bash
antseed init
```

This installs all trusted plugins, generates an identity keypair, and creates config at `~/.antseed/config.json`.

## Step 3: Configure buyer preferences

Set which providers the user wants to route through and their max willingness to pay:

```bash
# Which provider types to accept
antseed config buyer set preferredProviders '["anthropic"]'

# Max pricing (USD per 1M tokens) — reject peers charging more
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75

# Minimum peer reputation score (0-100, higher = stricter)
antseed config buyer set minPeerReputation 50

# Local proxy port (default 8377)
antseed config buyer set proxyPort 8377
```

## Step 4: Fund the escrow (optional, for paid network)

If the network requires USDC settlement:

```bash
# Check wallet balance
antseed balance

# Deposit USDC into escrow for session locks
antseed deposit 5
```

The balance command shows wallet USDC, escrowed USDC, committed (locked in active sessions), and available to spend.

## Step 5: Start the proxy

```bash
antseed connect --router local
```

This will:
1. Join the P2P network via DHT bootstrap nodes
2. Discover available providers matching buyer preferences
3. Start a local HTTP proxy on port 8377 (or configured port)
4. Display tool configuration hints

Custom port:

```bash
antseed connect --router local -p 8888
```

Runtime pricing overrides:

```bash
antseed connect --router local \
  --max-input-usd-per-million 30 \
  --max-output-usd-per-million 80
```

## Step 6: Point tools at the proxy

The proxy is API-compatible with Anthropic and OpenAI. Set environment variables so tools route through AntSeed:

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8377
claude
```

### Aider

```bash
export ANTHROPIC_BASE_URL=http://localhost:8377
aider --model anthropic/claude-sonnet-4-20250514
```

### Continue.dev (VS Code)

In `.continue/config.json`:

```json
{
  "models": [{
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiBase": "http://localhost:8377"
  }]
}
```

### OpenAI-compatible tools

```bash
export OPENAI_BASE_URL=http://localhost:8377
export OPENAI_API_KEY=antseed
```

### Python / direct HTTP

```python
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:8377")
```

The API key value doesn't matter when going through the proxy — set it to any non-empty string.

## Step 7: Monitor with dashboard (optional)

```bash
antseed dashboard
```

Opens web UI at `http://localhost:3117` showing connected peers, request routing, latency, and spending.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `~/.antseed/identity.key` exists
- [ ] `antseed connect --router local` starts without errors
- [ ] Proxy is listening on the configured port
- [ ] `curl http://localhost:8377/v1/models` returns available models
- [ ] Tools work with `ANTHROPIC_BASE_URL=http://localhost:8377`

## Troubleshooting

- **"No peers found"**: The network may be empty. Try running a local seeder too (`antseed seed --provider anthropic` in another terminal) to test the full loop.
- **"Connection refused on 8377"**: Make sure `antseed connect` is still running. Check if another process is using the port.
- **"DHT bootstrap failed"**: Check internet connectivity and firewall. The DHT uses UDP on random high ports.
- **Tool says "invalid API key"**: Set the API key env var to any non-empty value (e.g., `antseed`). The proxy doesn't validate it.
- **Slow responses**: The first request may be slow while the proxy discovers and connects to a peer. Subsequent requests reuse the connection.
