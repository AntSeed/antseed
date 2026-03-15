# @antseed/bound-agent

Bound agent runtime for AntSeed. Lets seed runners monetize their knowledge by wrapping any provider with a persona, guardrails, and selectively loaded knowledge modules.

A bound agent is a **read-only, knowledge-augmented AI service**. It doesn't act on the user's behalf — it answers questions using curated expertise that the creator packages and maintains.

## How it works

1. Creator defines an agent: persona + guardrails + knowledge modules (markdown files)
2. On each buyer request, a **selection pass** determines which knowledge modules are relevant
3. Only the relevant knowledge is injected into the system prompt for the **response pass**
4. The buyer gets a clean streamed response — no tools, no selection artifacts

When no knowledge modules are defined, it's a single-pass injection (persona + guardrails only).

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

// Single agent for all services
const agent = await loadBoundAgent('./my-agent');
const boundProvider = new BoundAgentProvider(innerProvider, agent);

// Per-service agents
const socialAgent = await loadBoundAgent('./social-agent');
const codingAgent = await loadBoundAgent('./coding-agent');
const boundProvider = new BoundAgentProvider(innerProvider, {
  'social-model-v1': socialAgent,
  'coding-model-v1': codingAgent,
  '*': socialAgent,  // fallback for unmatched services
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

## Knowledge selection

When knowledge modules are defined, each request triggers a lightweight **selection pass** before the main response:

1. The LLM sees the buyer's conversation + a catalog of module names and descriptions (not the full content)
2. It returns which modules are relevant
3. Only those modules are loaded into the system prompt for the response

This keeps the context focused — a buyer asking about LinkedIn doesn't get X/Twitter knowledge bloating the context.

If the selection fails (network error, unparseable response), all modules are loaded as a fallback.

## What gets injected

The system prompt for the response call is assembled in this order:

1. **Persona** — the agent's identity and expertise
2. **Selected knowledge** — only the relevant modules
3. **Guardrails** — hard rules
4. **Confidentiality prompt** — prevents the LLM from revealing injected content

The buyer's own system prompt (if any) is preserved after the agent's content.
