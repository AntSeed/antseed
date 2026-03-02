import type { SerializedHttpRequest } from '@antseed/node';

/** Set of all known auth header names (lowercase). */
export const KNOWN_AUTH_HEADERS: Set<string> = new Set([
  'authorization', 'x-api-key', 'x-goog-api-key',
]);

/**
 * Strips all known auth headers and injects the seller's auth.
 * Returns a NEW object (no mutation of the original).
 */
export function swapAuthHeader(
  request: SerializedHttpRequest,
  config: { authHeaderName: string; authHeaderValue: string; extraHeaders?: Record<string, string> }
): SerializedHttpRequest {
  const newHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (!KNOWN_AUTH_HEADERS.has(key.toLowerCase())) {
      newHeaders[key] = value;
    }
  }

  newHeaders[config.authHeaderName] = config.authHeaderValue;

  // Inject any extra headers (e.g. anthropic-beta for OAuth).
  // For anthropic-beta, merge with existing values (comma-separated)
  // so the buyer's beta flags (e.g. context-management) are preserved.
  if (config.extraHeaders) {
    for (const [key, value] of Object.entries(config.extraHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'anthropic-beta' && newHeaders[key]) {
        // Merge: deduplicate comma-separated beta flags
        const existing = new Set(newHeaders[key]!.split(',').map((s) => s.trim()));
        for (const flag of value.split(',').map((s) => s.trim())) {
          existing.add(flag);
        }
        newHeaders[key] = [...existing].join(',');
      } else {
        newHeaders[key] = value;
      }
    }
  }

  return {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    headers: newHeaders,
    body: request.body,
  };
}

/**
 * Validate request against allowed models.
 * Parses JSON body and enforces strict top-level `"model"` allow-list.
 * Returns null if ok, error string if rejected.
 */
export function validateRequestModel(
  request: SerializedHttpRequest,
  allowedModels: string[]
): string | null {
  // If allowedModels is empty, allow everything
  if (allowedModels.length === 0) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(request.body)) as unknown;
  } catch {
    return "Invalid JSON request body";
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return 'Request body must be a JSON object containing a "model" field';
  }

  const model = (payload as Record<string, unknown>)["model"];
  if (typeof model !== "string" || model.trim() === "") {
    return 'Request is missing a valid "model" field';
  }

  const normalizedModel = model.trim().toLowerCase();
  const normalizedAllowed = allowedModels.map((m) => m.trim().toLowerCase());
  if (!normalizedAllowed.includes(normalizedModel)) {
    return `Model "${model}" is not in the allowed list`;
  }

  return null;
}
