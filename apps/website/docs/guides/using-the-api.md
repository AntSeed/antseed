---
sidebar_position: 2
slug: /guides/using-the-api
title: Using the API
hide_title: true
---

# Using the API

Once connected to the AntSeed network, your buyer proxy exposes a local API at `http://localhost:8377`. Point any AI tool at this endpoint — the proxy handles peer discovery, routing, and payments transparently.

There are two ways to get that proxy running:

- **VPR desktop app (recommended)** — download from [antseed.com](https://antseed.com). While the app is open it runs the buyer proxy at `http://localhost:8377` for you, and its **Apps** view detects tools like Claude Code and Codex on your machine and launches them already wired to AntSeed. Routing also works best from the VPR: it auto-selects the best peer for a model and lets you switch models per chat from a dropdown, so you never manage pins by hand. Deposits and peer browsing live in the same UI.
- **CLI** — `antseed buyer start`, for headless machines, servers, and scripts. The Quick Start below covers this path.

Everything in this guide works identically against both.

## Quick Start (CLI)

```bash
# 1. Install
npm install -g @antseed/cli

# 2. Set your identity
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 3. Start the buyer proxy
antseed buyer start
# Proxy listening on http://localhost:8377

# 4. Browse available models and peers
curl -s http://localhost:8377/v1/models | jq '.data[].id'
antseed network browse

# 5. Make a request — the model name auto-selects the highest-reputation
#    compatible peer allowed by your buyer policy
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 6. Deposit USDC when you want to pay providers
antseed payments
# Open http://localhost:3118, connect a funded wallet, deposit USDC
```

Model-only requests automatically select the highest-reputation compatible peer that passes your buyer pricing and reputation policy. To force one seller, encode the peer in the model field: `"model": "<peerId>@deepseek-v4-flash"`. See [Pick a peer and model](#pick-a-peer-and-model) below.

`antseed buyer start` does not require a pre-existing `~/.antseed/config.json`. If the file is missing, the CLI starts with built-in defaults such as router `local` and proxy port `8377`. The proxy binds to `127.0.0.1` only — it is never exposed to your LAN.

## Pick a peer and model

The buyer proxy can auto-select a peer from the requested model, or you can override that choice with one of three explicit pin mechanisms:

| Mechanism | Scope | How |
|---|---|---|
| **Model prefix** `<peerId>@<model>` | one request | `"model": "<peerId>@deepseek-v4-flash"` |
| **Header** `x-antseed-pin-peer: <peerId>` | one request | works even when the tool controls the model field |
| **Session pin** | until changed | `antseed buyer connection set --peer <peerId>` (survives daemon restart) |

Precedence when several are present: header > model prefix > session pin. The model prefix is always stripped before routing, so `<peerId>@deepseek-v4-flash` reaches the seller as model `deepseek-v4-flash`.

Without a pin, the proxy canonicalizes the requested model name, considers every compatible peer advertising that model, applies buyer policy, and selects the highest-reputation remaining peer. The `<peerId>@<model>` form forces a specific seller and works in the model field of **every** tool and SDK that lets you type a model name — Claude Code, Codex, LangChain, the Vercel AI SDK, curl. The peer id is 40 hex chars, with or without a `0x` prefix, case-insensitive. One caveat: the prefix rewrite needs a JSON body, so it does not work on multipart requests (`/v1/images/edits`) — use the header there.

```bash
# Discover peers and what they serve
antseed network browse                    # all peers + services + pricing
antseed network browse --service deepseek # filter by service name
antseed network peer <peerId>             # one peer in detail (pricing, protocols, on-chain stats)

# Pin / unpin a session peer
antseed buyer connection set --peer <peerId>
antseed buyer connection clear

# List every model on the network (answered locally; free, no pin needed)
curl -s http://localhost:8377/v1/models | jq '.data[].id'

# Only image-generation models, with the peers that serve them
curl -s 'http://localhost:8377/v1/models?type=images' | jq '.data[] | {id, peers: [.peers[].peerId]}'
```

`GET /v1/models` is answered locally from the buyer's discovered-peer cache and covers the **whole network** — no peer pin required. Cosmetic names and conservative aliases such as `claude-opus-5` and `opus-5` are grouped into one entry, whose `aliases` array includes normalized observed names and the compact canonical key (for example `['claude-opus-5', 'opus-5', 'opus5']`). Established model families also merge numeric-version punctuation and conservative flattened vendor prefixes, so names such as `gpt-5.6-sol`, `gpt-56-sol`, and `openai-gpt-56-sol` resolve to the same entry; meaningful suffixes such as `pro`, `fast`, and `web` remain distinct. Each entry lists the aggregate model id, its `type` (`text` or `image`), and a `peers` array with every seller serving it. Each peer offer includes its provider, actual advertised `serviceId`, resolved `protocol`, announced `protocols`, reputation, pricing, categories, and seller-reported capabilities such as context window, output limit, modalities, reasoning, tool use, structured output, and supported parameters. Offers use the same reputation ordering as the desktop VPR: `onChainTrustScore` first, falling back to `onChainReputationScore`; the selected value is also returned as `reputationScore`. Missing scores are returned as `null` and sorted last. Filter with `?type=text` or `?type=images`, or look up a single model with `GET /v1/models/<id>`. Sending an API request with only one of these model names automatically selects the highest-reputation compatible peer allowed by buyer policy; route to a specific offer explicitly with `<peerId>@<serviceId>` using values from that same `peers[]` item.

Model-level `context_length`, `max_output_tokens`, modalities, capability booleans, and `supported_parameters` are conservative guarantees for model-only routing: numeric limits use the lowest value, lists use the intersection, and booleans are `true` only when every offer explicitly reports support. If any offer omits a field, that model-level field is omitted rather than treating unknown as unsupported. `capability_coverage` reports how many offers supplied each field, while `supported_protocols` is the union of protocols available across sellers. The full per-peer capabilities remain authoritative when selecting a particular seller.

If one peer advertises multiple service ids that normalize to the same model, AntSeed keeps a single offer for that peer: the lowest-priced alias. Text offers compare `inputUsdPerMillion + outputUsdPerMillion`; image offers compare `minImageUsdPerImage`; an explicitly known price beats an unknown price. All observed names remain in the model's `aliases`, and model-only routing rewrites requests to the retained seller service id.

Cached-input pricing is treated as model-specific metadata completeness. If at least one offer for a model advertises `cachedInputUsdPerMillion`, an offer that omits it receives a 50% reduction to its effective reputation for that model because its real cost can be materially higher for cache-heavy workloads. This remains a soft penalty: an exceptionally stronger peer can still outrank a weaker peer with complete cached pricing. If no offer for the model advertises cached-input pricing, AntSeed assumes the model may not support caching and applies no penalty. `reputationScore` remains the raw trust/reputation value, while `effectiveReputationScore` shows the normalized model-specific score used for ordering and model-only routing.

The desktop's **Auto** route stores the selected model without a peer id. Telegram model selections, automatic in-app chats, and connected apps configured with the `antseed` model alias therefore use the same live reputation ranking, cooldown avoidance, and peer fallback on each request. Explicitly choosing a seller in the desktop stores `<peerId>@<serviceId>` instead and intentionally keeps that route single-peer.

## Supported API Formats

The proxy accepts these API formats. Use whichever matches your tool:

| Endpoint | Format | Compatible Tools |
|---|---|---|
| `/v1/messages` | Anthropic Messages API | Claude Code, Anthropic SDKs |
| `/v1/chat/completions` | OpenAI Chat Completions | Any OpenAI-compatible client |
| `/v1/responses` | OpenAI Responses API | Codex |
| `/v1/images/generations` | OpenAI Images generation | OpenAI-compatible image clients |
| `/v1/images/edits` | OpenAI Images edits | OpenAI-compatible multipart image clients |
| `/v1/models` | OpenAI model list | network-wide, answered locally; `?type=images` filters (free) |
| `/v1/messages/count_tokens` | Anthropic token counting | answered locally, never routed or billed |

The `model` field in your request determines which service to route to, and optionally which peer (`<peerId>@<model>`).

**Your tool's wire format does not need to match the seller's.** If the pinned peer serves the model natively in your tool's format, the request passes through untouched. Otherwise `@antseed/api-adapter` translates on the fly — Anthropic ↔ OpenAI Chat ↔ OpenAI Responses in any direction — so Claude Code can talk to an OpenAI-only seller and Codex to an Anthropic-style one. Limitations to know: image endpoints are never translated (the peer must advertise `openai-images`), reasoning traces do not survive translation, and services behind `openai-responses` require streaming (the adapter handles this transparently, re-assembling a non-streaming response when your tool asked for one).

### Images

Image services advertise the `openai-images` protocol and may publish per-output pricing. Buyers validate the seller's announced unit-billing model before authorizing payment. Image requests are not included in periodic model health probes because a meaningful probe would create a billable upstream image.

```bash
curl http://localhost:8377/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{
    "model": "<peerId>@flux.1-schnell",
    "prompt": "A tiny ant carrying a seed",
    "n": 1,
    "size": "1024x1024"
  }'

# With a session pin the bare "flux.1-schnell" works too.
# For /v1/images/edits (multipart body, no JSON model rewrite),
# pin via header instead:
#   -H 'x-antseed-pin-peer: <peerId>'
```

## Claude Code

**Recommended:** launch Claude Code from the VPR's **Apps** view — it detects the installed tool, wires it to the proxy, and handles peer and model routing automatically.

CLI alternative — the `antseed claude` wrapper resolves the running buyer proxy, sets `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_API_KEY` for the child process, and forwards the rest of your flags to Claude Code:

```bash
antseed claude --model kimi-k2.6

# Route to a specific peer for the session:
antseed claude --model <peerId>@kimi-k2.6
```

Manual equivalent:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8377
export ANTHROPIC_API_KEY=antseed   # any non-empty placeholder
claude --model kimi-k2.6           # or <peerId>@kimi-k2.6
```

Claude Code sends requests to `/v1/messages`; the proxy routes them to the pinned peer, translating to the seller's native format when needed.

## Codex

**Recommended:** launch Codex from the VPR's **Apps** view, which supplies the provider config and routing for you.

CLI alternative — recent Codex versions (0.40+) ignore `OPENAI_BASE_URL` and `OPENAI_API_KEY`, so use the wrapper for automatic per-run config:

```bash
antseed codex --model deepseek-v4-flash

# Route to a specific peer:
antseed codex --model <peerId>@deepseek-v4-flash
```

Or create `~/.codex/antseed.config.toml` and launch with `codex --profile antseed` for a persistent manual setup. See the [Codex integration page](/integrations/codex) for the tested profile file, routing-verification check, and known gotchas (project-local configs, `-c` flag pitfalls).

## OpenCode

**Recommended:** launch OpenCode from the VPR's **Apps** view. CLI alternative:

```bash
antseed opencode --model gpt-oss-120b

# Route to a specific peer:
antseed opencode --model <peerId>@gpt-oss-120b
```

The wrapper writes a temporary OpenCode provider config pointing at the proxy and removes it when the session ends. See the [OpenCode integration page](/integrations/opencode) for manual config.

## curl

The model field is `"<peerId>@<model>"` — the peer id picks who serves the request, the model picks the service:

```bash
# Anthropic format
curl http://localhost:8377/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "<peerId>@kimi-k2.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI format
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "<peerId>@deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# With a session pin (antseed buyer connection set --peer <peerId>),
# the bare service id is enough:
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## How Routing Works

When you send a request:

1. The proxy resolves an explicit peer pin when present (header > `<peerId>@<model>` prefix > session pin).
2. Without a pin, it canonicalizes the requested model, finds compatible peer offers, applies buyer pricing/reputation policy, and selects the highest-reputation remaining peer.
3. The request model is rewritten to the selected peer's actual advertised `serviceId`, so aliases such as `claude-opus-5`, `opus-5`, and `opus5` route correctly.
4. If the seller's native protocol differs from your tool's, the request is translated by the api-adapter.
5. The request is forwarded to that peer over an encrypted peer-to-peer connection and the response streams back through the proxy.

Explicitly pinned requests never fail over to a different peer. Model-only requests use the peer-health system from PR #750: peers in an active cooldown are skipped when another offer is ready, and peer-attributed retryable failures advance to the next reputation-ranked offer. Buyer-local failures, client cancellation, non-retryable responses, and responses whose streaming headers already started never fail over.

## Response Headers: Cost and Attribution

Every non-streaming response carries telemetry headers so you can see exactly who served the request and what it cost:

```
x-antseed-peer-id: <peerId>
x-antseed-service: deepseek-v4-flash
x-antseed-input-tokens: 14
x-antseed-output-tokens: 78
x-antseed-estimated-cost-usd: 0.000306
x-antseed-latency-ms: 912
x-antseed-peer-reputation: 87
```

Streaming responses carry only the request id and peer identity headers (token counts aren't known when headers are flushed) — use `antseed buyer metering` for authoritative per-channel token and USDC totals.

## Errors You Might See

| Status | Code / message | Meaning | Fix |
|---|---|---|---|
| 400 | `missing_routing_target` | Request has neither a model nor an explicit peer pin | Set `model`, or pin a peer |
| 502 | `model_not_found` | No policy-allowed peer currently advertises the requested model or alias | Check `curl localhost:8377/v1/models`; adjust policy or choose another model |
| 402 | `insufficient_deposits` | No (or too little) USDC deposited | `antseed payments`, deposit; response includes `suggestedAmount` |
| 402 | `channel_exhausted` | Per-channel budget spent | Deposit more or re-open the channel |
| 413 | `upload_body_too_large` | Request exceeds the seller's upload limit | Response includes the seller's `maxUploadBodyBytes`; trim context or pick another peer |
| 502 | `Pinned peer … is not reachable` | Peer offline or not announcing | `antseed network browse` for alternatives |
| 502 | `Pinned peer … is outside your buyer routing policy` | Peer's price exceeds your `maxPricing` caps or reputation below `minPeerReputation` | Raise caps in buyer config, or pick a cheaper peer |
| 499 | `Request cancelled` | Your client aborted mid-request | Nothing — the upstream request is aborted too |

## Health and Diagnostics

The proxy serves a local control plane under `/_antseed/*` (used by the desktop app; handy for scripts):

```bash
curl -s http://localhost:8377/_antseed/status    # DHT node count, peer count, uptime
curl -s http://localhost:8377/_antseed/peers     # cached peer list with pricing + reputation
curl -s -X POST http://localhost:8377/_antseed/peers/refresh   # force re-discovery
curl -s http://localhost:8377/_antseed/channels  # your open payment channels
```

## Buyer state isolation

Buyer runtime state is stored in the CLI data directory. By default this is `~/.antseed`, where the proxy writes `buyer.state.json`, SQLite databases, payment-channel files, and the fallback `identity.key`.

For multiple buyer nodes, service integrations, isolated tests, or concurrent processes, give each buyer its own data directory:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"

ANTSEED_DATA_DIR="$BUYDIR" \
antseed --data-dir "$BUYDIR" buyer start \
  --peer <peer-id> \
  --port 8380
```

Use `--data-dir <path>` in service/systemd scripts because it is explicit. `ANTSEED_DATA_DIR=<path>` is useful for wrappers and local scripts. Do not reuse the same buyer data directory across concurrent processes.

If the buyer proxy starts but appears to use stale pins, waits on broad discovery, times out before payment negotiation, or shows sessions/channels in an unexpected place, check the startup log for the resolved data directory and `buyer.state.json` path. `ANTSEED_HOME` is not the CLI state-isolation setting; use `--data-dir` or `ANTSEED_DATA_DIR`.

Extra buyer config is optional. Add it only for advanced customization such as pricing caps, reputation thresholds, bootstrap nodes, or chain settings:

```json
{
  "buyer": {
    "minPeerReputation": 0,
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

## No API Key Needed

The proxy does not require an API key. Authentication and payments are handled by the protocol using your node's identity key and on-chain USDC deposits. Tools that require an API key (like Codex) can use any placeholder value.

## Monitor Buyer Usage

Expose buyer metrics with:

```bash
antseed metrics serve --role buyer
```

See [Metrics](/docs/guides/metrics) for buyer spend, channel, request, token, and per-peer metrics. For a quick per-peer view without metrics infrastructure, `antseed buyer metering` prints token and USDC totals per channel.

## Agent Skills

If you're using Pi, Codex or another agent, these skills can walk you through the full setup:

- [`antseed/antseed-pi`](https://github.com/AntSeed/pi-antseed) — Use the AntSeed local buyer proxy as a model provider in pi.
- [`@skills/join-buyer`](https://github.com/AntSeed/antseed/tree/main/skills/join-buyer) — step-by-step buyer setup for Claude Code agents
- [`@skills/antseed-images`](https://github.com/AntSeed/antseed/tree/main/skills/antseed-images) — generate images through an exact AntSeed seller and image service
- [`@skills/openclaw-antseed`](https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed) — connect OpenClaw to AntSeed as a buyer
