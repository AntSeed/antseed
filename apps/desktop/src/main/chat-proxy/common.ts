import type { AssistantMessage, StreamOptions, TextContent, ToolResultMessage, Usage } from '@mariozechner/pi-ai';

export type AiMessageMeta = {
  peerId?: string;
  peerAddress?: string;
  peerProviders?: string[];
  peerReputation?: number;
  peerTrustScore?: number;
  peerCurrentLoad?: number;
  peerMaxConcurrency?: number;
  provider?: string;
  service?: string;
  requestId?: string;
  routeRequestId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenSource?: 'usage' | 'estimated' | 'unknown';
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  estimatedCostUsd?: number;
};

export const OPENAI_REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;

export function resolveTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), 1_000), 30 * 60 * 1_000);
}

export function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseTokenSource(value: unknown): AiMessageMeta['tokenSource'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'usage' || normalized === 'estimated') {
    return normalized;
  }
  return 'unknown';
}

function parseHeaderNumber(headers: Headers, key: string): number | undefined {
  const value = headers.get(key);
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseHeaderCsv(headers: Headers, key: string): string[] | undefined {
  const raw = headers.get(key);
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
}

export function parseProxyMeta(response: Response, requestStartedAt: number): AiMessageMeta {
  const peerIdRaw = response.headers.get('x-antseed-peer-id');
  const peerAddressRaw = response.headers.get('x-antseed-peer-address');
  const peerProvidersRaw = parseHeaderCsv(response.headers, 'x-antseed-peer-providers');
  const providerRaw = response.headers.get('x-antseed-provider');
  const serviceRaw = response.headers.get('x-antseed-service');
  const requestIdRaw = response.headers.get('request-id') ?? response.headers.get('x-request-id');
  const routeRequestIdRaw = response.headers.get('x-antseed-request-id');

  const inputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-input-tokens'));
  const outputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-output-tokens'));
  const headerTotalTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-total-tokens'));
  const totalTokens = headerTotalTokens > 0 ? headerTotalTokens : inputTokens + outputTokens;

  const inputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-input-usd-per-million'));
  const outputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-output-usd-per-million'));
  const estimatedCostUsd = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-estimated-cost-usd'));
  const peerReputation = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-reputation'));
  const peerTrustScore = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-trust-score'));
  const peerCurrentLoad = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-current-load'));
  const peerMaxConcurrency = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-max-concurrency'));
  const latencyFromHeader = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-latency-ms'));

  const latencyMs = latencyFromHeader !== undefined
    ? Math.max(0, Math.floor(latencyFromHeader))
    : Math.max(0, Date.now() - requestStartedAt);

  return {
    peerId: typeof peerIdRaw === 'string' && peerIdRaw.trim().length > 0 ? peerIdRaw.trim() : undefined,
    peerAddress: typeof peerAddressRaw === 'string' && peerAddressRaw.trim().length > 0 ? peerAddressRaw.trim() : undefined,
    peerProviders: peerProvidersRaw,
    peerReputation,
    peerTrustScore,
    peerCurrentLoad,
    peerMaxConcurrency,
    provider: typeof providerRaw === 'string' && providerRaw.trim().length > 0 ? providerRaw.trim() : undefined,
    service: typeof serviceRaw === 'string' && serviceRaw.trim().length > 0 ? serviceRaw.trim() : undefined,
    requestId: typeof requestIdRaw === 'string' && requestIdRaw.trim().length > 0 ? requestIdRaw.trim() : undefined,
    routeRequestId: typeof routeRequestIdRaw === 'string' && routeRequestIdRaw.trim().length > 0 ? routeRequestIdRaw.trim() : undefined,
    latencyMs,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource: parseTokenSource(response.headers.get('x-antseed-token-source')),
    inputUsdPerMillion,
    outputUsdPerMillion,
    estimatedCostUsd,
  };
}

export function toUsage(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = normalizeTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count,
  );
  const output = normalizeTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  );
  const cacheRead = normalizeTokenCount(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite = normalizeTokenCount(usage.cacheWrite ?? usage.cache_creation_input_tokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? usage.total_tokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.input) ?? 0,
      output: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.output) ?? 0,
      cacheRead: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheRead) ?? 0,
      cacheWrite: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheWrite) ?? 0,
      total: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.total) ?? 0,
    },
  };
}

export function ensureUsageShape(base?: Partial<Usage>): Usage {
  return toUsage(base ?? {});
}

export function convertToolContentToText(content: Array<TextContent | { type: 'image'; mimeType: string; data: string }>): string {
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    parts.push(`[image:${block.mimeType}]`);
  }
  return parts.join('\n').trim();
}

export function mapStopReason(value: unknown): AssistantMessage['stopReason'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'end_turn' || normalized === 'stop' || normalized === 'stop_sequence') {
    return 'stop';
  }
  if (normalized === 'max_tokens' || normalized === 'length') {
    return 'length';
  }
  if (normalized === 'tool_use' || normalized === 'tooluse') {
    return 'toolUse';
  }
  return 'stop';
}

function escapeJsonControlCharactersInStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) continue;
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else if (char === '\b') out += '\\b';
      else if (char === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  return out;
}

export function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToolJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parseObject = (value: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(value);
      if (isToolArgumentsObject(parsed)) {
        return parsed;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const direct = parseObject(trimmed);
  if (direct) return direct;
  return parseObject(escapeJsonControlCharactersInStrings(trimmed));
}

export type ProxyStreamFactory = (
  model: import('@mariozechner/pi-ai').Model<any>,
  context: import('@mariozechner/pi-ai').Context,
  options?: StreamOptions,
) => ReturnType<typeof import('@mariozechner/pi-ai').createAssistantMessageEventStream>;

export type ToolResultLike = ToolResultMessage;
