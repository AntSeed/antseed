import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';

const ANTHROPIC_PROVIDER_NAMES = new Set(['anthropic', 'claude-code', 'claude-oauth']);
const OPENAI_CHAT_PROVIDER_NAMES = new Set(['openai', 'local-llm']);

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
  if (requestProtocol === 'anthropic-messages' && supportedProtocols.includes('openai-chat-completions')) {
    return { targetProtocol: 'openai-chat-completions', requiresTransform: true };
  }
  if (requestProtocol === 'openai-responses' && supportedProtocols.includes('openai-chat-completions')) {
    return { targetProtocol: 'openai-chat-completions', requiresTransform: true };
  }
  if (requestProtocol === 'openai-chat-completions' && supportedProtocols.includes('openai-responses')) {
    return { targetProtocol: 'openai-responses', requiresTransform: true };
  }
  return null;
}
