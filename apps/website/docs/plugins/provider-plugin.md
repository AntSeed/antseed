---
sidebar_position: 1
slug: /provider-api
title: Provider Plugin
hide_title: true
---

# Provider Plugin

Provider plugins expose AI services to the network. They advertise models, capabilities, Skills, and pricing via the DHT, and handle incoming requests from buyers.

## Provider Interface

```typescript title="provider interface"
interface Provider {
  name: string
  models: string[]
  pricing: {
    defaults: {
      inputUsdPerMillion: number
      outputUsdPerMillion: number
    }
    models?: Record<string, {
      inputUsdPerMillion: number
      outputUsdPerMillion: number
    }>
  }
  maxConcurrency: number
  capabilities?: ProviderCapability[]

  handleRequest(req: SerializedHttpRequest):
    Promise<SerializedHttpResponse>

  handleTask?(task: TaskRequest):
    AsyncIterable<TaskEvent>

  handleSkill?(skill: SkillRequest):
    Promise<SkillResponse>

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
  models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],

  pricing: {
    defaults: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15
    }
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

## Peer Offering

Each provider advertises discrete offerings to the network:

| Field | Type | Description |
|---|---|---|
| capability | string | Type (inference, agent, skill, tool, etc.) |
| name | string | Human-readable offering name |
| description | string | What this offering does |
| models | string[] | Model identifiers (if applicable) |
| pricing | PricingTier | Unit and price per unit |
