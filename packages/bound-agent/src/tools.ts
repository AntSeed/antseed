import type { KnowledgeModule } from './loader.js';

export type RequestFormat = 'anthropic' | 'openai';

export function detectRequestFormat(path?: string): RequestFormat {
  return path?.includes('/chat/completions') ? 'openai' : 'anthropic';
}

export const TOOL_PREFIX = 'antseed_';

/** Result of executing an internal tool call. */
export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

/** A parsed internal tool call extracted from an LLM response. */
export interface InternalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** What the agent loop should do after inspecting a response. */
export type LoopAction =
  | { type: 'continue'; internalCalls: InternalToolCall[] }
  | { type: 'done' };

const KNOWLEDGE_TOOL_NAME = `${TOOL_PREFIX}load_knowledge`;

const KNOWLEDGE_TOOL_PARAMS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The name of the knowledge module to load.' },
  },
  required: ['name'],
} as const;

function buildKnowledgeToolDescription(modules: KnowledgeModule[]): string {
  const catalog = modules.map(m => `- ${m.name}: ${m.description}`).join('\n');
  return `Load a knowledge module by name to get detailed information.\n\nAvailable modules:\n${catalog}`;
}

export function buildKnowledgeToolAnthropic(modules: KnowledgeModule[]): Record<string, unknown> {
  return {
    name: KNOWLEDGE_TOOL_NAME,
    description: buildKnowledgeToolDescription(modules),
    input_schema: KNOWLEDGE_TOOL_PARAMS,
  };
}

export function buildKnowledgeToolOpenAI(modules: KnowledgeModule[]): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: KNOWLEDGE_TOOL_NAME,
      description: buildKnowledgeToolDescription(modules),
      parameters: KNOWLEDGE_TOOL_PARAMS,
    },
  };
}

/**
 * Check if tool_choice forces a specific function, making it pointless
 * to inject antseed tools. Covers Anthropic and OpenAI formats.
 */
function isToolChoiceForced(body: Record<string, unknown>): boolean {
  const tc = body.tool_choice;
  if (tc == null || typeof tc === 'string') return false;
  const obj = tc as Record<string, unknown>;
  if (obj.type === 'tool' && typeof obj.name === 'string') return true;
  if (obj.type === 'function') {
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string') return true;
  }
  return false;
}

/**
 * Inject antseed_* tools into the request body alongside buyer tools.
 * Returns the body unchanged if tool_choice forces a specific function.
 */
export function injectTools(
  body: Record<string, unknown>,
  modules: KnowledgeModule[],
  format: RequestFormat,
): Record<string, unknown> {
  if (modules.length === 0) return body;
  if (isToolChoiceForced(body)) return body;

  const toolDef = format === 'openai'
    ? buildKnowledgeToolOpenAI(modules)
    : buildKnowledgeToolAnthropic(modules);

  const tools = Array.isArray(body.tools) ? [...(body.tools as unknown[])] : [];
  tools.push(toolDef);
  return { ...body, tools };
}

/**
 * Inspect an LLM response body and determine what the agent loop should do.
 *
 * - If there are antseed_* tool calls: continue (execute them)
 * - Otherwise: done (return response to buyer)
 */
export function inspectResponse(
  responseBody: Record<string, unknown>,
  format: RequestFormat,
): LoopAction {
  const allCalls = extractToolCalls(responseBody, format);
  const internalCalls = allCalls.filter(c => c.name.startsWith(TOOL_PREFIX));
  const hasBuyerCalls = allCalls.length > internalCalls.length;

  if (internalCalls.length === 0) return { type: 'done' };
  // Mixed calls (both internal and buyer) → treat as done.
  // Re-prompting with unresolved buyer tool calls would cause API validation errors
  // (every tool_use must have a matching tool_result). Let the buyer handle its tools;
  // internal calls get stripped by the caller.
  if (hasBuyerCalls) return { type: 'done' };
  return { type: 'continue', internalCalls };
}

/**
 * Extract all tool calls from an LLM response body.
 */
function extractToolCalls(
  body: Record<string, unknown>,
  format: RequestFormat,
): InternalToolCall[] {
  const calls: InternalToolCall[] = [];

  if (format === 'openai') {
    const choices = body.choices as { message: { tool_calls?: unknown[] } }[] | undefined;
    const toolCalls = choices?.[0]?.message?.tool_calls as {
      id: string;
      function: { name: string; arguments: string };
    }[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          calls.push({ id: tc.id, name: tc.function.name, arguments: args });
        } catch {
          // Invalid JSON — skip
        }
      }
    }
  } else {
    const content = body.content as {
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[] | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          calls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
        }
      }
    }
  }

  return calls;
}

/**
 * Execute internal tool calls and return results.
 * For v1 only antseed_load_knowledge is supported.
 */
export function executeTools(
  calls: InternalToolCall[],
  modules: KnowledgeModule[],
): ToolResult[] {
  return calls.map(call => {
    if (call.name === `${TOOL_PREFIX}load_knowledge`) {
      const name = call.arguments.name as string | undefined;
      const module = name ? modules.find(m => m.name === name) : undefined;
      if (!module) {
        return { id: call.id, content: `Knowledge module "${name ?? ''}" not found.`, isError: true };
      }
      return { id: call.id, content: module.content, isError: false };
    }
    return { id: call.id, content: `Unknown tool: ${call.name}`, isError: true };
  });
}

/**
 * Append the assistant's response (with tool calls) and tool results
 * to the message history for the next agent loop iteration.
 */
export function appendToolLoop(
  body: Record<string, unknown>,
  assistantResponse: Record<string, unknown>,
  results: ToolResult[],
  format: RequestFormat,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];

  if (format === 'openai') {
    const choices = assistantResponse.choices as { message: Record<string, unknown> }[] | undefined;
    const assistantMsg = choices?.[0]?.message;
    if (assistantMsg) messages.push(assistantMsg);
    for (const result of results) {
      messages.push({
        role: 'tool',
        tool_call_id: result.id,
        content: result.content,
      });
    }
  } else {
    const content = assistantResponse.content as unknown[] | undefined;
    if (content) messages.push({ role: 'assistant', content });
    const toolResultBlocks = results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.content,
      is_error: r.isError,
    }));
    messages.push({ role: 'user', content: toolResultBlocks });
  }

  return { ...body, messages };
}

/**
 * Strip antseed_* tool-call blocks from a response body.
 * Only used when max iterations are reached and internal calls are still pending.
 */
export function stripInternalToolCalls(
  responseBody: Record<string, unknown>,
  format: RequestFormat,
): Record<string, unknown> {
  if (format === 'openai') {
    const choices = responseBody.choices as { message: Record<string, unknown> }[] | undefined;
    if (!choices?.length) return responseBody;
    const cleaned = choices.map(choice => {
      if (!choice.message?.tool_calls) return choice;
      const msg = { ...choice.message };
      msg.tool_calls = (msg.tool_calls as { function: { name: string } }[]).filter(
        tc => !tc.function.name.startsWith(TOOL_PREFIX),
      );
      if ((msg.tool_calls as unknown[]).length === 0) delete msg.tool_calls;
      return { ...choice, message: msg };
    });
    return { ...responseBody, choices: cleaned };
  }

  const content = responseBody.content as { type: string; name?: string }[] | undefined;
  if (!content) return responseBody;
  const filtered = content.filter(
    block => !(block.type === 'tool_use' && block.name?.startsWith(TOOL_PREFIX)),
  );
  return { ...responseBody, content: filtered };
}
