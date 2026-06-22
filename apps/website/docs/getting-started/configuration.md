---
sidebar_position: 3
slug: /config
title: Configuration
hide_title: true
---

# Configuration

AntSeed stores configuration at `~/.antseed/config.json`. This file is the normal source of truth for your node.

The intended workflow is:

1. Create or update `config.json` with `antseed seller setup` or `antseed config ...`
2. Keep non-secret settings there: providers, services, pricing, categories, ports, bootstrap nodes
3. Keep secrets in environment variables: API keys, identity key
4. Start your node with the grouped runtime commands

Once your config file is populated, the normal seller startup path is just:

```bash
antseed seller start
```

And the normal buyer startup path is:

```bash
antseed buyer start
```

You only need extra flags when you want to override the saved config for a specific run.

## How the Config File Gets Created

You do not need to hand-write `~/.antseed/config.json` unless you want to.

Common ways to create it:

```bash
# Interactive seller onboarding
antseed seller setup

# Add or update config entries directly
antseed config seller add-provider together --plugin openai --base-url https://api.together.ai
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.6 --cached 0.06 --output 1.7
antseed config set identity.displayName "Acme Inference"
```

`--cached` is optional. Set it (on either `add-provider --cached ...` for defaults or `add-service --cached ...` per service) when your upstream charges a reduced rate for cached-input tokens (e.g. Anthropic prompt caching, OpenAI prompt caching).

You can also edit the JSON file directly if that is easier for automation or deployment.

## Config vs Environment Variables

Use `config.json` for durable node behavior. Use env vars for secrets and temporary overrides.

| Put it in `config.json` | Put it in env vars |
|---|---|
| Provider/plugin selection | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| `baseUrl` for OpenAI-compatible providers | `ANTSEED_IDENTITY_HEX` |
| Service list and categories | `ANTSEED_DEBUG=1` |
| Pricing defaults and per-service pricing | One-off runtime overrides in deployment scripts |
| Domain/GitHub verification claims | |
| `payments.crypto.rpcUrl` for durable RPC config | `ANTSEED_BASE_RPC_URL` for deployment-specific Base RPC endpoints |
| Buyer proxy port and peer refresh interval | `ANTSEED_DATA_DIR` for per-process buyer state isolation |
| Bootstrap nodes | |

For example, this is a normal production pattern:

```json
{
  "seller": {
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "pricing": {
              "inputUsdPerMillion": 0.6,
              "cachedInputUsdPerMillion": 0.06,
              "outputUsdPerMillion": 1.7
            },
            "categories": ["chat", "coding", "math"]
          }
        }
      }
    }
  }
}
```

```bash
export OPENAI_API_KEY=<your-key>
export ANTSEED_IDENTITY_HEX=<your-identity-key>
antseed seller start
```

## Override Precedence

When the same setting exists in multiple places, AntSeed resolves it in this order:

1. CLI flags for the current command
2. Environment variables
3. `config.json`
4. Built-in defaults

So if `config.json` already contains your provider and service setup, you can still do a one-off run like:

```bash
antseed seller start --provider together --input-usd-per-million 0.7
```

That changes only the current process. It does not rewrite `config.json`.

## Data Directory vs Config File

`config.json` controls durable settings, but buyer runtime state is isolated by the data directory. The default data directory is `~/.antseed`; it contains `buyer.state.json`, SQLite databases, payment-channel files, and the fallback `identity.key`.

For each independent buyer node, service integration, isolated test, or concurrent process, use a separate data directory:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"

ANTSEED_DATA_DIR="$BUYDIR" \
antseed --data-dir "$BUYDIR" buyer start \
  --peer <peer-id> \
  --port 8380
```

Prefer `--data-dir` in service/systemd scripts. `ANTSEED_DATA_DIR` is equivalent when the flag is not supplied. If buyer behavior looks stale or files appear in an unexpected place, check the startup log for the resolved data directory and `buyer.state.json` path. Do not rely on `ANTSEED_HOME` for CLI buyer state isolation.

## Config Sections

| Section | Description |
|---|---|
| `identity` | Display name |
| `seller` | Per-provider service offerings (plugin, pricing, categories, upstream model mapping), reserve floor, max concurrent buyers, agent directory |
| `buyer` | Max pricing thresholds, proxy port, DHT peer refresh interval |
| `payments` | Chain ID (`base-mainnet` by default) |
| `network` | Bootstrap nodes |

## Seller Shape

Everything a seller announces lives under `seller.providers[name]`. The key under `providers` is a user-chosen label, and `plugin` identifies the provider plugin package that powers it. The list of services, pricing, upstream model mapping, and normie-friendly category tags lives under `seller.providers[name].services[id]`.

```json
{
  "seller": {
    "reserveFloor": 10,
    "maxConcurrentBuyers": 5,
    "providers": {
      "together": {
        "plugin": "openai",
        "baseUrl": "https://api.together.ai",
        "defaults": {
          "inputUsdPerMillion": 1,
          "outputUsdPerMillion": 2,
          "cachedInputUsdPerMillion": 0.1
        },
        "services": {
          "deepseek-v3.1": {
            "upstreamModel": "deepseek-ai/DeepSeek-V3.1",
            "categories": ["chat", "math", "coding"],
            "pricing": {
              "inputUsdPerMillion": 0.60,
              "outputUsdPerMillion": 1.70,
              "cachedInputUsdPerMillion": 0.06
            }
          },
          "qwen3.5-9b": {
            "upstreamModel": "Qwen/Qwen3.5-9B",
            "categories": ["chat", "fast", "free"],
            "pricing": { "inputUsdPerMillion": 0, "outputUsdPerMillion": 0 }
          }
        }
      }
    }
  }
}
```

Each service entry supports three optional fields:

| Field | Type | Description |
|---|---|---|
| `upstreamModel` | string | The model id the provider plugin will forward requests to. Defaults to the service id itself. |
| `categories` | string[] | Normie-friendly tags announced in peer metadata (e.g. `chat`, `coding`, `math`, `study`, `fast`, `free`). |
| `pricing` | object | Per-service pricing in USD per million tokens. If omitted, the provider's `defaults` are used. |

`baseUrl` on the provider block is forwarded to plugins that honor it (the `openai` plugin uses it as `OPENAI_BASE_URL` for Together, OpenRouter, etc.).

If you store `baseUrl` in `config.json`, you do not need to export `OPENAI_BASE_URL` separately. The CLI reads the JSON and passes it to the plugin runtime automatically.

## Adding a Provider (CLI)

Use `antseed config seller add-provider` to create a provider entry and install the matching plugin package:

```bash
# Add a provider backed by the openai plugin, pointed at Together AI
# --cached sets the default cached-input price for every service under
# this provider (overridable per service). Omit it if your upstream does
# not offer a cached-input discount.
antseed config seller add-provider together \
  --plugin openai \
  --base-url https://api.together.ai \
  --input 1 --cached 0.1 --output 2

# Add another using the same plugin for OpenRouter
antseed config seller add-provider openrouter \
  --plugin openai \
  --base-url https://openrouter.ai/api/v1

# Remove a provider
antseed config seller remove-provider openrouter
```

After adding a provider, you typically add one or more services and then start with:

```bash
export OPENAI_API_KEY=<your-key>
antseed seller start
```

## Adding a Service (CLI)

Use `antseed config seller add-service` to add a service entry in one shot:

```bash
antseed config seller add-service together deepseek-v3.1 \
  --upstream "deepseek-ai/DeepSeek-V3.1" \
  --input 0.60 --output 1.70 --cached 0.06 \
  --categories chat,math,coding \
  --base-url https://api.together.ai
```

To remove one:

```bash
antseed config seller remove-service together deepseek-v3.1
```

You can also edit individual fields directly:

```bash
antseed config seller set providers.together.services.deepseek-v3.1.pricing.inputUsdPerMillion 0.55
antseed config seller set providers.together.services.deepseek-v3.1.categories '["chat","math","coding","fast"]'
```

## Buyer Settings

Buyers can cap what they're willing to pay to avoid expensive providers:

```bash
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

The buyer proxy refreshes its discovered peer cache from the DHT in the background. The default is 5 minutes, and you can tune it in milliseconds:

```bash
antseed config buyer set peerRefreshIntervalMs 300000
```

Each discovered endpoint is then queried over HTTP for signed peer metadata. The default per-endpoint metadata fetch timeout is 1500ms; raise it for high-latency networks or lower it to make discovery skip slow/offline endpoints faster:

```bash
antseed config buyer set metadataFetchTimeoutMs 1500
```

For one process, use either the runtime flag or env var instead of writing config:

```bash
antseed buyer start --metadata-fetch-timeout-ms 1500
ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS=1500 antseed buyer start
```

Buyer SpendingAuth and free-usage metadata v2 include aggregate usage totals by default. They also include per-service attribution unless disabled. Privacy-sensitive buyers can keep aggregate accounting while suppressing service IDs and per-service totals:

```bash
antseed config buyer set disableMetadataV2Services true
antseed buyer start --disable-metadata-v2-services
ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES=true antseed buyer start
```

## Identity and Metadata

```bash
antseed config set identity.displayName "Acme Inference - us-east-1"
antseed config seller set publicAddress "peer.example.com:6882"
```

## Domain and GitHub Verification

Sellers can publish optional ownership claims in signed peer metadata. These claims let buyers and directories show that a peer is connected to a public domain or GitHub account controlled by the operator.

Verification claims bind to the seller **peer ID** — the EVM address derived from the seller identity key. If your deployment also advertises a seller contract, such as a staking proxy, the external proof still contains the peer ID, not the contract address. Buyers verify the seller-contract relationship separately on-chain.

Add claims under `seller.verifications`:

```json
{
  "seller": {
    "verifications": {
      "domains": [
        {
          "domain": "provider.example.com",
          "methods": ["dns-txt"]
        }
      ],
      "github": [
        {
          "username": "example-org",
          "repository": "antseed-verification"
        }
      ]
    }
  }
}
```

### Domain proof

For DNS TXT verification, create a TXT record at `_antseed.<domain>`:

```text
Name:  _antseed.provider.example.com
Type:  TXT
Value: antseed-peer=<peer-id-without-0x>
```

Example:

```text
antseed-peer=9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7
```

If you prefer HTTPS verification, serve this JSON at `https://<domain>/.well-known/antseed.json` and configure the claim with `"methods": ["https-well-known"]`:

```json
{
  "type": "antseed-domain-verification",
  "peerId": "9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7",
  "domain": "provider.example.com"
}
```

Do not redirect the well-known URL; verifiers require the proof to be served directly from the claimed domain.

### GitHub proof

Create a public repository and place `antseed.json` at the repository root. AntSeed fetches:

```text
https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json
```

The file must contain:

```json
{
  "type": "antseed-github-verification",
  "peerId": "9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7",
  "username": "example-org"
}
```

The `repository` field is configured in `config.json`; it is not included in the proof file. If `repository` is omitted, verifiers use the profile repository named after the username.

After updating config and publishing proofs, restart the seller. Startup logs will print the configured verification claims, and `/metadata` will include `verifications`.

## Provider Authentication

Provider plugins authenticate with their upstream AI service. Credentials live in environment variables — they never belong in `config.json`.

| Provider | Auth env var | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | |
| `openai` | `OPENAI_API_KEY` | Set `providers.<name>.baseUrl` in config.json for Together/OpenRouter/etc. |
| `claude-code` | keychain | Reads from `claude-code` secure storage |
| `local-llm` | none | Ollama/llama.cpp |

The separation is intentional:

- `config.json` says what you offer
- env vars say how to authenticate

That means you can commit deployment config templates safely while injecting secrets at runtime.

## Ant Agent

Providers can wrap their service with an ant agent — a knowledge-augmented AI service that injects a persona, guardrails, and on-demand knowledge into buyer requests.

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest defining persona, guardrails, knowledge modules, and custom tools. The LLM decides which knowledge to load during the conversation. Buyers see only the final response.

Per-service agents (different agents for different services):

```json
{
  "seller": {
    "agentDir": {
      "social-strategist": "./agents/social",
      "code-reviewer": "./agents/coding",
      "*": "./agents/default"
    }
  }
}
```

See the [`@antseed/ant-agent` README](https://github.com/AntSeed/antseed/tree/main/packages/ant-agent) for the full manifest reference.

## Identity Storage

| Priority | Method | Best for |
|---|---|---|
| 1 | `ANTSEED_IDENTITY_HEX` env var | CLI and server deployments |
| 2 | Desktop keychain (Electron `safeStorage`) | AntSeed Desktop app |
| 3 | Custom `IdentityStore` | KMS/HSM integrations |
| 4 | `~/.antseed/identity.key` (plaintext) | Not recommended for production |

For production servers, pass the key from a secrets manager:

```bash
export ANTSEED_IDENTITY_HEX="$(vault kv get -field=key secret/antseed/identity)"
```

## Base RPC URL

Sellers should configure a dedicated Base JSON-RPC endpoint for production deployments. Public defaults are fine for testing, but provider RPCs (Alchemy, Infura, QuickNode, self-hosted nodes, etc.) are more reliable for seller registration, staking, reserve, settle, and close transactions.

Use `payments.crypto.rpcUrl` for durable config:

```bash
antseed config set payments.crypto.rpcUrl "https://base-mainnet.g.alchemy.com/v2/<key>"
```

Or use runtime overrides when you do not want to edit `config.json`:

```bash
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start

# one-off process override
antseed seller start --base-rpc-url https://base-mainnet.infura.io/v3/<key>
```

Precedence is: CLI flag, then `ANTSEED_BASE_RPC_URL`, then `payments.crypto.rpcUrl`, then built-in Base defaults.

## Runtime Environment Variables

Only secrets, global toggles, and deployment-specific runtime overrides are set via env vars — everything else is in `config.json`.

| Variable | Description |
|---|---|
| `ANTSEED_IDENTITY_HEX` | Identity private key (64 hex chars, optional 0x prefix) |
| `ANTSEED_BASE_RPC_URL` | Runtime Base JSON-RPC endpoint override for seller on-chain operations |
| `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS` | Runtime buyer peer-discovery metadata fetch timeout in milliseconds |
| `ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES` | Runtime opt-out for buyer per-service metadata v2 attribution (`true` opts out) |
| `ANTHROPIC_API_KEY` | Upstream Anthropic API key (used by the `anthropic` provider plugin) |
| `OPENAI_API_KEY` | Upstream OpenAI-compatible API key (used by the `openai` provider plugin) |
| `ANTSEED_SETTLEMENT_IDLE_MS` | Idle time before settling a session (default: 600000 / 10 min) |
| `ANTSEED_DEFAULT_DEPOSIT_USDC` | Default lock amount per session (default: 1) |
| `ANTSEED_DEBUG` | Enable debug logging (set to 1) |
