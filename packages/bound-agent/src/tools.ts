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

/**
 * A tool that the bound agent can use during the agent loop.
 * The tool name is automatically prefixed with `antseed_` when injected.
 */
export interface BoundAgentTool {
  /** Tool name (without the antseed_ prefix — it's added automatically). */
  name: string;
  /** Description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /** Execute the tool and return the result as a string. */
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/**
 * Create a knowledge-loading tool from a set of knowledge modules.
 * The module catalog is embedded in the tool description.
 */
export function knowledgeTool(modules: KnowledgeModule[]): BoundAgentTool {
  const catalog = modules.map(m => `- ${m.name}: ${m.description}`).join('\n');
  return {
    name: 'load_knowledge',
    description: `Load a knowledge module by name to get detailed information.\n\nAvailable modules:\n${catalog}`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the knowledge module to load.' },
      },
      required: ['name'],
    },
    execute: (args) => {
      const name = args.name as string | undefined;
      const mod = name ? modules.find(m => m.name === name) : undefined;
      if (!mod) throw new Error(`Knowledge module "${name ?? ''}" not found.`);
      return mod.content;
    },
  };
}

// ─── Tool injection ─────────────────────────────────────────────

export function isToolChoiceForced(body: Record<string, unknown>): boolean {
  const tc = body.tool_choice;
  if (tc == null) return false;
  if (tc === 'none') return true;
  if (typeof tc === 'string') return false;
  const obj = tc as Record<string, unknown>;
  if (obj.type === 'tool' && typeof obj.name === 'string') return true;
  if (obj.type === 'function') {
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string') return true;
  }
  return false;
}

function toApiFormat(tool: BoundAgentTool, format: RequestFormat): Record<string, unknown> {
  const prefixedName = `${TOOL_PREFIX}${tool.name}`;
  if (format === 'openai') {
    return { type: 'function', function: { name: prefixedName, description: tool.description, parameters: tool.parameters } };
  }
  return { name: prefixedName, description: tool.description, input_schema: tool.parameters };
}

/**
 * Inject antseed_* tools into the request body alongside buyer tools.
 * Returns the body unchanged if no tools or tool_choice is forced.
 */
export function injectTools(
  body: Record<string, unknown>,
  tools: BoundAgentTool[],
  format: RequestFormat,
): Record<string, unknown> {
  if (tools.length === 0) return body;
  if (isToolChoiceForced(body)) return body;

  const existing = Array.isArray(body.tools) ? [...(body.tools as unknown[])] : [];
  for (const tool of tools) {
    existing.push(toApiFormat(tool, format));
  }
  return { ...body, tools: existing };
}

// ─── Response inspection ────────────────────────────────────────

/**
 * Inspect an LLM response body and determine what the agent loop should do.
 */
export function inspectResponse(
  responseBody: Record<string, unknown>,
  format: RequestFormat,
): LoopAction {
  const allCalls = extractToolCalls(responseBody, format);
  const internalCalls = allCalls.filter(c => c.name.startsWith(TOOL_PREFIX));
  const hasBuyerCalls = allCalls.length > internalCalls.length;

  if (internalCalls.length === 0) return { type: 'done' };
  if (hasBuyerCalls) return { type: 'done' };
  return { type: 'continue', internalCalls };
}

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

// ─── Tool execution ─────────────────────────────────────────────

/**
 * Execute internal tool calls using the registered tool definitions.
 */
export async function executeTools(
  calls: InternalToolCall[],
  tools: BoundAgentTool[],
): Promise<ToolResult[]> {
  return Promise.all(calls.map(async (call) => {
    const unprefixed = call.name.startsWith(TOOL_PREFIX)
      ? call.name.slice(TOOL_PREFIX.length)
      : call.name;
    const tool = tools.find(t => t.name === unprefixed);
    if (!tool) {
      return { id: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    try {
      const content = await tool.execute(call.arguments);
      return { id: call.id, content, isError: false };
    } catch (err) {
      return { id: call.id, content: (err as Error).message, isError: true };
    }
  }));
}

// ─── Message appending ──────────────────────────────────────────

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

// ─── Response stripping ─────────────────────────────────────────

/**
 * Strip antseed_* tool-call blocks from a response body.
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
      if ((msg.tool_calls as unknown[]).length === 0) {
        delete msg.tool_calls;
        return { ...choice, message: msg, finish_reason: 'stop' };
      }
      return { ...choice, message: msg };
    });
    return { ...responseBody, choices: cleaned };
  }

  const content = responseBody.content as { type: string; name?: string }[] | undefined;
  if (!content) return responseBody;
  const filtered = content.filter(
    block => !(block.type === 'tool_use' && block.name?.startsWith(TOOL_PREFIX)),
  );
  const wasStripped = filtered.length < content.length;
  const hasRemainingToolUse = filtered.some(b => b.type === 'tool_use');
  return {
    ...responseBody,
    content: filtered,
    ...(wasStripped && !hasRemainingToolUse ? { stop_reason: 'end_turn' } : {}),
  };
}
