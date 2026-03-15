import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { BoundAgentDefinition } from './loader.js';
import { type BoundAgentTool, knowledgeTool } from './tools.js';
import { runAgentLoop, runAgentLoopStream, type AgentLoopOptions, type ResolvedAgent } from './agent-loop.js';

type AgentResolver = (body: Record<string, unknown>) => ResolvedAgent | undefined;

export class BoundAgentProvider implements Provider {
  private readonly _inner: Provider;
  private readonly _resolve: AgentResolver;
  private readonly _options: AgentLoopOptions;

  constructor(
    inner: Provider,
    agents: BoundAgentDefinition | Record<string, BoundAgentDefinition>,
    options?: AgentLoopOptions,
  ) {
    this._inner = inner;
    this._options = options ?? {};
    this._resolve = buildResolver(agents, options?.tools);
  }

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
    return runAgentLoop(this._inner, req, this._resolve, this._options);
  }

  get handleRequestStream():
    | ((req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => Promise<SerializedHttpResponse>)
    | undefined {
    if (!this._inner.handleRequestStream) return undefined;
    return (req, callbacks) =>
      runAgentLoopStream(this._inner, req, this._resolve, callbacks, this._options);
  }
}

/** Build tools list from agent definition + custom tools. Done once at construction. */
function resolveTools(agent: BoundAgentDefinition, extra?: BoundAgentTool[]): BoundAgentTool[] {
  const tools: BoundAgentTool[] = [];
  if (agent.knowledge.length > 0) tools.push(knowledgeTool(agent.knowledge));
  if (extra) tools.push(...extra);
  return tools;
}

function prepareAgent(agent: BoundAgentDefinition, extra?: BoundAgentTool[]): ResolvedAgent {
  return { definition: agent, tools: resolveTools(agent, extra) };
}

function buildResolver(
  agents: BoundAgentDefinition | Record<string, BoundAgentDefinition>,
  extraTools?: BoundAgentTool[],
): AgentResolver {
  if (isBoundAgentDefinition(agents)) {
    const resolved = prepareAgent(agents, extraTools);
    return () => resolved;
  }

  const serviceMap = new Map<string, ResolvedAgent>();
  let defaultAgent: ResolvedAgent | undefined;

  for (const [service, def] of Object.entries(agents)) {
    const resolved = prepareAgent(def, extraTools);
    if (service === '*') {
      defaultAgent = resolved;
    } else {
      serviceMap.set(service, resolved);
    }
  }

  return (body) => {
    const service = (body.service ?? body.model) as string | undefined;
    if (service) {
      const exact = serviceMap.get(service);
      if (exact) return exact;
    }
    return defaultAgent;
  };
}

function isBoundAgentDefinition(
  value: BoundAgentDefinition | Record<string, BoundAgentDefinition>,
): value is BoundAgentDefinition {
  return typeof (value as BoundAgentDefinition).name === 'string'
    && Array.isArray((value as BoundAgentDefinition).guardrails)
    && Array.isArray((value as BoundAgentDefinition).knowledge);
}
