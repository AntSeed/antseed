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
  readonly services = ['my-model-v1'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 2,
    },
  };
  readonly serviceCategories = { 'my-model-v1': ['coding'] };
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

## Adding Skills and Middleware

Providers can differentiate their service by injecting instructions, context, and skills into buyer requests — all transparently, without buyers seeing the additions. The CLI handles this automatically — no plugin code required.

There are two mechanisms:

### Middleware (always injected)

Markdown files injected into **every** request. Use for instructions the LLM always needs: persona definitions, formatting rules, domain context.

```json
{
  "seller": {
    "middleware": [
      { "file": "./prompts/persona.md", "position": "system-prepend" },
      { "file": "./prompts/output-format.md", "position": "append", "role": "user" },
      { "file": "./prompts/sonnet-rules.md", "position": "system-append", "services": ["claude-sonnet-4-5", "claude-sonnet-4-6"] }
    ]
  }
}
```

Each entry supports:

| Field | Required | Description |
|---|---|---|
| `file` | Yes | Path to a `.md` file (relative to config or absolute) |
| `position` | Yes | `system-prepend`, `system-append`, `prepend`, or `append` |
| `role` | No | Role for `prepend`/`append` positions. Defaults to `user` |
| `services` | No | If set, only inject for requests targeting one of these service IDs. Omit to apply to all services. Must contain at least one service ID |

### Skills (loaded on demand)

Skill directories containing a `SKILL.md` file that the LLM can load dynamically when needed. Only a catalog of skill names and descriptions is injected into the system prompt — the full content is loaded only when the LLM calls the `antseed_load` tool. This keeps the context window lean for requests that don't need every skill.

```json
{
  "seller": {
    "skillsDir": "./skills"
  }
}
```

Skills follow the same directory structure as Claude Code skills:

```
skills/
  visual-explainer/
    SKILL.md          ← frontmatter (name, description) + full instructions
    references/       ← optional supporting files
  code-review/
    SKILL.md
```

Each `SKILL.md` requires YAML frontmatter with `name` and `description`:

```markdown
---
name: visual-explainer
description: Generate self-contained HTML pages for technical diagrams
---
# Visual Explainer
... full skill instructions ...
```

The LLM sees the catalog and decides which skills to load based on the buyer's request. The skill content, the catalog, and the `antseed_load` tool are all stripped from the final response — the buyer only sees the LLM's natural output.

### When to use which

| | Middleware | Skills |
|---|---|---|
| **Injection** | Every request | Only when the LLM asks |
| **Use for** | Persona, formatting, rules | Situational capabilities (diagramming, code review, etc.) |
| **Context cost** | Always in context | Catalog only; full content loaded on demand |
| **Config** | `middleware` array | `skillsDir` path |

Both mechanisms can be used together. The composition chain is: `AgentProvider → MiddlewareProvider → BaseProvider`.

Buyers receive only the LLM's natural response. All injected content is applied server-side and is never visible in conversation history.

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
| `services` | `string[]` | Supported service IDs |
| `pricing.defaults.inputUsdPerMillion` | `number` | Default input pricing in USD per 1M tokens |
| `pricing.defaults.outputUsdPerMillion` | `number` | Default output pricing in USD per 1M tokens |
| `pricing.services?` | `Record<string, { inputUsdPerMillion; outputUsdPerMillion }>` | Optional per-service pricing overrides |
| `serviceCategories?` | `Record<string, string[]>` | Optional per-service discovery tags (e.g. `coding`, `privacy`) |
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
