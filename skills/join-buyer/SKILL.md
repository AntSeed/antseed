# Join AntSeed as a Buyer (Client)

Help the user set up an AntSeed buyer node to consume AI services from the peer-to-peer network. Walk them through installation, funding, and connecting their existing tools (Aider, Continue.dev, Cursor, or any OpenAI-compatible client) through the local proxy.

## Overview

A **buyer** (client) routes AI requests through the AntSeed network instead of directly to an API provider. A local HTTP proxy intercepts requests and forwards them to the best available peer. The buyer pays per-token in USDC via on-chain payment channels. From the tool's perspective, it's just hitting a different base URL.

**Requirements:**
- Node.js 20+
- An EVM wallet funded with USDC (for payments) and ETH (for gas) on Base

## Step 1: Install the CLI

```bash
npm install -g @antseed/cli
```

Verify with `antseed --version`.

## Step 2: Decide whether you need custom config

You do **not** need a pre-existing `~/.antseed/config.json` to start as a buyer. `antseed buyer start` works with built-in defaults:

- router: `local`
- proxy port: `8377`
- buyer pricing caps from the CLI defaults

Only create `~/.antseed/config.json` if you want advanced customization such as max pricing, bootstrap nodes, or chain settings.

## Step 3: Set the identity

The buyer needs an EVM private key. This key is used for P2P identity, on-chain deposits, and signing payment messages.

Set it via environment variable:

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

The key can optionally include a `0x` prefix. The EVM address derived from this key becomes the buyer's Peer ID and wallet address.

For persistent setups, add it to a `.env` file. **Never commit the private key to version control.**

## Step 4: Optional config customization

If you want non-default behavior, create or edit `~/.antseed/config.json`:

```json
{
  "buyer": {
    "minPeerReputation": 50,
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 25,
        "cachedInputUsdPerMillion": 12,
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

Supported chains:
- `base-mainnet` — Base L2 (production)
- `base-sepolia` — Base Sepolia testnet (for testing)

## Step 5: Fund your account when you need payments

The buyer needs USDC deposited into the AntSeed deposits contract to pay for requests.

```bash
# Check wallet and deposit balance
antseed buyer balance

# Deposit USDC into the deposits contract
antseed buyer deposit 10
```

The balance command shows:
- **Wallet USDC** — USDC in your EVM wallet
- **Deposited** — USDC in the deposits contract (available for payments)
- **Reserved** — USDC locked in active payment channels
- **Available** — deposited minus reserved (can be used for new channels)

You can withdraw unused deposits at any time:

```bash
antseed buyer withdraw 5
```

## Step 6: Optional buyer preferences

```bash
# Max pricing (USD per 1M tokens) — reject peers charging more
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.cachedInputUsdPerMillion 12
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75

# Shared model-only Price + Trust preferences
# minTrustScore is a hard eligibility gate; the default is 60
antseed config buyer set routingPreferences.minTrustScore 60
antseed config buyer set routingPreferences.maxInputUsdPerMillion 25

```

These settings are optional. Skip them if the defaults are fine. The desktop VPR
writes the same `buyer.routingPreferences`, and a running proxy hot-reloads valid
changes from `config.json`.

Advanced: if you intentionally want a non-default proxy port:

```bash
antseed config buyer set proxyPort 8888
```

## Step 7: Verify readiness

```bash
antseed buyer status
```

Checks:
- Identity exists
- Deposits contract balance > 0
- Chain config resolved

## Step 8: Start the proxy

```bash
antseed buyer start
```

This will:
1. Join the P2P network via DHT bootstrap nodes
2. Discover available providers matching buyer preferences
3. Start a local HTTP proxy on port 8377
4. Automatically negotiate payment channels with providers

Advanced: custom port override for the current run only:

```bash
antseed buyer start -p 8888
```

If you already put `proxyPort` in `config.json`, you can still just run `antseed buyer start` with no extra flags.

## Step 9: Point your tools at the proxy

The proxy is API-compatible with the OpenAI chat completions format. Set environment variables so your tools route through AntSeed:

### Any OpenAI-compatible tool

```bash
export OPENAI_BASE_URL=http://localhost:8377
export OPENAI_API_KEY=antseed
```

### Aider

```bash
export OPENAI_BASE_URL=http://localhost:8377
export OPENAI_API_KEY=antseed
aider --model openai/kimi-k2.5
```

### Continue.dev (VS Code)

In `.continue/config.json`:

```json
{
  "models": [{
    "provider": "openai",
    "model": "deepseek-v3.1",
    "apiBase": "http://localhost:8377",
    "apiKey": "antseed"
  }]
}
```

### Cursor

Set the API base URL to `http://localhost:8377` and API key to `antseed` in Cursor's OpenAI model settings.

### Python / direct HTTP

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8377", api_key="antseed")
response = client.chat.completions.create(
    model="kimi-k2.5",
    messages=[{"role": "user", "content": "Hello"}]
)
```

The API key value doesn't matter when going through the proxy — set it to any non-empty string.

## Step 10: Discover models and route by name

Pinning a peer is optional. A request that names only a model selects the highest-ranked eligible offer under the shared Price + Trust preferences. Ranking also accounts for cached-input pricing coverage, recent failures, cooldowns, free-peer preference, and seller access rules. Peer-attributed retryable failures can advance to the next ranked offer; 429s get up to three attempts on the same peer before fallback.

List every model on the network — `GET /v1/models` is answered locally from the buyer's discovered-peer cache and covers the whole network, no pin needed:

```bash
curl -s http://localhost:8377/v1/models | jq '.data[].id'      # all models
curl -s 'http://localhost:8377/v1/models?type=images' | jq     # only image models (?type=text also works)
curl -s http://localhost:8377/v1/models/<id>                   # one model in detail
antseed network browse                                         # peers + services + pricing
```

Close aliases such as `claude-opus-5`, `opus-5`, and `opus5` are grouped into one entry with an `aliases` array and a `peers` array listing every seller serving the model in routing-preference order. Duplicate aliases from one seller collapse to its cheapest matching offer. Send a request with any returned id or alias and the proxy routes it.

For recognized conversations, a successful automatic route becomes a soft affinity: later turns prefer the seller and service that actually served the chat while they remain healthy and eligible. Automatic affinity can fail over; explicit pins cannot.

### Optional: force a specific seller

Three pin mechanisms override auto-selection (precedence: header > model prefix > session pin):

| Mechanism | Scope | How |
|---|---|---|
| Header `x-antseed-pin-peer: <peerId>` | one request | works even when the tool controls the model field |
| Model prefix `<peerId>@<service-id>` | one request | `"model": "<peerId>@deepseek-v3.1"` |
| Session pin | until changed | `antseed buyer connection set --peer <peerId>` (survives restart) |

Pinned requests never fail over to a different peer. Inspect a peer with `antseed network peer <peerId>`; clear the session pin with `antseed buyer connection clear`.

## Step 11: Monitor usage

```bash
# View payment channels and spending
antseed buyer channels

# View per-peer metering
# (available via the proxy while connected)
curl http://localhost:8377/_antseed/metering/<peer-id>

# Launch the web dashboard
antseed dashboard
```

## Payment flow (automatic)

The payment flow is fully automatic — no manual intervention needed:

1. Buyer sends a request through the proxy
2. Provider responds with `402 Payment Required`
3. Buyer signs a `ReserveAuth` (locks USDC in escrow)
4. Provider calls `reserve()` on-chain
5. For each request, buyer signs a `SpendingAuth` (cumulative amount)
6. Provider settles or closes the channel when done

All signing happens with the identity key. No additional wallets or browser extensions needed.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `antseed buyer balance` shows deposited USDC > 0
- [ ] `antseed buyer status` shows the proxy is ready
- [ ] `antseed buyer start` starts without errors
- [ ] `curl http://localhost:8377/v1/models` lists models from across the network
- [ ] Tools work with `OPENAI_BASE_URL=http://localhost:8377`

## Troubleshooting

- **"Payment setup failed"**: Check `antseed buyer balance` — you need deposited USDC. Run `antseed buyer deposit <amount>`.
- **"No peers found"**: The network may be sparse. Try `antseed network browse` to check. Add bootstrap nodes to config if needed.
- **`missing_routing_target` (400)**: The request names neither a model nor an explicit peer. Add a bare model id for automatic routing.
- **`model_not_found` (502)**: No policy-allowed peer currently advertises the requested model or alias. Check `curl localhost:8377/v1/models`; adjust buyer policy or choose another model.
- **"Lock confirmation timed out"**: The provider's on-chain reserve is slow. This is usually a testnet issue — retry the request.
- **"Connection refused on 8377"**: Make sure `antseed buyer start` is still running.
- **Tool says "invalid API key"**: Set the API key env var to any non-empty value (e.g., `antseed`).
- **Slow first request**: The first request discovers and connects to a peer via DHT (5-10s). Subsequent requests reuse the connection.
- **"existing_channel_still_active"**: A previous channel wasn't cleanly closed. Restart `antseed buyer start` to reset state.
