import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { BoundAgentDefinition } from './loader.js';
import type { BoundAgentTool } from './tools.js';
import {
  detectRequestFormat,
  isToolChoiceForced,
  injectTools,
  inspectResponse,
  executeTools,
  appendToolLoop,
  stripInternalToolCalls,
} from './tools.js';
import { buildSystemPrompt, injectSystemPrompt } from './system-prompt.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_MAX_ITERATIONS = 5;

export interface AgentLoopOptions {
  /** Maximum tool-call rounds before forcing a final request. Total LLM calls = maxIterations + 1. Default: 5. */
  maxIterations?: number;
  /** Additional tools available to the agent loop. Auto-prefixed with `antseed_`. */
  tools?: BoundAgentTool[];
}

/** Agent definition paired with its pre-built tool list. Created once at construction. */
export interface ResolvedAgent {
  definition: BoundAgentDefinition;
  tools: BoundAgentTool[];
}

export type AgentResolver = (body: Record<string, unknown>) => ResolvedAgent | undefined;

function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isDebugEnabled(): boolean {
  const fromAntseed = normalizeDebugValue(process.env['ANTSEED_DEBUG']);
  if (['1', 'true', 'yes', 'on'].includes(fromAntseed)) return true;

  return normalizeDebugValue(process.env['DEBUG'])
    .split(',')
    .some((ns) => {
      const trimmed = ns.trim();
      return trimmed === '*' || trimmed === 'antseed' || trimmed === 'antseed:*';
    });
}

const DEBUG_ENABLED = isDebugEnabled();

function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.log(...args);
}

/** Prepare the request body: parse, resolve agent, inject system prompt + tools. */
function prepareBody(
  req: SerializedHttpRequest,
  resolve: AgentResolver,
): { body: Record<string, unknown>; agent: ResolvedAgent; reqTag: string } | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(decoder.decode(req.body)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const agent = resolve(body);
  if (!agent) return null;

  const { definition, tools } = agent;
  const willInjectTools = tools.length > 0 && !isToolChoiceForced(body);
  const reqTag = `[BoundAgent] ${req.method} ${req.path} (reqId=${req.requestId.slice(0, 8)})`;
  debugLog(`${reqTag}: resolved agent "${definition.name}" with ${tools.length} tool(s): ${tools.map(t => t.name).join(', ') || 'none'}${willInjectTools ? '' : ' (tools skipped)'}`);

  const systemPrompt = buildSystemPrompt(definition, willInjectTools);
  body = injectSystemPrompt(body, systemPrompt, detectRequestFormat(req.path));
  body = injectTools(body, tools, detectRequestFormat(req.path));

  return { body, agent, reqTag };
}

/**
 * Non-streaming agent loop. Runs tool iterations buffered, returns final response.
 */
export async function runAgentLoop(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const prepared = prepareBody(req, resolve);
  if (!prepared) return inner.handleRequest(req);

  const { agent, reqTag } = prepared;
  let { body } = prepared;
  const format = detectRequestFormat(req.path);
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Force non-streaming for the buffered loop
  delete body.stream;

  for (let i = 0; i < maxIterations; i++) {
    debugLog(`${reqTag}: loop iteration ${i + 1}/${maxIterations}`);

    const augReq: SerializedHttpRequest = {
      ...req,
      body: encoder.encode(JSON.stringify(body)),
    };

    const response = await inner.handleRequest(augReq);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    } catch {
      return response;
    }

    const action = inspectResponse(responseBody, format);
    if (action.type === 'done') {
      const cleaned = stripInternalToolCalls(responseBody, format);
      return { ...response, body: encoder.encode(JSON.stringify(cleaned)) };
    }

    debugLog(`${reqTag}: executing ${action.internalCalls.length} tool(s): ${action.internalCalls.map(c => c.name).join(', ')}`);
    const results = await executeTools(action.internalCalls, agent.tools);
    debugLog(`${reqTag}: tool results: ${results.map(r => `${r.id}:${r.isError ? 'error' : 'ok'}`).join(', ')}`);
    body = appendToolLoop(body, responseBody, results, format);
  }

  // Max iterations — one final call
  debugLog(`${reqTag}: max iterations (${maxIterations}) reached`);
  const finalReq: SerializedHttpRequest = {
    ...req,
    body: encoder.encode(JSON.stringify(body)),
  };
  const response = await inner.handleRequest(finalReq);
  try {
    const responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    const cleaned = stripInternalToolCalls(responseBody, format);
    return { ...response, body: encoder.encode(JSON.stringify(cleaned)) };
  } catch {
    return response;
  }
}

/**
 * Streaming agent loop. Tool iterations are buffered (non-streaming).
 * The final answer streams live to the buyer.
 */
export async function runAgentLoopStream(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  callbacks: ProviderStreamCallbacks,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const prepared = prepareBody(req, resolve);
  if (!prepared) return inner.handleRequestStream!(req, callbacks);

  const { agent, reqTag } = prepared;
  let { body } = prepared;
  const format = detectRequestFormat(req.path);
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Tool iterations: non-streaming so internal tool calls are never forwarded.
  // Track whether any tools were executed to decide if a final streaming call is needed.
  delete body.stream;
  let toolsExecuted = false;

  for (let i = 0; i < maxIterations; i++) {
    debugLog(`${reqTag}: loop iteration ${i + 1}/${maxIterations}`);

    const augReq: SerializedHttpRequest = {
      ...req,
      body: encoder.encode(JSON.stringify(body)),
    };

    const response = await inner.handleRequest(augReq);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    } catch {
      // Non-JSON — replay as-is
      callbacks.onResponseStart(response);
      callbacks.onResponseChunk({ requestId: req.requestId, data: response.body, done: true });
      return response;
    }

    const action = inspectResponse(responseBody, format);
    if (action.type === 'done') {
      debugLog(`${reqTag}: loop iteration ${i + 1} done (no internal tool calls)`);
      if (!toolsExecuted) {
        // No tools were ever called — replay the buffered response
        const cleaned = stripInternalToolCalls(responseBody, format);
        const cleanedResponse = { ...response, body: encoder.encode(JSON.stringify(cleaned)) };
        callbacks.onResponseStart(cleanedResponse);
        callbacks.onResponseChunk({ requestId: req.requestId, data: cleanedResponse.body, done: true });
        return cleanedResponse;
      }
      // Tools were used in previous iterations — stream the final answer
      break;
    }

    toolsExecuted = true;
    debugLog(`${reqTag}: loop iteration ${i + 1} — executing ${action.internalCalls.length} tool(s): ${action.internalCalls.map(c => c.name).join(', ')}`);
    const results = await executeTools(action.internalCalls, agent.tools);
    debugLog(`${reqTag}: loop iteration ${i + 1} — tool results: ${results.map(r => `${r.id}:${r.isError ? 'error' : 'ok'}`).join(', ')}`);
    body = appendToolLoop(body, responseBody, results, format);
  }

  // Tools were executed — stream the final answer to the buyer
  const finalReq: SerializedHttpRequest = {
    ...req,
    body: encoder.encode(JSON.stringify({ ...body, stream: true })),
  };
  return inner.handleRequestStream!(finalReq, callbacks);
}
