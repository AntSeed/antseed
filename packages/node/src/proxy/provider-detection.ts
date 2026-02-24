import type { ProviderType } from '../types/metering.js';

export const ANTSEED_PROVIDER_HEADER = 'x-antseed-provider';
/** @deprecated Use ANTSEED_PROVIDER_HEADER instead */
export const IDLEAI_PROVIDER_HEADER = ANTSEED_PROVIDER_HEADER;

const KNOWN_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'google',
  'moonshot',
]);

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  key: string
): string | undefined {
  const target = key.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

/**
 * Return the provider encoded in an internal routing header, if valid.
 */
export function detectProviderFromHeaders(headers: Record<string, string>): ProviderType | null {
  const raw = getHeaderCaseInsensitive(headers, ANTSEED_PROVIDER_HEADER);
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  return KNOWN_PROVIDERS.has(normalized) ? normalized : null;
}

/**
 * Detect provider using request path heuristics.
 */
export function detectProviderFromPath(path: string): ProviderType | null {
  const normalizedPath = path.toLowerCase();

  // Must be evaluated before OpenAI checks since moonshot can share OpenAI-style paths.
  if (normalizedPath.includes('moonshot')) {
    return 'moonshot';
  }

  if (normalizedPath.startsWith('/v1/messages') || normalizedPath.startsWith('/v1/complete')) {
    return 'anthropic';
  }
  if (
    normalizedPath.startsWith('/v1/chat') ||
    normalizedPath.startsWith('/v1/completions') ||
    normalizedPath.startsWith('/v1/embeddings')
  ) {
    return 'openai';
  }
  if (normalizedPath.startsWith('/v1beta/') || normalizedPath.startsWith('/v1/models/gemini')) {
    return 'google';
  }
  return null;
}

/**
 * Resolve provider with priority:
 * 1. explicit internal header
 * 2. request path inference
 * 3. fallback value
 */
export function resolveProvider(
  path: string,
  headers: Record<string, string>,
  fallback: ProviderType
): ProviderType {
  return detectProviderFromHeaders(headers) ?? detectProviderFromPath(path) ?? fallback;
}
