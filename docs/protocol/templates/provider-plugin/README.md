# Build a Antseed Provider Plugin

This template shows how to publish a **provider plugin** for the Antseed Network. A provider plugin connects the Antseed node to an upstream AI API (Anthropic, OpenAI, a local LLM, etc.) and offers AI services to buyers on the P2P network.

> **Important:** AntSeed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills or agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service.

## How It Works

```
antseed seed --provider echo
       ↓
CLI loads antseed-provider-echo from ~/.antseed/plugins/
       ↓
plugin.createProvider(config) → Provider
       ↓
AntseedNode (seller mode) handles DHT, WebRTC, metering, payments
```

Your plugin only owns the upstream connection logic. Everything else is handled by the node.

## Quick Start

```bash
npm install
npm run verify     # check the plugin satisfies the interface
npm run build      # compile to dist/
```

To test end-to-end with the CLI:

```bash
antseed plugin add ./   # install this package as a plugin
antseed seed --provider echo
```

## Customization

Replace `EchoProvider` in `src/provider.ts` with your real inference logic:

```ts
import type { Provider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node/types';

export class MyProvider implements Provider {
  readonly name = 'my-provider';
  readonly models = ['my-model-v1'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 2,
    },
  };
  readonly modelCategories = { 'my-model-v1': ['coding'] };
  readonly maxConcurrency = 10;

  private _current = 0;
  constructor(private readonly config: Record<string, string>) {}

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._current++;
    try {
      const body = await callMyLLM(req, this.config['MY_API_KEY']);
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    } finally {
      this._current--;
    }
  }

  getCapacity() { return { current: this._current, max: this.maxConcurrency }; }
}
```

Then declare config keys in `src/index.ts`:

```ts
configSchema: [
  { key: 'MY_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'API key' },
],
```

The CLI reads matching environment variables and passes them to `createProvider(config)`.

## Adding Skills via Middleware

Providers can inject Markdown files (system prompts, persona definitions, skill instructions) into every buyer request without buyers seeing the additions. The CLI handles this automatically — no plugin code required.

In your `antseed.config.json`:

```json
{
  "seller": {
    "middleware": [
      { "file": "./skills/coding-expert.md", "position": "system-prepend" },
      { "file": "./skills/output-format.md",  "position": "append", "role": "user" }
    ]
  }
}
```

Buyers receive only the LLM's natural response. The injected content is applied server-side before the upstream call and is never visible in conversation history. See the [`@antseed/cli` README](../../../apps/cli/README.md) for full position reference.

## Publishing

```bash
npm publish

# Users install with:
antseed plugin add my-provider-package
antseed seed --provider my-provider
```

## Verification

```bash
npm run verify
```

## Interface Reference

### `Provider`

| Property / Method | Type | Description |
|---|---|---|
| `name` | `string` | Unique provider name |
| `models` | `string[]` | Supported model IDs |
| `pricing.defaults.inputUsdPerMillion` | `number` | Default input pricing in USD per 1M tokens |
| `pricing.defaults.outputUsdPerMillion` | `number` | Default output pricing in USD per 1M tokens |
| `pricing.models?` | `Record<string, { inputUsdPerMillion; outputUsdPerMillion }>` | Optional per-model pricing overrides |
| `modelCategories?` | `Record<string, string[]>` | Optional per-model discovery tags (e.g. `coding`, `privacy`) |
| `maxConcurrency` | `number` | Max concurrent requests |
| `handleRequest(req)` | `Promise<SerializedHttpResponse>` | Handle an inference request |
| `getCapacity()` | `{ current: number; max: number }` | Current / max concurrency |

### `AntseedProviderPlugin`

| Property | Type | Description |
|---|---|---|
| `type` | `'provider'` | Must be `'provider'` |
| `name` | `string` | Short ID, e.g. `'anthropic'` |
| `displayName` | `string` | Human-readable label |
| `version` | `string` | Semantic version (e.g. `'1.0.0'`) |
| `description` | `string` | Short description of the plugin |
| `configSchema` | `ConfigField[]` | Plugin configuration fields |
| `createProvider(config)` | `Provider \| Promise<Provider>` | Factory |

## Links

- [@antseed/node source](https://github.com/AntSeed/node)
- [Provider interface](https://github.com/AntSeed/node/tree/main/src/interfaces/seller-provider.ts)
- [Official Anthropic provider](https://github.com/AntSeed/provider-anthropic)
- [Official Claude Code provider](https://github.com/AntSeed/provider-claude-code)
