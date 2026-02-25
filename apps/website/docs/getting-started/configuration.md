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

Your node identity is an Ed25519 keypair. The private key seed is stored as 64 hex characters in `~/.antseed/identity.key` with `0600` permissions. Your PeerId is the hex-encoded 32-byte public key (64 lowercase hex characters).

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
$ antseed connect --router local-proxy
Router "Local Proxy" loaded
Connected to P2P network
Proxy listening on http://localhost:8377
```

The buyer proxy listens on `localhost:8377` by default. Your existing tools (Claude Code, Aider, etc.) point to this proxy instead of the upstream API. The router handles peer selection and failover transparently.

## Configuration File

Configuration is stored at `~/.antseed/config.json`. Key sections:

| Section | Description |
|---|---|
| `identity` | Display name and wallet address |
| `providers` | Configured provider API keys and endpoints |
| `seller` | Reserve floor, max concurrent buyers, pricing, enabled providers |
| `buyer` | Preferred providers, max pricing, min peer reputation, proxy port |
| `payments` | Payment method, platform fee rate, chain config (Base) |
| `network` | Bootstrap nodes |
| `plugins` | Installed plugin packages |

## Authentication

Provider plugins authenticate with their upstream AI service. Credentials are stored locally and never leave the seller's machine. Authentication methods depend on the provider plugin:

| Provider | Auth Method |
|---|---|
| `anthropic` | API key via ANTHROPIC_API_KEY env var |
| `claude-code` | OAuth tokens from Claude Code keychain (automatic) — **testing only** |
| `claude-oauth` | OAuth access/refresh token pair — **testing only** |
| `openrouter` | API key via OPENROUTER_API_KEY env var |
| `local-llm` | No auth needed (local Ollama/llama.cpp) |
