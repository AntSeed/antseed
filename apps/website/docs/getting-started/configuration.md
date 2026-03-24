---
sidebar_position: 3
slug: /config
title: Configuration
hide_title: true
---

# Configuration

After installation, initialize your node. This generates an Ed25519 identity keypair stored at `~/.antseed/identity.key` and creates default configuration.

```bash title="init"
$ antseed init
Generated node identity (Ed25519)
Created ~/.antseed/identity.key
Installed official plugins
Ready to connect
```

## Identity

Your node identity is an Ed25519 keypair. Your PeerId is the hex-encoded 32-byte public key (64 lowercase hex characters). Set `identity.displayName` in config to control the human-readable name announced in peer metadata.

:::warning Single Key, Two Roles
Your identity key is used for **both** P2P operations (signing metadata, connection handshakes, metering receipts) **and** on-chain payments. An EVM wallet (secp256k1) is deterministically derived from your Ed25519 seed — this is the wallet that holds escrow deposits, receives seller earnings, and signs payment authorizations. Losing your identity key means losing access to your on-chain funds.
:::

### Storage

Identity loading follows this priority:

| Priority | Method | How | Best for |
|---|---|---|---|
| 1 | **Environment variable** | Set `ANTSEED_IDENTITY_HEX` to 64 hex chars | Server deployments with secrets managers (AWS SSM, Vault) |
| 2 | **Custom store** | Pass an `IdentityStore` via `NodeConfig.identityStore` | Custom integrations (KMS, HSM, Desktop safeStorage) |
| 3 | **Plaintext file** ⚠️ | `~/.antseed/identity.key` with `0600` permissions | **Not recommended** — use env var or custom store instead |

The env var always takes precedence, regardless of other configuration. If no env var is set, `identityStore` is used if provided, otherwise the default `FileIdentityStore` reads from disk.

### Environment Variable (Recommended for Servers)

Pass the private key from a secrets manager so it never touches disk:

```bash
# From HashiCorp Vault
export ANTSEED_IDENTITY_HEX="$(vault kv get -field=key secret/antseed/identity)"
antseed seed --provider anthropic

# From AWS SSM Parameter Store
export ANTSEED_IDENTITY_HEX="$(aws ssm get-parameter --name /antseed/identity --with-decryption --query Parameter.Value --output text)"
antseed seed --provider anthropic
```

The variable is cleared from the process environment immediately after the node reads it.

### Desktop App

AntSeed Desktop encrypts the identity at rest using the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret). On first launch, any existing plaintext `identity.key` is migrated to the encrypted store (`identity.enc`) and the plaintext file is deleted.

### Plaintext File (Default CLI — Not Recommended)

:::danger Unsafe for production
The plaintext file stores your private key unencrypted on disk. Since this key also controls your on-chain wallet, any process running as your user can read it and access your funds. Use `ANTSEED_IDENTITY_HEX` with a secrets manager or the Desktop app's encrypted storage instead.
:::

Generated automatically on first run. The private key seed is stored as 64 hex characters in `~/.antseed/identity.key` with `0600` permissions.

:::tip Key Backup
Back up your identity key before migrating servers. Your PeerId (and derived EVM wallet address) are tied to this key — losing it means a new identity on the network.
:::

## Selling AI Services

To sell on the network, configure a provider plugin and declare your Skills. The provider handles the actual AI service — the protocol handles discovery, metering, and payments.

:::warning Provider Compliance
AntSeed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills, agent workflows, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`claude-code`, `claude-oauth`) are for local testing only.
:::

```bash title="seed"
$ antseed seed --provider anthropic
Announcing on DHT: antseed:anthropic
Metadata server listening on 0.0.0.0:6882
Seeding capacity...
```

You can also use `--instance <id>` to use a configured plugin instance, or override pricing at runtime with `--input-usd-per-million` and `--output-usd-per-million`.

## Buying AI Services

```bash title="connect"
$ antseed connect --router local
Router "Local Router" loaded
Connected to P2P network
Proxy listening on http://localhost:8377
```

The buyer proxy listens on `localhost:8377` by default. Your existing tools (Claude Code, Codex, etc.) point to this proxy instead of the upstream API. The router handles peer selection and failover transparently.

## Configuration File

Configuration is stored at `~/.antseed/config.json`. Key sections:

| Section | Description |
|---|---|
| `identity` | Display name and wallet address |
| `providers` | Configured provider API keys and endpoints |
| `seller` | Reserve floor, max concurrent buyers, pricing, enabled providers, model category tags |
| `buyer` | Preferred providers, max pricing, min peer reputation, proxy port |
| `payments` | Payment method, escrow chain config (chainId, rpcUrl, contract addresses) |
| `network` | Bootstrap nodes |
| `plugins` | Installed plugin packages |

## Metadata Fields

Use config to control metadata advertised to buyers:

```json title="config example"
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "serviceCategories": {
      "anthropic": {
        "claude-sonnet-4-5-20250929": ["coding", "privacy"]
      }
    }
  }
}
```

- `identity.displayName`: optional node label shown in browse/discovery results.
- `seller.serviceCategories`: optional provider/model -> tag array map announced in peer metadata.
- Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are allowed).

```bash title="set metadata fields"
antseed config set identity.displayName "Acme Inference - us-east-1"
antseed config seller set serviceCategories.anthropic.claude-sonnet-4-5-20250929 '["coding","privacy"]'
```

## Bound Agent

Providers can wrap their service with a bound agent — a knowledge-augmented AI service that injects a persona, guardrails, and on-demand knowledge into buyer requests. The LLM decides which knowledge to load via the `antseed_load_knowledge` tool. Creators can also define custom tools in the manifest.

```json title="config example"
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest that defines the persona, guardrails, knowledge modules, and custom tools. See the [`@antseed/bound-agent` README](https://github.com/AntSeed/antseed/tree/main/packages/bound-agent) for the full manifest reference.

Per-service agents (different agents for different services):

```json title="per-service config"
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

## Authentication

Provider plugins authenticate with their upstream AI service. Credentials are stored locally and never leave the seller's machine. Authentication methods depend on the provider plugin:

| Provider | Auth Method |
|---|---|
| `anthropic` | API key via ANTHROPIC_API_KEY env var |
| `claude-code` | OAuth tokens from Claude Code keychain (automatic) — **testing only** |
| `claude-oauth` | OAuth access/refresh token pair — **testing only** |
| `openai` | API key via OPENAI_API_KEY env var (optional OPENAI_BASE_URL for OpenAI-compatible APIs) |
| `local-llm` | No auth needed (local Ollama/llama.cpp) |

## OpenAI-Compatible Model Aliases

When using the `openai` provider plugin, you can announce buyer-facing service names while forwarding different upstream service IDs.

Useful env vars:

- `ANTSEED_ALLOWED_SERVICES`: announced service list (what buyers request)
- `OPENAI_UPSTREAM_SERVICE_PREFIX`: prefix added before forwarding upstream
- `OPENAI_SERVICE_ALIAS_MAP_JSON`: explicit announcedService -> upstreamService map

Example: announce `kimi2.5`, forward to Together as `together/kimi2.5`:

```bash
export ANTSEED_ALLOWED_SERVICES="kimi2.5"
export OPENAI_UPSTREAM_SERVICE_PREFIX="together/"
```

Example with explicit alias map:

```bash
export ANTSEED_ALLOWED_SERVICES="kimi2.5,deepseek-v3"
export OPENAI_SERVICE_ALIAS_MAP_JSON='{"kimi2.5":"together/kimi2.5","deepseek-v3":"openrouter/deepseek/deepseek-chat"}'
```
