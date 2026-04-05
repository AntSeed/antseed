# Antseed CLI + Dashboard

Command-line interface and web dashboard for the AntSeed Network — a P2P network for AI services.

> **Important:** AntSeed is designed for providers who build differentiated services on top of AI APIs — such as TEE-secured inference, domain-specific skills and agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for testing and development only.

## Commands

| Command | Description |
|---------|-------------|
| **Setup** | |
| `antseed init` | Install trusted provider and router plugins |
| `antseed setup --role <role>` | Check readiness for provider or buyer role |
| `antseed register` | Register peer identity on-chain (ERC-8004) |
| **Providing** | |
| `antseed seed --provider <name>` | Start providing AI services on the P2P network |
| `antseed stake <amount>` | Stake USDC as a provider (min $10) |
| `antseed unstake` | Withdraw staked USDC |
| `antseed claim` | Claim accumulated seller payouts |
| **Buying** | |
| `antseed connect --router <name>` | Start the buyer proxy and connect to sellers |
| `antseed deposit <amount>` | Deposit USDC for payments |
| `antseed withdraw <amount>` | Withdraw USDC from deposits |
| `antseed balance` | Check wallet and deposit balance |
| `antseed browse` | Browse available services and pricing |
| `antseed payments` | Launch the payments portal |
| **Session** | |
| `antseed connection get` | Show current session state (pinned service, peer) |
| `antseed connection set` | Update service/peer overrides on a running proxy |
| `antseed connection clear` | Clear service/peer overrides |
| **Management** | |
| `antseed status` | Show current node status |
| `antseed config` | Manage configuration |
| `antseed plugin add/remove/list` | Manage plugins |
| `antseed dashboard` | Start the web dashboard |
| `antseed channels` | List payment channels |
| `antseed emissions` | View ANTS emissions and epoch info |
| `antseed dev` | Run seller + buyer locally for testing |
| `antseed bootstrap` | Run a dedicated DHT bootstrap node |

## Plugins

Antseed uses an open plugin ecosystem. Plugins are installed into `~/.antseed/plugins/` via npm.

**Providers** connect your node to an upstream AI API (seeder mode):

```bash
antseed plugin add @antseed/provider-anthropic    # API key auth
antseed plugin add @antseed/provider-claude-code   # Claude Code keychain auth
antseed seed --provider anthropic
```

**Routers** select peers and proxy requests (consumer mode):

```bash
antseed plugin add @antseed/router-local
antseed connect --router local
```

Run `antseed init` to install all trusted plugins interactively.

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

Initialize a new config:

```bash
antseed config init
```

Pricing is configured in USD per 1M tokens with role-specific defaults and optional provider/service overrides. You can also set node `displayName`, an optional seller `publicAddress`, and per-service category tags announced in discovery metadata:

```json
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "publicAddress": "peer.example.com:6882",
    "pricing": {
      "defaults": {
        "inputUsdPerMillion": 10,
        "outputUsdPerMillion": 10
      },
      "providers": {
        "anthropic": {
          "services": {
            "claude-sonnet-4-5-20250929": {
              "inputUsdPerMillion": 12,
              "outputUsdPerMillion": 18
            }
          }
        }
      }
    },
    "serviceCategories": {
      "anthropic": {
        "claude-sonnet-4-5-20250929": ["coding", "privacy"]
      }
    }
  },
  "buyer": {
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 100,
        "outputUsdPerMillion": 100
      }
    }
  }
}
```

Service categories are normalized to lowercase tags. Recommended tags include: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are also allowed).

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

# Seller defaults
antseed config seller set pricing.defaults.inputUsdPerMillion 12
antseed config seller set pricing.defaults.outputUsdPerMillion 36

# Seller per-service override for a provider
antseed config seller set pricing.providers.anthropic.services '{"claude-sonnet-4-5-20250929":{"inputUsdPerMillion":14,"outputUsdPerMillion":42}}'

# Seller per-service category tags announced in metadata
antseed config seller set serviceCategories.anthropic.claude-sonnet-4-5-20250929 '["coding","legal"]'

# Seller public address override for load-balanced deployments
antseed config seller set publicAddress "peer.example.com:6882"

# Buyer max pricing
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

Runtime-only overrides (do not write your config file):

```bash
antseed seed --provider anthropic --input-usd-per-million 10 --output-usd-per-million 30
antseed connect --router local --max-input-usd-per-million 20 --max-output-usd-per-million 60
```

### Session overrides (live, while proxy is running)

After `antseed connect` is running, you can override the service or peer for all subsequent requests without restarting:

```bash
# Pin all requests to a specific service (overrides whatever the tool sends)
antseed connection set --service claude-opus-4-6

# Pin all requests to a specific peer (bypasses router for peer selection)
antseed connection set --peer <40-char-hex-peer-id>

# Combine both in one command
antseed connection set --service claude-sonnet-4-6 --peer <peer-id>

# Check current session state
antseed connection get

# Clear individual overrides
antseed connection clear --service
antseed connection clear --peer

# Clear all overrides at once
antseed connection clear
```

Session overrides are stored in `~/.antseed/buyer.state.json` and picked up by the running proxy immediately via file-watching. The desktop app reads and writes the same file to expose service/peer selection in its UI.

The service override rewrites the `model` field in the request body **before routing**, so peer selection, pricing, and the forwarded request all reflect the overridden service — regardless of what the tool (e.g. Claude Code) originally requested.

## Payments

Payment channels are automatic when `payments.crypto.chainId` is set in config. Set it to `base-mainnet` for production or `base-sepolia` for testing. Contract addresses are resolved automatically from the chain ID.

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

The node's identity key (`~/.antseed/identity.key`) doubles as the EVM wallet. Providers must register on-chain (`antseed register`) and stake USDC (`antseed stake 10`) before seeding. Buyers must deposit USDC (`antseed deposit 10`) before connecting.

Runtime env controls:
- `ANTSEED_SETTLEMENT_IDLE_MS=600000` — idle time before settling a session (default: 10 minutes)
- `ANTSEED_DEFAULT_DEPOSIT_USDC=1` — default lock amount per session
- `ANTSEED_IDENTITY_HEX=<hex>` — inject identity via env (supports 0x prefix)

Provider-specific options are configured via each plugin's config schema (see `antseed plugin add --help`).

## Development

```bash
npm install
npm run build
npm run dev
```

## Links

- Node SDK: `@antseed/node` (`../node`)
