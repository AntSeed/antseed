# PRD-02: Provider Integration + Per-Service

Created: 2026-03-15T07:45:00Z
Depends on: PRD-01

## Overview

Rewrite `provider.ts` to use the new agent loop from PRD-01 instead of the two-pass selection approach. Keep per-service routing and the `PreparedAgent` pattern but delegate all loop logic to `runAgentLoop` / `runAgentLoopStream`.

---

### Task 1: Rewrite `provider.ts`

##### REWRITE: `packages/bound-agent/src/provider.ts`

Replace the entire file. The new provider is thin — it handles the Provider interface delegation, per-service agent resolution, and delegates to `runAgentLoop`.

```ts
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { BoundAgentDefinition } from './loader.js';
import { runAgentLoop, runAgentLoopStream, type AgentLoopOptions } from './agent-loop.js';

export class BoundAgentProvider implements Provider {
  private readonly _inner: Provider;
  private readonly _serviceAgents: Map<string, BoundAgentDefinition>;
  private readonly _defaultAgent: BoundAgentDefinition | null;
  private readonly _options: AgentLoopOptions;

  constructor(
    inner: Provider,
    agents: BoundAgentDefinition | Record<string, BoundAgentDefinition>,
    options?: AgentLoopOptions,
  ) {
    this._inner = inner;
    this._serviceAgents = new Map();
    this._options = options ?? {};

    let defaultAgent: BoundAgentDefinition | null = null;

    if (isBoundAgentDefinition(agents)) {
      defaultAgent = agents;
    } else {
      for (const [service, def] of Object.entries(agents)) {
        if (service === '*') {
          defaultAgent = def;
        } else {
          this._serviceAgents.set(service, def);
        }
      }
    }

    this._defaultAgent = defaultAgent;
  }

  // Provider interface delegation
  get name() { return this._inner.name; }
  get services() { return this._inner.services; }
  get pricing(): Provider['pricing'] { return this._inner.pricing; }
  get maxConcurrency() { return this._inner.maxConcurrency; }
  get serviceCategories() { return this._inner.serviceCategories; }
  set serviceCategories(v: Record<string, string[]> | undefined) { this._inner.serviceCategories = v; }
  get serviceApiProtocols() { return this._inner.serviceApiProtocols; }
  getCapacity() { return this._inner.getCapacity(); }
  async init() { return this._inner.init?.(); }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const agent = this._resolveAgent(req);
    if (!agent) return this._inner.handleRequest(req);
    return runAgentLoop(this._inner, req, agent, this._options);
  }

  get handleRequestStream():
    | ((req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => Promise<SerializedHttpResponse>)
    | undefined {
    if (!this._inner.handleRequestStream) return undefined;
    return async (req, callbacks) => {
      const agent = this._resolveAgent(req);
      if (!agent) return this._inner.handleRequestStream!(req, callbacks);
      return runAgentLoopStream(this._inner, req, agent, callbacks, this._options);
    };
  }

  /**
   * Resolve the agent definition for this request by extracting
   * service/model from the body. Returns null for no match.
   */
  private _resolveAgent(req: SerializedHttpRequest): BoundAgentDefinition | null {
    try {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
      const service = (body.service ?? body.model) as string | undefined;
      if (service) {
        const exact = this._serviceAgents.get(service);
        if (exact) return exact;
      }
    } catch {
      // Non-JSON — fall through to default
    }
    return this._defaultAgent;
  }
}

function isBoundAgentDefinition(
  value: BoundAgentDefinition | Record<string, BoundAgentDefinition>,
): value is BoundAgentDefinition {
  return typeof (value as BoundAgentDefinition).name === 'string'
    && Array.isArray((value as BoundAgentDefinition).guardrails)
    && Array.isArray((value as BoundAgentDefinition).knowledge);
}
```

Key changes from current code:
- No `PreparedAgent` precomputation — the agent loop handles system prompt building
- No `_resolveSystemPrompt`, `_selectKnowledge`, `_injectSystem` — all moved to agent-loop + tools + system-prompt
- No `stripToolMessages` — no longer needed (we inject tools, not a separate selection call)
- `_resolveAgent` returns `BoundAgentDefinition` directly, not `PreparedAgent`
- Constructor accepts optional `AgentLoopOptions` (maxIterations)

#### Acceptance Criteria
- [ ] `provider.ts` rewritten
- [ ] Per-service routing preserved (service map + `*` wildcard)
- [ ] Single `BoundAgentDefinition` constructor still works (backward compat)
- [ ] `handleRequest` delegates to `runAgentLoop`
- [ ] `handleRequestStream` delegates to `runAgentLoopStream`
- [ ] Unmatched services pass through unchanged
- [ ] No TypeScript errors

---

### Task 2: Update `index.ts` exports

##### MODIFY: `packages/bound-agent/src/index.ts`

Update barrel exports to include new modules.

```ts
export { BoundAgentProvider } from './provider.js';
export { loadBoundAgent, type BoundAgentDefinition, type KnowledgeModule } from './loader.js';
export { type AgentLoopOptions } from './agent-loop.js';
```

#### Acceptance Criteria
- [ ] `AgentLoopOptions` exported
- [ ] Existing exports preserved
- [ ] No TypeScript errors

---

### Task 3: Verify CLI integration unchanged

##### VERIFY: `apps/cli/src/cli/commands/seed.ts`

No changes needed. The CLI imports `BoundAgentProvider`, `loadBoundAgent`, and `BoundAgentDefinition` — all still exported with the same API. The constructor signature is backward-compatible (new `options` param is optional).

Verify by running `npx tsc --noEmit -p apps/cli/tsconfig.json`.

#### Acceptance Criteria
- [ ] CLI typechecks without changes
- [ ] No import or API breakage
