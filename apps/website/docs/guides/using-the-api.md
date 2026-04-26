---
sidebar_position: 2
slug: /guides/using-the-api
title: Using the API
hide_title: true
---

# Using the API

Once connected to the AntSeed network, your buyer proxy exposes a local API at `http://localhost:8377`. Point any AI tool at this endpoint — the proxy handles peer discovery, routing, and payments transparently.

## Quick Start

```bash
# 1. Install
npm install -g @antseed/cli

# 2. Set your identity
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 3. Start the buyer proxy
antseed buyer start
# Proxy listening on http://localhost:8377

# 4. Pick a peer to route through
antseed network browse                              # list peers + services
antseed buyer connection set --peer <40-char-hex>   # pin one

# 5. Deposit USDC when you want to pay providers
antseed payments
# Open http://localhost:3118, connect a funded wallet, deposit USDC
```

Until a peer is pinned, every request returns `no_peer_pinned` — there is no auto-selection. See [Pick a peer](#pick-a-peer) below.

`antseed buyer start` does not require a pre-existing `~/.antseed/config.json`. If the file is missing, the CLI starts with built-in defaults such as router `local` and proxy port `8377`.

Extra buyer config is optional. Add it only for advanced customization such as pricing caps, reputation thresholds, bootstrap nodes, or chain settings:

```json
{
  "buyer": {
    "minPeerReputation": 50,
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 25,
        "outputUsdPerMillion": 75
      }
    }
  },
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

With a config file like that in place, the startup command is still just:

```bash
antseed buyer start
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

## Pick a peer

The buyer proxy does not auto-select peers. Every request returns `no_peer_pinned` until you pin one — this keeps routing predictable and puts pricing/quality choice in your hands.

```bash
# List peers and the services each one offers
antseed network browse

# Inspect one peer in detail (pricing, protocols, on-chain stats)
antseed network peer <40-char-hex-peer-id>

# Pin a peer for the session (survives daemon restart)
antseed buyer connection set --peer <40-char-hex-peer-id>

# Pin a service too — overrides the `model` field in all requests
antseed buyer connection set --service claude-opus-4-6

# Clear pins
antseed buyer connection clear
```

You can also pin per-request by sending the `x-antseed-pin-peer: <peerId>` header — useful when different calls should go to different peers.

## How Routing Works

When you send a request:

1. The proxy verifies a peer is pinned; if not, it returns `no_peer_pinned`.
2. It checks the pinned peer's metadata for the requested `model` (the service name).
3. The request is forwarded to that peer via encrypted WebRTC.
4. The response streams back through the proxy.

## No API Key Needed

The proxy does not require an API key. Authentication and payments are handled by the protocol using your node's identity key and on-chain USDC deposits. Tools that require an API key (like Codex) can use any placeholder value.

## Agent Skills

If you're using Pi, Codex or another agent, these skills can walk you through the full setup:

- [`antseed/antseed-pi`](https://github.com/AntSeed/pi-antseed) — Use the AntSeed local buyer proxy as a model provider in pi.
- [`@skills/join-buyer`](https://github.com/AntSeed/antseed/tree/main/skills/join-buyer) — step-by-step buyer setup for Claude Code agents
- [`@skills/openclaw-antseed`](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) — connect OpenClaw to AntSeed as a buyer
