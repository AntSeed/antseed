import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';

const ANTHROPIC_PROVIDER_NAMES = new Set(['anthropic', 'claude-code', 'claude-oauth']);
const OPENAI_CHAT_PROVIDER_NAMES = new Set(['openai', 'local-llm']);
const OPENAI_RESPONSES_PROVIDER_NAMES = new Set(['openai-responses']);
const STANDARD_ADAPTER_FALLBACKS: Partial<Record<ServiceApiProtocol, ServiceApiProtocol[]>> = {
  'anthropic-messages': ['openai-chat-completions', 'openai-responses'],
  'openai-chat-completions': ['openai-responses', 'anthropic-messages'],
  'openai-responses': ['openai-chat-completions', 'anthropic-messages'],
};

export interface TargetProtocolSelection {
  targetProtocol: ServiceApiProtocol;
  requiresTransform: boolean;
}

export function detectRequestServiceApiProtocol(
  request: Pick<SerializedHttpRequest, 'path' | 'headers'>,
): ServiceApiProtocol | null {
  const normalizedPath = request.path.toLowerCase();
  if (normalizedPath.startsWith('/v1/messages') || normalizedPath.startsWith('/v1/complete')) {
    return 'anthropic-messages';
  }
  if (normalizedPath.startsWith('/v1/chat/completions')) {
    return 'openai-chat-completions';
  }
  if (normalizedPath.startsWith('/v1/completions')) {
    return 'openai-completions';
  }
  if (normalizedPath.startsWith('/v1/responses')) {
    return 'openai-responses';
  }
  const hasAnthropicVersionHeader = Object.keys(request.headers)
    .some((key) => key.toLowerCase() === 'anthropic-version');
  if (hasAnthropicVersionHeader) {
    return 'anthropic-messages';
  }
  return null;
}

export function inferProviderDefaultServiceApiProtocols(providerName: string): ServiceApiProtocol[] {
  const normalized = providerName.trim().toLowerCase();
  if (normalized.length === 0) return [];
  if (ANTHROPIC_PROVIDER_NAMES.has(normalized)) return ['anthropic-messages'];
  if (OPENAI_CHAT_PROVIDER_NAMES.has(normalized)) return ['openai-chat-completions'];
  if (OPENAI_RESPONSES_PROVIDER_NAMES.has(normalized)) return ['openai-responses'];
  return [];
}

export function selectTargetProtocolForRequest(
  requestProtocol: ServiceApiProtocol | null,
  supportedProtocols: ServiceApiProtocol[],
): TargetProtocolSelection | null {
  if (!requestProtocol) return null;
  if (supportedProtocols.includes(requestProtocol)) {
    return { targetProtocol: requestProtocol, requiresTransform: false };
  }

  const fallbackProtocols = STANDARD_ADAPTER_FALLBACKS[requestProtocol] ?? [];
  for (const targetProtocol of fallbackProtocols) {
    if (supportedProtocols.includes(targetProtocol)) {
      return { targetProtocol, requiresTransform: true };
    }
  }
  return null;
}
