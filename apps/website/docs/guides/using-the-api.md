---
sidebar_position: 2
slug: /using-the-api
title: Using the API
hide_title: true
---

# Using the API

Once connected to the AntSeed network, your buyer proxy exposes a local API at `http://localhost:8377`. Point any AI tool at this endpoint — the proxy handles peer discovery, routing, and payments transparently.

## Quick Start

```bash
# 1. Set your identity
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 2. Deposit USDC (via payments portal)
antseed payments
# Open http://localhost:3118, connect a funded wallet, deposit USDC

# 3. Connect to the network
antseed connect --router local
# Proxy listening on http://localhost:8377
```

## Supported API Formats

The proxy accepts three API formats. Use whichever matches your tool:

| Endpoint | Format | Compatible Tools |
|---|---|---|
| `/v1/messages` | Anthropic Messages API | Claude Code, Claude SDK |
| `/v1/chat/completions` | OpenAI Chat Completions | Codex, any OpenAI-compatible client |
| `/v1/responses` | OpenAI Responses API | Codex |

The `model` field in your request determines which service to route to. The proxy finds the best available provider for that service on the network.

## Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8377
claude
```

Claude Code sends requests to `/v1/messages` and the proxy routes them to the best available Anthropic provider on the network.

## Codex

```bash
export OPENAI_BASE_URL=http://localhost:8377/v1
export OPENAI_API_KEY=unused
codex
```

## curl

```bash
# Anthropic format
curl http://localhost:8377/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI format
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v3.1",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## How Routing Works

When you send a request:

1. The proxy extracts the `model` field as the service name
2. The router queries the DHT for peers offering that service
3. Peers are scored by price, latency, capacity, and reputation
4. The request is forwarded to the best peer via encrypted WebRTC
5. The response streams back through the proxy

If a peer fails or is unavailable, the router retries with the next best peer.

## Session Overrides

Pin requests to a specific service or peer without restarting:

```bash
# Pin to a service (overrides the model field in all requests)
antseed connection set --service claude-opus-4-6

# Pin to a specific peer
antseed connection set --peer <40-char-hex-peer-id>

# Check current overrides
antseed connection get

# Clear overrides
antseed connection clear
```

## Browse Available Services

See what's available on the network before connecting:

```bash
antseed browse
```

This shows all discoverable providers, their services, pricing, and capacity.

## No API Key Needed

The proxy does not require an API key. Authentication and payments are handled by the protocol using your node's identity key and on-chain USDC deposits. Tools that require an API key (like Codex) can use any placeholder value.
