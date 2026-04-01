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

## Smart Contracts
```
packages/contracts/
├── interfaces/              Shared Solidity interfaces (IAntseed*.sol, IERC8004Registry.sol)
├── AntseedStats.sol         Per-agent session metrics keyed by ERC-8004 agentId
├── AntseedStaking.sol       Seller staking, slashing (holds stake USDC, binds to agentId)
├── AntseedDeposits.sol      Buyer deposits, seller payouts (holds buyer USDC)
├── AntseedChannels.sol      Session lifecycle, ReserveAuth + SpendingAuth (swappable, holds NO USDC)
├── AntseedEmissions.sol     ANTS token emissions (USDC volume-based)
├── AntseedSubPool.sol       Subscription pool
├── MockERC8004Registry.sol  Mock ERC-8004 IdentityRegistry (local testing only)
├── ANTSToken.sol            ANTS ERC-20 token
└── MockUSDC.sol             Test USDC
```
Identity uses the deployed ERC-8004 IdentityRegistry (Base: `0x8004A169...`).
Feedback uses the deployed ERC-8004 ReputationRegistry (Base: `0x8004BAa1...`).
All contracts use OpenZeppelin Ownable, ReentrancyGuard, SafeERC20.
Build/test: `cd packages/contracts && forge build && forge test`

### Payment Flow (Cumulative Streaming SpendingAuth)
1. Buyer deposits USDC into AntseedDeposits
2. Buyer signs ReserveAuth(channelId, maxAmount, deadline) off-chain
3. Seller calls `reserve()` on AntseedChannels with buyer's ReserveAuth sig → Deposits.lockForChannel()
4. Per request: buyer signs SpendingAuth(channelId, cumulativeAmount, metadataHash)
5. Seller calls `settle()` or `close()` with latest SpendingAuth → Deposits.chargeAndCreditPayouts()
6. If seller disappears: `requestTimeout()` (permissionless after deadline) → `withdraw()` after 15min grace

EIP-712 domain: name="AntseedChannels", version="7"

### Contract Separation Design
- **Stable contracts** (Staking, Deposits) hold funds and rarely change
- **Swappable contract** (Channels) holds no USDC — can be redeployed by re-pointing stable contracts
- Buyer never needs gas — all on-chain actions are seller-initiated or permissionless

## Local Testing (Full Payment Flow)

Prerequisites: `anvil` (from Foundry) and `cast` must be installed.

```bash
# 1. Start local chain
anvil &

# 2. Build everything
pnpm run build

# 3. Deploy contracts + fund wallets + register seller + stake + deposit
./scripts/setup-local-test.sh

# 4. Start seller (in a separate terminal)
node apps/cli/dist/cli/index.js --data-dir ~/.antseed-seller seed \
  --provider openai-responses --verbose --config ~/.antseed-seller/config.json

# 5. Start desktop (in a separate terminal)
cd apps/desktop && npm run dev
```

In the desktop app, go to Settings > Chain Config and set:
- Chain ID: `base-local`
- RPC URL: `http://127.0.0.1:8545`
- Deposits: `0x0165878A594ca255338adfa4d48449f69242Eb8F`
- Channels: `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853`

Then start a chat — the payment flow (ReserveAuth → per-request SpendingAuth → settle/close) runs automatically.

## Native Modules
packages/node has native dependencies (better-sqlite3, node-datachannel).
After install, a postinstall script patches ethers type declarations.
The desktop app has a script to rebuild native modules for Electron's Node version.

## SQLite Migrations
Schema changes use a lightweight migration framework in `packages/node/src/storage/`.
```
storage/
  migrate.ts                              # Runner: schema_version table + transactional apply
  migrations/
    channels/                             # payment_channels, payment_receipts
      001_create_tables.ts
      002_add_auth_sig_columns.ts
      index.ts                            # Collects all channel migrations
    metering/                             # metering_events, usage_receipts, sessions, etc.
      001_create_tables.ts
      index.ts                            # Collects all metering migrations
```
To add a new migration: create `NNN_name.ts` exporting `{ migration: Migration }`,
add it to the domain's `index.ts`. Use `/add-migration` skill for scaffolding.
Never modify an existing migration file — always create a new one.
