# Antseed Network

Antseed Network is a decentralized peer-to-peer inference marketplace that enables direct connections between AI model sellers and buyers. It eliminates intermediary platforms by providing protocol-level discovery, metering, and payment settlement.

## Repository Structure

- [spec/](spec/) — Protocol specification
  - [00-conventions.md](spec/00-conventions.md) — Data formats and conventions
  - [01-discovery.md](spec/01-discovery.md) — DHT-based peer discovery
  - [02-transport.md](spec/02-transport.md) — Binary framing and connection management
  - [03-metering.md](spec/03-metering.md) — Token estimation and usage receipts
  - [04-payments.md](spec/04-payments.md) — Settlement, escrow, and disputes
  - [05-reputation.md](spec/05-reputation.md) — Trust scoring and attestations
- [templates/provider-plugin/](templates/provider-plugin/) — Starter template for building a provider plugin (sell AI capacity)
- [templates/router-plugin/](templates/router-plugin/) — Starter template for building a router plugin (buy AI capacity)

## Getting Started

Install the CLI globally:

```bash
npm install -g antseed-cli
antseed init         # install official plugins
antseed seed --provider anthropic   # sell Anthropic API capacity
antseed connect --router claude-code  # buy capacity via Claude Code
```

## Plugin Ecosystem

Antseed is extensible. Any developer can publish a plugin to npm:

| Plugin type | Purpose | Command |
|---|---|---|
| Provider plugin | Connect an upstream AI API and sell capacity | `antseed seed --provider <name>` |
| Router plugin | Select peers and proxy requests for a client tool | `antseed connect --router <name>` |

Use the templates in this directory as a starting point:

```bash
# Provider plugin (sell capacity)
cp -r templates/provider-plugin my-provider
cd my-provider && npm install && npm run verify

# Router plugin (proxy requests)
cp -r templates/router-plugin my-router
cd my-router && npm install && npm run verify
```

## Links

- [antseed-node](https://npmjs.com/package/antseed-node) — Protocol SDK
- [antseed-provider-anthropic](https://npmjs.com/package/antseed-provider-anthropic) — Official Anthropic provider
- [antseed-router-claude-code](https://npmjs.com/package/antseed-router-claude-code) — Official Claude Code / Aider router
