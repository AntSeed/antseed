# @antseed/bound-agent

Bound agent runtime for AntSeed. Lets seed runners monetize their knowledge by wrapping any provider with a persona, guardrails, on-demand knowledge modules, and custom tools.

A bound agent is a **read-only, knowledge-augmented AI service**. It doesn't act on the user's behalf — it answers questions using curated expertise that the creator packages and maintains.

## How it works

1. Creator defines an agent: persona + guardrails + knowledge modules (markdown files)
2. On each buyer request, persona, guardrails, and an `antseed_load_knowledge` tool are injected
3. The LLM decides when to load knowledge — it calls the tool with a module name and receives the content
4. The agent loop executes internal tool calls and re-prompts until the LLM produces a final text response
5. The buyer gets a clean streamed response — no internal tools or loop artifacts

When no knowledge modules are defined, no tools are injected and it's a single-call injection (persona + guardrails only).

## Agent directory structure

```
my-agent/
  agent.json           # manifest
  persona.md           # who the agent is
  knowledge/           # knowledge modules
    linkedin-posting.md
    content-strategy.md
    audience-growth.md
```

### agent.json

```json
{
  "name": "social-media-advisor",
  "persona": "./persona.md",
  "guardrails": [
    "Never write posts without explicit request",
    "Always disclose AI-generated content when asked"
  ],
  "knowledge": [
    {
      "name": "linkedin-posting",
      "description": "Creating and optimizing LinkedIn posts",
      "file": "./knowledge/linkedin-posting.md"
    },
    {
      "name": "content-strategy",
      "description": "Content calendars and strategy frameworks",
      "file": "./knowledge/content-strategy.md"
    },
    {
      "name": "audience-growth",
      "description": "Growing audience across platforms",
      "file": "./knowledge/audience-growth.md"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Agent name |
| `persona` | No | Path to markdown file with the agent's system prompt / personality |
| `guardrails` | No | Array of hard rules the agent must follow |
| `knowledge` | No | Array of knowledge modules for selective loading |
| `knowledge[].name` | Yes | Unique identifier used during selection |
| `knowledge[].description` | Yes | Short description — shown to the LLM to decide relevance |
| `knowledge[].file` | Yes | Path to the markdown file with the full content |
| `confidentialityPrompt` | No | Custom confidentiality instruction (has a sensible default) |

## Usage

### Programmatic

```typescript
import { loadBoundAgent, BoundAgentProvider } from '@antseed/bound-agent';

import { loadBoundAgent, BoundAgentProvider, type BoundAgentTool } from '@antseed/bound-agent';

// Basic: knowledge modules only
const agent = await loadBoundAgent('./my-agent');
const boundProvider = new BoundAgentProvider(innerProvider, agent);

// With custom tools
const fetchPrice: BoundAgentTool = {
  name: 'fetch_price',
  description: 'Fetch current price for a product',
  parameters: {
    type: 'object',
    properties: { product: { type: 'string' } },
    required: ['product'],
  },
  execute: async (args) => {
    const res = await fetch(`https://api.example.com/price/${args.product}`);
    return await res.text();
  },
};

const boundProvider = new BoundAgentProvider(innerProvider, agent, {
  tools: [fetchPrice],
});

// Per-service agents
const socialAgent = await loadBoundAgent('./social-agent');
const codingAgent = await loadBoundAgent('./coding-agent');
const boundProvider = new BoundAgentProvider(innerProvider, {
  'social-model-v1': socialAgent,
  'coding-model-v1': codingAgent,
  '*': socialAgent,
});

node.registerProvider(boundProvider);
```

### CLI

Add `agentDir` to your antseed config. Use a string for a single agent (all services), or a map for per-service agents:

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

Per-service:

```json
{
  "seller": {
    "agentDir": {
      "social-model-v1": "./agents/social",
      "coding-model-v1": "./agents/coding",
      "*": "./agents/default"
    }
  }
}
```

The `"*"` key is a fallback for services with no explicit agent. Services with no matching agent pass through unchanged.

Then run `antseed seed` as usual.

## Knowledge loading

When knowledge modules are defined, the `antseed_load_knowledge` tool is injected into the request alongside any buyer tools. The tool description includes a catalog of available module names and descriptions.

The LLM decides which modules to load based on the conversation. It can:

- Load one module, get the content, then respond
- Load multiple modules across successive tool calls
- Respond directly without loading any modules if the question doesn't require specialized knowledge

This keeps the context focused — only the knowledge the LLM judges relevant gets loaded. A buyer asking about LinkedIn won't get X/Twitter knowledge bloating the context.

## Custom tools

Beyond knowledge loading, creators can add custom tools that the LLM can call during the agent loop. Tools are defined with a name, description, JSON Schema parameters, and an async `execute` function.

```typescript
import type { BoundAgentTool } from '@antseed/bound-agent';

const fetchPrice: BoundAgentTool = {
  name: 'fetch_price',
  description: 'Fetch current price for a product',
  parameters: {
    type: 'object',
    properties: { product: { type: 'string' } },
    required: ['product'],
  },
  execute: async (args) => {
    const res = await fetch(`https://api.example.com/price/${args.product}`);
    return await res.text();
  },
};
```

Pass custom tools via the options parameter:

```typescript
new BoundAgentProvider(innerProvider, agentDef, {
  tools: [fetchPrice, anotherTool],
});
```

Tool names are automatically prefixed with `antseed_` when injected (e.g., `fetch_price` becomes `antseed_fetch_price`). The LLM sees all internal tools alongside buyer tools, with system prompt instructions to use `antseed_*` tools for context gathering and buyer tools only as requested.

If a tool's `execute` function throws, the error message is returned to the LLM as an error result so it can recover gracefully.

## What gets injected

The system prompt is assembled in this order:

1. **Persona** — the agent's identity and expertise
2. **Tool-set instructions** — tells the LLM how to use `antseed_` tools vs buyer tools (only when knowledge modules exist)
3. **Guardrails** — hard rules
4. **Confidentiality prompt** — prevents the LLM from revealing injected content

Additionally, `antseed_*` tools are added to the request's tool list alongside any buyer-provided tools. This includes the built-in `antseed_load_knowledge` (when knowledge modules are defined) and any custom tools passed via options.

The buyer's own system prompt (if any) is preserved after the agent's content.
