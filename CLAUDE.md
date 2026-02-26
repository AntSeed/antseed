# CLAUDE.md -- Agent Context for AntSeed Monorepo

## Project Overview
AntSeed is a peer-to-peer AI services network. Providers offer differentiated
AI services and buyers route requests to the best available peer. This monorepo
contains the core SDK, provider/router plugins, CLI, desktop app, dashboard,
and website.

**Important context for all documentation and code:** AntSeed is NOT for raw
resale of API keys or subscription access. Providers must add value (TEE, skills,
agents, fine-tuned models, managed products). Subscription-based plugins
(provider-claude-code, provider-claude-oauth) are for testing/development only.
Reselling subscription credentials violates upstream provider terms of service.

## Repository Structure
```
packages/           Core libraries (published to npm as @antseed/*)
  node/             Core protocol SDK — P2P, discovery, metering, payments
  provider-core/    Shared provider infrastructure
  router-core/      Shared router infrastructure
plugins/            Provider and router plugins (extend core)
  provider-anthropic/     Anthropic API key provider
  provider-claude-code/   Claude Code keychain provider
  provider-claude-oauth/  Claude OAuth provider
  provider-openai/        OpenAI-compatible provider (OpenAI, Together, OpenRouter)
  provider-local-llm/     Local LLM (Ollama/llama.cpp) provider
  router-local/           Local router (Claude Code, Aider, Continue.dev)
apps/               Applications
  cli/              CLI tool (@antseed/cli) — bin: antseed
  desktop/          Electron desktop app
  dashboard/        Web dashboard (Fastify server + React frontend)
  website/          Marketing website (React + Vite + Tailwind)
e2e/                End-to-end tests
docs/protocol/      Protocol specification and plugin templates
```

## Tech Stack
- **Runtime**: Node.js >=20, ES modules throughout
- **Language**: TypeScript 5.x with strict mode
- **Package Manager**: pnpm workspaces
- **Build**: tsc for libraries, Vite for web apps and Electron renderer
- **Test**: vitest for all packages
- **Native Modules**: better-sqlite3, node-datachannel (in packages/node)

## Dependency Graph
```
@antseed/node (no internal deps)
  ├── @antseed/provider-core (peer: node)
  │     └── provider-anthropic, provider-claude-code, provider-claude-oauth,
  │         provider-openai, provider-local-llm
  ├── @antseed/router-core (peer: node)
  │     └── router-local
  ├── antseed-dashboard (peer: node)
  │     └── @antseed/cli (depends: node + dashboard)
  │           └── @antseed/desktop (builds: cli + dashboard)
  └── @antseed/website (standalone, no internal deps)
```

## Key Commands
```bash
pnpm install          # Install all dependencies
pnpm run build        # Build all packages in dependency order
pnpm run test         # Run all tests
pnpm run typecheck    # Type-check all packages
pnpm run clean        # Remove all dist/ directories
```

## Build Order
Build must respect: node -> provider-core/router-core -> plugins -> dashboard -> cli -> desktop.
The root build script handles this via tiered execution.

## Internal Dependencies
All cross-package references use `workspace:*` protocol in package.json.
Peer dependencies (e.g., @antseed/node) are declared in peerDependencies
and resolved via the workspace.

## Plugin Architecture
- Provider plugins implement the `AntseedProviderPlugin` interface from @antseed/node
- Router plugins implement the `AntseedRouterPlugin` interface from @antseed/node
- Both extend shared infrastructure from provider-core / router-core
- The CLI loads plugins dynamically via the registry in apps/cli/src/plugins/registry.ts

## Native Modules
packages/node has native dependencies (better-sqlite3, node-datachannel).
After install, a postinstall script patches ethers type declarations.
The desktop app has a script to rebuild native modules for Electron's Node version.
