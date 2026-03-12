---
sidebar_position: 1
slug: /provider-api
title: Provider Plugin
hide_title: true
---

# Provider Plugin

Provider plugins expose AI services to the network. They advertise services, pricing, optional service categories, capabilities, and Skills via discovery metadata, and handle incoming requests from buyers.

:::warning Provider Compliance
AntSeed is designed for providers who build differentiated services — such as TEE-secured inference, domain-specific skills or agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Providers are solely responsible for complying with their upstream API provider's terms.
:::

## Provider Interface

```typescript title="provider interface"
interface Provider {
  name: string
  services: string[]
  serviceApiProtocols?: Record<string, string[]>
  pricing: {
    defaults: {
      inputUsdPerMillion: number
      outputUsdPerMillion: number
    }
    services?: Record<string, {
      inputUsdPerMillion: number
      outputUsdPerMillion: number
    }>
  }
  serviceCategories?: Record<string, string[]>
  maxConcurrency: number
  capabilities?: ProviderCapability[]

  handleRequest(req: SerializedHttpRequest):
    Promise<SerializedHttpResponse>

  init?(): Promise<void>
  getCapacity(): { current: number; max: number }
}
```

## Example: Anthropic Provider

```typescript title="anthropic-provider.ts"
import type { Provider } from '@antseed/node'
import Anthropic from '@anthropic-ai/sdk'

export default {
  name: 'anthropic',
  services: ['claude-sonnet-4-6', 'claude-haiku-4-5'],

  pricing: {
    defaults: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15
    }
  },
  serviceCategories: {
    "claude-sonnet-4-6": ["coding", "privacy"]
  },
  maxConcurrency: 5,

  getCapacity: () => ({ current: 0, max: 10 }),

  async handleRequest(req) {
    const client = new Anthropic()
    const msg = await client.messages.create({
      model: req.model,
      max_tokens: req.max_tokens,
      messages: req.messages,
    })
    return {
      text: msg.content[0].text,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens
      }
    }
  }
} satisfies Provider
```

`serviceCategories` is optional and is announced in peer metadata for discovery filtering. Recommended tags include `privacy`, `legal`, `uncensored`, `coding`, `finance`, and `tee` (custom tags are allowed).

`services` should represent the service IDs buyers will request on the network. A provider can still rewrite to different upstream model IDs internally (for example, announce `kimi2.5` and forward upstream as `together/kimi2.5`).

## Middleware / Skills

Providers can inject Markdown files into every buyer request server-side — before the upstream LLM call — without buyers ever seeing the additions. No plugin code required; the CLI handles it automatically.

```json title="antseed.config.json"
{
  "seller": {
    "middleware": [
      { "file": "./skills/persona.md", "position": "system-prepend" },
      { "file": "./skills/output-format.md", "position": "append", "role": "user" },
      { "file": "./skills/sonnet-rules.md", "position": "system-append", "services": ["claude-sonnet-4-5", "claude-sonnet-4-6"] }
    ]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `file` | Yes | Path to a `.md` file (relative to config or absolute) |
| `position` | Yes | Where to inject: `system-prepend`, `system-append`, `prepend`, or `append` |
| `role` | No | Message role for `prepend`/`append`. Defaults to `user` |
| `services` | No | Scope injection to specific service IDs. Omit to apply globally. Must not be empty |

Injection positions:

- **`system-prepend`** / **`system-append`** — Prepend or append to the system prompt (Anthropic format) or insert a system-role message (OpenAI format)
- **`prepend`** / **`append`** — Insert as the first or last message in the conversation

When `services` is set, the entry is only injected when the request's service matches one of the listed IDs. If the request has no service field, service-scoped entries are skipped. Global entries (no `services`) always apply.

## Peer Offering

Each provider advertises discrete offerings to the network:

| Field | Type | Description |
|---|---|---|
| capability | string | Type (inference, agent, skill, tool, etc.) |
| name | string | Human-readable offering name |
| description | string | What this offering does |
| services | string[] | Service identifiers (if applicable) |
| pricing | PricingTier | Unit and price per unit |
