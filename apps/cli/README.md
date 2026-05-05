# Antseed CLI + Dashboard

Command-line interface and web dashboard for the AntSeed Network — a P2P network for AI services.

> **Important:** AntSeed is designed for providers who build differentiated services on top of AI APIs — such as TEE-secured inference, domain-specific skills and agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for testing and development only.

## Commands

| Command | Description |
|---------|-------------|
| **Setup** | |
| `antseed seller setup` | Interactive seller onboarding |
| **Providing** | |
| `antseed seller start` | Start providing AI services on the P2P network |
| `antseed seller register` | Register peer identity on-chain (ERC-8004) |
| `antseed seller stake <amount>` | Stake USDC as a provider (min $10) |
| `antseed seller unstake` | Withdraw staked USDC |
| `antseed seller emissions claim` | Claim accumulated seller payouts |
| **Buying** | |
| `antseed buyer start` | Start the buyer proxy and connect to sellers |
| `antseed buyer start --router <name>` | Start the buyer proxy with a non-default router |
| `antseed buyer deposit <amount>` | Deposit USDC for payments |
| `antseed buyer withdraw <amount>` | Withdraw USDC from deposits |
| `antseed buyer balance` | Check wallet and deposit balance |
| `antseed network browse` | Browse available services and pricing |
| `antseed payments` | Launch the payments portal |
| **Session** | |
| `antseed buyer connection get` | Show current session state (pinned service, peer) |
| `antseed buyer connection set` | Update service/peer overrides on a running proxy |
| `antseed buyer connection clear` | Clear service/peer overrides |
| **Management** | |
| `antseed seller status` | Show seller status |
| `antseed buyer status` | Show buyer status |
| `antseed config` | Manage configuration |
| `antseed profile` | Manage your peer profile |
| `antseed peer <peerId>` | Show a peer's profile (lightweight) |
| `antseed network peer <peerId>` | Show full peer details (providers, services, on-chain stats) |
| `antseed dashboard` | Start the web dashboard |
| `antseed metrics serve` | Serve Prometheus metrics for buyers and sellers |
| `antseed buyer channels` | List payment channels |
| `antseed seller emissions info` | View ANTS emissions and epoch info |
| `antseed dev` | Run seller + buyer locally for testing |
| `antseed network bootstrap` | Run a dedicated DHT bootstrap node |

## Configuration Workflow

The normal workflow is:

1. Create or update `~/.antseed/config.json` with `antseed seller setup` or `antseed config ...`
2. Keep non-secret settings there: providers, services, pricing, categories, `baseUrl`, ports
3. Keep secrets in environment variables: API keys and `ANTSEED_IDENTITY_HEX`
4. Start later with `antseed seller start` or `antseed buyer start`

Once your config file exists, the usual seller flow is just:

```bash
export OPENAI_API_KEY=sk-...
export ANTSEED_IDENTITY_HEX=<your-identity-key>
antseed seller start
```

`config.json` is the durable source of truth. Env vars are for secrets and one-off overrides.

## Plugins

Antseed uses an open plugin ecosystem. Provider and router plugins are installed into `~/.antseed/plugins/` via npm.

**Providers** connect your node to an upstream AI API (seeder mode):

```bash
antseed config seller add-provider anthropic --plugin anthropic
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --input 12 --output 18 --cached 6 \
  --categories coding,chat
antseed seller start
```

**Routers** select peers and proxy requests (consumer mode):

```bash
antseed buyer start
```

## Configuration

Configuration is stored at `~/.antseed/config.json` by default. Use `-c` / `--config` to specify an alternative path.

Runtime env variables are loaded via `dotenv` from `.env.local` and `.env` in the current working directory.
See `.env.example` for supported keys.

Enable debug logs with either:

```bash
antseed -v <command>
```

or:

```bash
ANTSEED_DEBUG=1 antseed <command>
```

For dashboard frontend debug logging, set:

```bash
VITE_ANTSEED_DEBUG=1
```

Pricing is configured in USD per 1M tokens with role-specific defaults and optional provider/service overrides. You can also set node `displayName`, an optional seller `publicAddress`, and per-service category tags announced in discovery metadata:

```json
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "publicAddress": "peer.example.com:6882",
    "providers": {
      "anthropic": {
        "plugin": "anthropic",
        "defaults": {
          "inputUsdPerMillion": 10,
          "outputUsdPerMillion": 10,
          "cachedInputUsdPerMillion": 5
        },
        "services": {
          "claude-sonnet-4-5-20250929": {
            "upstreamModel": "claude-sonnet-4-5-20250929",
            "categories": ["coding", "chat"],
            "pricing": {
              "inputUsdPerMillion": 12,
              "outputUsdPerMillion": 18,
              "cachedInputUsdPerMillion": 6
            }
          }
        }
      }
    }
  },
  "buyer": {
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 100,
        "cachedInputUsdPerMillion": 50,
        "outputUsdPerMillion": 100
      }
    }
  }
}
```

Service categories are normalized to lowercase tags. Recommended normie-friendly tags include: `chat`, `coding`, `math`, `study`, `creative`, `writing`, `tasks`, `fast`, `free`, `translate` (custom tags are also allowed).

The set of keys under `seller.providers.<name>.services` determines which services this peer announces on the network — there's no separate allow-list.

### Ant Agent

Providers can wrap their service with an ant agent — a read-only, knowledge-augmented AI service that injects a persona, guardrails, and on-demand loaded knowledge into buyer requests.

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest that defines the agent's persona, guardrails, and knowledge modules. Knowledge modules are loaded on demand via the `antseed_load_knowledge` tool — the LLM decides which modules to load during the conversation and only relevant knowledge is brought into context. Buyers only see the LLM's natural response, never the injected content or internal tool calls.

See the [`@antseed/ant-agent` README](../../packages/ant-agent/README.md) for the full manifest reference and directory structure.

Role-first config examples:

```bash
# Identity / metadata display name
antseed config set identity.displayName "Acme Inference - us-east-1"

# Add a provider and then a service
antseed config seller add-provider anthropic --plugin anthropic --input 12 --output 18
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --upstream "claude-sonnet-4-5-20250929" \
  --input 12 --output 18 --cached 6 \
  --categories coding,chat

# Remove a service
antseed config seller remove-service anthropic claude-sonnet-4-5-20250929

# Fine-grained edits to a service already in the config (auto-creates
# intermediate objects; --dynamic paths under seller.providers.* are allowed)
antseed config seller set providers.anthropic.defaults.inputUsdPerMillion 12
antseed config seller set providers.anthropic.services.claude-sonnet-4-5-20250929.pricing.outputUsdPerMillion 20
antseed config seller set providers.anthropic.services.claude-sonnet-4-5-20250929.categories '["coding","legal"]'

# Seller public address override for load-balanced deployments
antseed config seller set publicAddress "peer.example.com:6882"

# Buyer max pricing
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.cachedInputUsdPerMillion 12
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

Runtime-only overrides (do not write your config file):

```bash
antseed seller start --provider anthropic --input-usd-per-million 10 --cached-input-usd-per-million 5 --output-usd-per-million 30
antseed buyer start --max-input-usd-per-million 20 --max-cached-input-usd-per-million 10 --max-output-usd-per-million 60
```

### Session overrides (live, while proxy is running)

After `antseed buyer start` is running, you can override the service or peer for all subsequent requests without restarting:

```bash
# Pin all requests to a specific service (overrides whatever the tool sends)
antseed buyer connection set --service claude-opus-4-6

# Pin all requests to a specific peer (bypasses router for peer selection)
antseed buyer connection set --peer <40-char-hex-peer-id>

# Combine both in one command
antseed buyer connection set --service claude-sonnet-4-6 --peer <peer-id>

# Check current session state
antseed buyer connection get

# Clear individual overrides
antseed buyer connection clear --service
antseed buyer connection clear --peer

# Clear all overrides at once
antseed buyer connection clear
```

Session overrides are stored in `~/.antseed/buyer.state.json` and picked up by the running proxy immediately via file-watching. The desktop app reads and writes the same file to expose service/peer selection in its UI.

The service override rewrites the `model` field in the request body **before routing**, so peer selection, pricing, and the forwarded request all reflect the overridden service — regardless of what the tool (e.g. Claude Code) originally requested.

## Payments

Payments run on **Base Mainnet** by default. Contract addresses are resolved automatically — no manual configuration needed.

### Provider Setup (Selling)

```bash
# 1. Set your identity (secp256k1 private key)
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 2. Fund your wallet with ETH (for gas) and USDC (for staking) on Base Mainnet

# 3. Register your identity on-chain
antseed seller register

# 4. Stake USDC (minimum $10)
antseed seller stake 10

# 6. Start providing
antseed seller start
```

### Buyer Setup (Consuming)

```bash
# 1. Set your identity (secp256k1 private key)
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 2. Launch the payments portal to deposit USDC
antseed payments
# Payments portal running at http://127.0.0.1:3118

# 3. In the portal, connect a funded wallet (e.g. MetaMask) and deposit USDC
#    for your node. The contract's deposit(buyer, amount) pulls USDC from the
#    connected wallet and credits your node — the identity key never holds funds.

# 4. Connect to the network
antseed buyer start
# Proxy listening on http://localhost:8377
```

Point your AI tools (Claude Code, Codex, etc.) at `http://localhost:8377` as the API base URL. The router handles peer selection and failover transparently.

### Payments Portal

The payments portal is a local web UI for depositing USDC and viewing payment activity. Run `antseed payments` to start it at `http://localhost:3118`. Connect any funded wallet (MetaMask, Coinbase Wallet, etc.) — the contract's `deposit(buyer, amount)` pulls USDC from your connected wallet and credits your node's address. Your node's identity key never needs to hold USDC or ETH.

### Configuration

```json
{
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

Use `base-sepolia` for testing with MockUSDC.

### Runtime Controls

- `ANTSEED_SETTLEMENT_IDLE_MS=600000` — idle time before settling a session (default: 10 minutes)
- `ANTSEED_DEFAULT_DEPOSIT_USDC=1` — default lock amount per session
- `ANTSEED_IDENTITY_HEX=<hex>` — inject identity via env (supports 0x prefix)

Provider-specific options are configured via each plugin's config schema (see `antseed plugin add --help`).

## Metrics

Expose a Prometheus-compatible endpoint for a buyer or seller:

```bash
antseed --config ~/.antseed/config.json --data-dir ~/.antseed \
  metrics serve --role seller --host 0.0.0.0 --port 9108 --instance my-peer
```

Endpoints:

```text
/metrics
/healthz
/readyz
```

See [Metrics](../../apps/website/docs/guides/metrics.md) for metric names, labels, and operational notes.

## Development

```bash
npm install
npm run build
npm run dev
```

## Links

- Node SDK: `@antseed/node` (`../node`)
