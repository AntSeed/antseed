import { REASONING_EFFORTS, type ReasoningEffort } from '@antseed/protocol';
import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';
import { encodeJson, parseJsonObject } from './utils.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function supportsReasoningEffort(protocol: ServiceApiProtocol | null, effort: ReasoningEffort): boolean {
  if (!REASONING_EFFORTS.includes(effort)) return false;
  if (protocol === 'anthropic-messages') return effort !== 'minimal';
  return (protocol === 'openai-chat-completions' || protocol === 'openai-responses') && effort !== 'max';
}

export function readReasoningEffort(body: Record<string, unknown>, protocol: ServiceApiProtocol): ReasoningEffort | undefined {
  const value = protocol === 'openai-chat-completions' ? body.reasoning_effort
    : protocol === 'openai-responses' ? object(body.reasoning)?.effort
    : protocol === 'anthropic-messages' ? object(body.thinking)?.type === 'disabled'
      ? 'none' : object(body.output_config)?.effort : undefined;
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? value as ReasoningEffort : undefined;
}

export function withReasoningEffort(
  request: SerializedHttpRequest,
  protocol: ServiceApiProtocol | null,
  effort: ReasoningEffort | null,
): SerializedHttpRequest {
  if (effort !== null && !supportsReasoningEffort(protocol, effort)) throw new Error(`Cannot apply reasoning effort ${effort} to ${protocol}`);
  const parsed = parseJsonObject(request.body);
  if (!parsed) throw new Error('Reasoning controls require a JSON request object');
  const body = { ...parsed };
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking;
  const outputConfig = { ...object(body.output_config) };
  delete outputConfig.effort;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  else delete body.output_config;
  if (effort !== null) {
    if (protocol === 'openai-chat-completions') body.reasoning_effort = effort;
    else if (protocol === 'openai-responses') body.reasoning = { ...(effort === 'none' ? {} : object(parsed.reasoning)), effort };
    else if (protocol === 'anthropic-messages') {
      body.thinking = { type: effort === 'none' ? 'disabled' : 'adaptive' };
      if (effort !== 'none') body.output_config = { ...outputConfig, effort };
    }
  }
  return { ...request, body: encodeJson(body),
    headers: Object.fromEntries(Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== 'content-length')) };
}
