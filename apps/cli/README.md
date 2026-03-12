# Antseed CLI + Dashboard

Command-line interface and web dashboard for the AntSeed Network — a P2P network for AI services.

> **Important:** AntSeed is designed for providers who build differentiated services on top of AI APIs — such as TEE-secured inference, domain-specific skills and agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for testing and development only.

## Commands

| Command | Description |
|---------|-------------|
| `antseed init` | Install trusted provider and router plugins |
| `antseed seed` | Start providing AI services on the P2P network |
| `antseed connect` | Start the buyer proxy and connect to sellers |
| `antseed connection get` | Show current session state (pinned model, peer) |
| `antseed connection set` | Update model/peer overrides on a running proxy |
| `antseed connection clear` | Clear model/peer overrides on a running proxy |
| `antseed plugin add <pkg>` | Install a provider or router plugin from npm |
| `antseed plugin remove <name>` | Remove an installed plugin |
| `antseed plugin list` | List installed plugins |
| `antseed status` | Show current node status |
| `antseed config` | Manage configuration (`show`, `set`, `seller show/set`, `buyer show/set`, `init`) |
| `antseed dashboard` | Start the web dashboard for monitoring and configuration |
| `antseed dev` | Run seller + buyer locally for development and testing |
| `antseed browse` | Browse available models, prices, and reputation on the network |

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

Pricing is configured in USD per 1M tokens with role-specific defaults and optional provider/model overrides. You can also set node `displayName` and optional per-service category tags announced in discovery metadata:

```json
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "pricing": {
      "defaults": {
        "inputUsdPerMillion": 10,
        "outputUsdPerMillion": 10
      },
      "providers": {
        "anthropic": {
          "models": {
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
    "preferredProviders": ["anthropic", "openai"],
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 100,
        "outputUsdPerMillion": 100
      }
    }
  }
}
```

Model categories are normalized to lowercase tags. Recommended tags include: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are also allowed).

### Seller Middleware

Providers can inject Markdown files into every LLM request using `seller.middleware`. This is the primary mechanism for adding system prompts, skill instructions, persona definitions, and output-format rules — buyers only see the LLM's natural response, never the injected content.

```json
{
  "seller": {
    "middleware": [
      { "file": "./skills/coding-expert.md", "position": "system-prepend" },
      { "file": "./skills/output-format.md",  "position": "system-append" },
      { "file": "./skills/reminder.md",       "position": "append", "role": "user" }
    ]
  }
}
```

**`file`** — path to a `.md` file, relative to the config file directory (or absolute).

**`position`** — where to inject the content:

| position | effect |
|---|---|
| `system-prepend` | Prepend to the Anthropic `system` field; or insert a system-role message at the top of OpenAI messages |
| `system-append`  | Append to the `system` field; or insert after the last system message in OpenAI messages |
| `prepend`        | Insert as the first message in the `messages` array |
| `append`         | Insert as the last message in the `messages` array |

**`role`** — only used for `prepend`/`append` positions; defaults to `'user'`.

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

# Buyer preferences and max pricing
antseed config buyer set preferredProviders '["anthropic","openai"]'
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

Runtime-only overrides (do not write your config file):

```bash
antseed seed --provider anthropic --input-usd-per-million 10 --output-usd-per-million 30
antseed connect --router local --max-input-usd-per-million 20 --max-output-usd-per-million 60
```

### Session overrides (live, while proxy is running)

After `antseed connect` is running, you can override the model or peer for all subsequent requests without restarting:

```bash
# Pin all requests to a specific model (overrides whatever the tool sends)
antseed connection set --model claude-opus-4-6

# Pin all requests to a specific peer (bypasses router for peer selection)
antseed connection set --peer <64-char-hex-peer-id>

# Combine both in one command
antseed connection set --model claude-sonnet-4-6 --peer <peer-id>

# Check current session state
antseed connection get

# Clear individual overrides
antseed connection clear --model
antseed connection clear --peer

# Clear all overrides at once
antseed connection clear
```

Session overrides are stored in `~/.antseed/buyer.state.json` and picked up by the running proxy immediately via file-watching. The desktop app reads and writes the same file to expose model/peer selection in its UI.

The model override rewrites the `model` field in the request body **before routing**, so peer selection, pricing, and the forwarded request all reflect the overridden model — regardless of what the tool (e.g. Claude Code) originally requested.

## Settlement Runtime (Seeder)

`antseed seed` can enable automatic session settlement when payment config is present.
`antseed connect` can also enable buyer-side escrow/session locking with the same payment config.

Common runtime env controls:
- `ANTSEED_ENABLE_SETTLEMENT=true|false`
- `ANTSEED_SETTLEMENT_IDLE_MS=30000`
- `ANTSEED_DEFAULT_ESCROW_USDC=1`
- `ANTSEED_AUTO_FUND_ESCROW=true|false`
- `ANTSEED_SELLER_WALLET_ADDRESS=0x...`

Crypto settlement also requires `config.payments.crypto` values in your config file:
- `chainId` (`base` or `arbitrum`)
- `rpcUrl`
- `escrowContractAddress`
- `usdcContractAddress`

If `ANTSEED_ENABLE_SETTLEMENT` is not explicitly set and the RPC endpoint is unreachable,
the CLI now auto-disables settlement for that run and logs a warning instead of looping RPC network-detection errors.
Set `ANTSEED_ENABLE_SETTLEMENT=true` to force-enable settlement checks.

Runtime behavior:
- session opens -> optional escrow deposit
- session finalizes -> exact on-chain split settlement (`seller payout + platform fee + buyer refund remainder`)
- no receipts -> escrow refund path

Provider-specific options are configured via each plugin's config schema (see `antseed plugin add --help`).

## Development

```bash
npm install
npm run build
npm run dev
```

## Links

- Node SDK: `@antseed/node` (`../node`)
