# AntSeed

A peer-to-peer AI services network. Providers offer AI services, buyers discover providers via DHT and route requests through encrypted P2P connections.

## How It Works

**Providers** run a provider plugin that connects to an upstream LLM API (Anthropic, OpenRouter, local Ollama, etc.) and announce capacity on the DHT network.

**Buyers** run a router plugin that discovers providers, scores them on price/latency/reputation, and proxies requests through a local HTTP endpoint that drop-in replaces `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.

## Terms of Use

AntSeed is infrastructure for building differentiated AI services — not for raw resale of API keys or subscription access. Providers are expected to add value through domain-specific skills, agent workflows, Trusted Execution Environments (TEEs), fine-tuned models, or other product differentiation. Reselling personal subscription credentials (e.g., Claude Pro/Team plans) violates the upstream provider's terms of service and is not permitted. Always review your API provider's usage policies before offering capacity on the network. Subscription-based provider plugins (e.g., `provider-claude-code`, `provider-claude-oauth`) are provided for local testing and development only.

## Quick Start

```bash
# Install dependencies
pnpm install

# Build everything
pnpm run build

# Start providing (local testing with Claude Code keychain)
node apps/cli/dist/cli/index.js seed --provider claude-code

# Start buying (local proxy on port 8377)
node apps/cli/dist/cli/index.js connect --router local-proxy
```

Or install globally:

```bash
npm install -g @antseed/cli
antseed init          # Install trusted plugins
antseed seed          # Start providing
antseed connect       # Start buying
```

## Repository Structure

```
packages/             Core libraries
  node/               Protocol SDK -- P2P, discovery, metering, payments
  provider-core/      Shared provider infrastructure (HTTP relay, auth, token management)
  router-core/        Shared router infrastructure (peer scoring, metrics tracking)

plugins/              Provider and router plugins
  provider-anthropic/       Anthropic API key provider
  provider-claude-code/     Claude Code keychain provider
  provider-claude-oauth/    Claude OAuth provider
  provider-openrouter/      OpenRouter multi-model provider
  provider-local-llm/       Local LLM provider (Ollama, llama.cpp)
  router-local-chat/        Desktop chat router (latency-optimized)
  router-local-proxy/       HTTP proxy router (Claude Code, Aider, Continue.dev)

apps/                 Applications
  cli/                CLI tool and plugin manager
  desktop/            Electron desktop app
  dashboard/          Web dashboard (Fastify + React)
  website/            Marketing website

e2e/                  End-to-end tests
docs/protocol/        Protocol specification
```

## Architecture

```
@antseed/node (core SDK)
  ├── provider-core
  │     └── provider-anthropic, provider-claude-code, provider-claude-oauth,
  │         provider-openrouter, provider-local-llm
  ├── router-core
  │     └── router-local-chat, router-local-proxy
  ├── dashboard (peer: node)
  │     └── cli (depends: node + dashboard)
  │           └── desktop (Electron wrapper)
  └── website (standalone)
```

## Development

```bash
pnpm install            # Install all dependencies
pnpm run build          # Build in dependency order
pnpm run test           # Run all tests
pnpm run typecheck      # Type-check all packages
pnpm run clean          # Remove all dist/ directories
pnpm run dev:website    # Start website dev server
pnpm run dev:desktop    # Build deps + start desktop in dev mode
```

## Building a Plugin

Providers and routers are npm packages that export a plugin manifest:

```bash
antseed plugin create my-provider --type provider
```

See [packages/node/README.md](packages/node/README.md) for the `Provider` and `Router` interfaces, and [plugins/provider-claude-oauth/README.md](plugins/provider-claude-oauth/README.md) for a full plugin walkthrough.

## Tech Stack

- **Runtime**: Node.js >= 20, ES modules
- **Language**: TypeScript 5.x, strict mode
- **Package Manager**: pnpm workspaces
- **Build**: tsc for libraries, Vite for web apps
- **Test**: vitest
- **Desktop**: Electron
- **P2P**: BitTorrent DHT + WebRTC data channels
- **Payments**: On-chain USDC escrow (Base/Arbitrum)
