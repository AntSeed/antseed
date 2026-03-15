import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { BoundAgentDefinition } from './loader.js';
import {
  detectRequestFormat,
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
}

export type AgentResolver = (body: Record<string, unknown>) => BoundAgentDefinition | undefined;

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

/** Result of running the agent loop iterations. */
interface IterationResult {
  /** The final response to return/stream to the buyer. */
  response: SerializedHttpResponse;
  /** True if max iterations were hit and the response may still contain internal tool calls. */
  maxIterationsHit: boolean;
}

/**
 * Core iteration logic shared by buffered and streaming paths.
 * Parses the body once, resolves the agent, injects system prompt + tools,
 * then runs the tool loop until done or max iterations.
 */
async function iterate(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  options?: AgentLoopOptions,
): Promise<IterationResult | null> {
  const format = detectRequestFormat(req.path);
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(decoder.decode(req.body)) as Record<string, unknown>;
  } catch {
    return null; // non-JSON — caller passes through unchanged
  }

  const agent = resolve(body);
  if (!agent) return null; // no matching agent — caller passes through

  const hasTools = agent.knowledge.length > 0;
  const systemPrompt = buildSystemPrompt(agent, hasTools);
  body = injectSystemPrompt(body, systemPrompt, format);
  body = injectTools(body, agent.knowledge, format);

  for (let i = 0; i < maxIterations; i++) {
    debugLog(`[BoundAgent] ${req.method} ${req.path} (reqId=${req.requestId.slice(0, 8)}): loop iteration ${i + 1}/${maxIterations}`);

    const augmentedReq: SerializedHttpRequest = {
      ...req,
      body: encoder.encode(JSON.stringify(body)),
    };

    const response = await inner.handleRequest(augmentedReq);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    } catch {
      return { response, maxIterationsHit: false };
    }

    const action = inspectResponse(responseBody, format);
    if (action.type === 'done') {
      // Strip any internal tool calls that may be present in mixed responses
      const cleaned = stripInternalToolCalls(responseBody, format);
      return {
        response: { ...response, body: encoder.encode(JSON.stringify(cleaned)) },
        maxIterationsHit: false,
      };
    }

    const results = executeTools(action.internalCalls, agent.knowledge);
    body = appendToolLoop(body, responseBody, results, format);
  }

  // Max iterations — one final request
  debugLog(`[BoundAgent] max iterations (${maxIterations}) reached`);
  const finalReq: SerializedHttpRequest = {
    ...req,
    body: encoder.encode(JSON.stringify(body)),
  };
  const response = await inner.handleRequest(finalReq);
  return { response, maxIterationsHit: true };
}

/**
 * Run the agent loop for a single request (buffered).
 */
export async function runAgentLoop(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const result = await iterate(inner, req, resolve, options);
  if (!result) return inner.handleRequest(req);

  if (!result.maxIterationsHit) return result.response;

  // Strip any remaining internal tool calls
  const format = detectRequestFormat(req.path);
  try {
    const body = JSON.parse(decoder.decode(result.response.body)) as Record<string, unknown>;
    const cleaned = stripInternalToolCalls(body, format);
    return { ...result.response, body: encoder.encode(JSON.stringify(cleaned)) };
  } catch {
    return result.response;
  }
}

/**
 * Run the agent loop and replay the final response through stream callbacks.
 * All iterations (including the final one) are buffered via handleRequest.
 * The completed response is then replayed as a single chunk through callbacks.
 */
export async function runAgentLoopStream(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  callbacks: ProviderStreamCallbacks,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const result = await iterate(inner, req, resolve, options);
  if (!result) return inner.handleRequestStream!(req, callbacks);

  let finalResponse = result.response;

  if (result.maxIterationsHit) {
    // Strip any remaining internal tool calls before streaming
    const format = detectRequestFormat(req.path);
    try {
      const body = JSON.parse(decoder.decode(finalResponse.body)) as Record<string, unknown>;
      const cleaned = stripInternalToolCalls(body, format);
      finalResponse = { ...finalResponse, body: encoder.encode(JSON.stringify(cleaned)) };
    } catch {
      // non-JSON — stream as-is
    }
  }

  callbacks.onResponseStart(finalResponse);
  callbacks.onResponseChunk({ requestId: req.requestId, data: finalResponse.body, done: true });
  return finalResponse;
}
