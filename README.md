# @antseed/node

[![npm version](https://img.shields.io/npm/v/@antseed/node.svg)](https://www.npmjs.com/package/@antseed/node)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

Core protocol SDK for the Antseed Network -- a peer-to-peer inference marketplace. Sellers expose LLM capacity, buyers discover sellers via DHT and send requests over encrypted P2P connections.

## Installation

```bash
npm install @antseed/node
```

## Quick Start

### Seller Mode

A seller node announces its capacity on the DHT and serves inference requests from buyers.

```ts
import { AntseedNode } from '@antseed/node';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

// Implement the Provider interface (or use an existing plugin)
const myProvider: Provider = {
  name: 'my-llm',
  models: ['my-model-v1'],
  pricing: {
    defaults: {
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 10,
    },
  },
  maxConcurrency: 10,
  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    // Forward the request to your LLM backend and return the response
    const result = await callMyBackend(req);
    return {
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(result)),
    };
  },
  getCapacity() {
    return { current: 0, max: 10 };
  },
};

const node = new AntseedNode({ role: 'seller' });
node.registerProvider(myProvider);
await node.start();

console.log('Seller peer ID:', node.peerId);
// Node is now discoverable on the DHT and accepting P2P connections
```

### Buyer Mode

A buyer node discovers sellers via DHT, connects to them, and sends inference requests.

```ts
import { AntseedNode } from '@antseed/node';
import { randomUUID } from 'node:crypto';

const node = new AntseedNode({ role: 'buyer' });
await node.start();

// Discover sellers on the network
const peers = await node.discoverPeers();

if (peers.length > 0) {
  const seller = peers[0];

  const response = await node.sendRequest(seller, {
    requestId: randomUUID(),
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hello' }],
    })),
  });

  console.log('Response status:', response.statusCode);
}
```

## Node Configuration

```ts
interface NodeConfig {
  role: 'seller' | 'buyer';
  dataDir?: string;           // Default: ~/.antseed
  dhtPort?: number;           // Default: 6881 for seller, 0 (OS-assigned) for buyer
  signalingPort?: number;     // Default: 6882 for seller
  bootstrapNodes?: Array<{ host: string; port: number }>;
  payments?: {
    enabled?: boolean;
    paymentMethod?: 'crypto';
    platformFeeRate?: number;
    settlementIdleMs?: number;
    defaultEscrowAmountUSDC?: string;
    sellerWalletAddress?: string;
    paymentConfig?: PaymentConfig | null;
  };
}
```

| Option | Default | Description |
|---|---|---|
| `role` | (required) | `'seller'` to serve requests, `'buyer'` to consume them |
| `dataDir` | `~/.antseed` | Directory for identity keys, metering DB, and config |
| `dhtPort` | `6881` / `0` | UDP port for DHT. Seller defaults to 6881, buyer uses OS-assigned |
| `signalingPort` | `6882` | TCP port for P2P signaling and incoming connections (seller only) |
| `bootstrapNodes` | Official nodes | Custom DHT bootstrap nodes for testing or private networks |
| `payments` | disabled | Optional seller-side payment channel + settlement lifecycle wiring |

## On-Chain Settlement Flow

When `payments.enabled=true` in seller mode:

1. A per-buyer session channel is created (`PaymentChannelManager`).
2. If `crypto.autoFundEscrow=true`, escrow is funded on-chain at session start.
3. Usage receipts are generated during request handling.
4. On idle/session finalization, `SettlementService` computes cost from receipt cents and settles on-chain via:
   - `EscrowClient.settle(sessionId, sellerAmount, platformAmount)`
5. Any unused escrow is refunded to the buyer by contract logic in the same settlement transaction.

Minimal crypto config:

```ts
const node = new AntseedNode({
  role: 'seller',
  payments: {
    enabled: true,
    paymentMethod: 'crypto',
    platformFeeRate: 0.05,
    defaultEscrowAmountUSDC: '1',
    sellerWalletAddress: '0xSeller...',
    paymentConfig: {
      crypto: {
        chainId: 'base',
        rpcUrl: process.env.RPC_URL!,
        escrowContractAddress: process.env.ESCROW_ADDRESS!,
        usdcContractAddress: process.env.USDC_ADDRESS!,
        autoFundEscrow: true,
      },
    },
  },
});
```

Smart contract source and deployment notes: `node/contracts/README.md`.

## Key Exports

```ts
// Main class
import { AntseedNode, type NodeConfig } from '@antseed/node';

// Interfaces
import type { Provider } from '@antseed/node';
import type { Router } from '@antseed/node';
import type {
  AntseedPlugin,
  AntseedProviderPlugin,
  AntseedRouterPlugin,
  PluginConfigKey,
} from '@antseed/node';

// Identity & P2P
import { loadOrCreateIdentity, type Identity } from '@antseed/node';
import { NatTraversal, type NatMapping, type NatTraversalResult } from '@antseed/node';

// Discovery
import { DHTNode, DEFAULT_DHT_CONFIG } from '@antseed/node';
import { OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes, toBootstrapConfig } from '@antseed/node';
import { MetadataServer, type MetadataServerConfig } from '@antseed/node';
import type { PeerMetadata, ProviderAnnouncement } from '@antseed/node';

// Metering & Payments
import { MeteringStorage } from '@antseed/node';
import { BalanceManager } from '@antseed/node';
import { PaymentChannelManager, SettlementService } from '@antseed/node/payments';
import { EscrowClient, deployEscrowContract } from '@antseed/node';

// Routing & Proxy
import { ProxyMux } from '@antseed/node';
import { DefaultRouter, type DefaultRouterConfig } from '@antseed/node';
import { resolveProvider } from '@antseed/node';
// Plugin system
import { loadPluginModule, loadAllPlugins } from '@antseed/node';
import type { ConfigField } from '@antseed/node';
```

Submodule imports are also available:

```ts
import { DHTNode } from '@antseed/node/discovery';
import { MeteringStorage } from '@antseed/node/metering';
import { BalanceManager } from '@antseed/node/payments';
```

## Provider Interface

Implement `Provider` to expose any LLM backend as a seller on the network.

```ts
interface Provider {
  /** Unique name for this provider (e.g., 'anthropic', 'openai') */
  name: string;

  /** Model IDs this provider supports */
  models: string[];

  /** Pricing in USD per 1M tokens (defaults + optional per-model overrides) */
  pricing: {
    defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
    models?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
  };

  /** Maximum concurrent requests this provider can handle */
  maxConcurrency: number;

  /** Handle an incoming inference request and return the response */
  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse>;

  /** Return current and maximum concurrent request counts */
  getCapacity(): { current: number; max: number };

  /** Optional startup hook (credential validation, warm-up, etc.) */
  init?(): Promise<void>;

  /** Optional capabilities beyond plain inference */
  capabilities?: ProviderCapability[];

  /** Optional long-running task endpoint backing `/v1/task` */
  handleTask?(task: TaskRequest): AsyncIterable<TaskEvent>;

  /** Optional one-shot skill endpoint backing `/v1/skill` */
  handleSkill?(skill: SkillRequest): Promise<SkillResponse>;
}
```

## Router Interface

Implement `Router` to control how a buyer selects which seller to route each request to.

```ts
interface Router {
  /** Pick the best peer for a given request from the available peers. Return null to reject. */
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;

  /** Called after each request completes so the router can update internal state. */
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
  }): void;
}
```

If no router is set, the SDK uses a built-in `DefaultRouter` that selects the cheapest peer above a minimum reputation threshold.

## Building a Custom Provider Plugin

A provider plugin wraps a `Provider` so it can be installed and configured through the CLI.

```ts
import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

class MyProvider implements Provider {
  readonly name = 'my-provider';
  readonly models: string[];
  readonly pricing: Provider['pricing'];
  readonly maxConcurrency: number;
  private _active = 0;

  constructor(apiKey: string, models: string[], inputUsdPerMillion: number, outputUsdPerMillion: number, maxConcurrency: number) {
    this.models = models;
    this.pricing = {
      defaults: {
        inputUsdPerMillion,
        outputUsdPerMillion,
      },
    };
    this.maxConcurrency = maxConcurrency;
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    try {
      // Forward req to your upstream LLM and return the response
      const upstream = await fetch('https://my-llm.example.com/v1/chat', {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return {
        requestId: req.requestId,
        statusCode: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        body: new Uint8Array(await upstream.arrayBuffer()),
      };
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'my-provider',
  displayName: 'My Provider',
  version: '1.0.0',
  type: 'provider',
  description: 'Sells My LLM capacity on the Antseed Network',
  configKeys: [
    { key: 'MY_API_KEY', description: 'API key for My LLM', required: true, secret: true },
    { key: 'MY_MODELS', description: 'Comma-separated model list', required: false },
    { key: 'MY_INPUT_USD_PER_MILLION', description: 'Input price in USD per 1M tokens', required: false },
    { key: 'MY_OUTPUT_USD_PER_MILLION', description: 'Output price in USD per 1M tokens', required: false },
  ],
  createProvider(config: Record<string, string>) {
    const apiKey = config['MY_API_KEY'] ?? '';
    const models = (config['MY_MODELS'] ?? 'default-model').split(',').map(s => s.trim());
    const input = parseFloat(config['MY_INPUT_USD_PER_MILLION'] ?? '10');
    const output = parseFloat(config['MY_OUTPUT_USD_PER_MILLION'] ?? String(input));
    return new MyProvider(apiKey, models, input, output, 10);
  },
};

export default plugin;
```

## Building a Custom Router Plugin

A router plugin wraps a `Router` for CLI-based installation and configuration.

```ts
import type { AntseedRouterPlugin, Router, PeerInfo, SerializedHttpRequest } from '@antseed/node';

class CheapestRouter implements Router {
  private readonly _maxInputUsdPerMillion: number;

  constructor(maxInputUsdPerMillion: number) {
    this._maxInputUsdPerMillion = maxInputUsdPerMillion;
  }

  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const eligible = peers
      .filter(p => (p.defaultInputUsdPerMillion ?? Infinity) <= this._maxInputUsdPerMillion)
      .sort((a, b) => (a.defaultInputUsdPerMillion ?? 0) - (b.defaultInputUsdPerMillion ?? 0));
    return eligible[0] ?? null;
  }

  onResult(_peer: PeerInfo, _result: { success: boolean; latencyMs: number; tokens: number }): void {
    // Track metrics, update reputation, etc.
  }
}

const plugin: AntseedRouterPlugin = {
  name: 'cheapest',
  displayName: 'Cheapest Router',
  version: '1.0.0',
  type: 'router',
  description: 'Always routes to the cheapest available peer',
  configKeys: [
    { key: 'MAX_INPUT_USD_PER_MILLION', description: 'Maximum input price in USD per 1M tokens', required: false },
  ],
  createRouter(config: Record<string, string>) {
    const maxInput = parseFloat(config['MAX_INPUT_USD_PER_MILLION'] ?? 'Infinity');
    return new CheapestRouter(maxInput);
  },
};

export default plugin;
```

## Plugin Ecosystem

The Antseed plugin system uses a simple contract:

1. **Provider plugins** (`AntseedProviderPlugin`) export a default object with `type: 'provider'` and a `createProvider(config)` factory.
2. **Router plugins** (`AntseedRouterPlugin`) export a default object with `type: 'router'` and a `createRouter(config)` factory.
3. Both plugin types declare their configuration via `configKeys`, an array of `PluginConfigKey` objects:

```ts
interface PluginConfigKey {
  key: string;          // Environment variable name
  description: string;  // Human-readable description
  required: boolean;    // Whether the key must be set
  secret?: boolean;     // If true, the value is masked in CLI output
}
```

The CLI reads these keys from environment variables and passes them as a `Record<string, string>` to the factory function. Plugins are installed with `antseed plugin add <package-name>`.

## Links

- [npm](https://www.npmjs.com/package/@antseed/node)
- [GitHub](https://github.com/antseed/@antseed/node)
