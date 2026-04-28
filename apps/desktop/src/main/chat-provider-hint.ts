/**
 * Internal local provider ID used by the desktop's pi-ai SDK config to
 * route requests at the local buyer proxy on 127.0.0.1. It must never
 * leak onto the wire as the `x-antseed-provider` header — the buyer proxy
 * matches that header against a peer's advertised upstream providers
 * (e.g. `openai`, `anthropic`) and rejects unknown values with a 502.
 */
export const PROXY_PROVIDER_ID = 'antseed-proxy';

export function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Returns the upstream provider ID to send as `x-antseed-provider`, or
 * null if the value is empty or is the local proxy sentinel. Centralised
 * so the read path, the write path, and the outbound header path can
 * never persist or transmit `antseed-proxy` as if it were a real
 * upstream provider.
 */
export function sanitizeProviderHint(value: unknown): string | null {
  const normalized = normalizeProviderId(value);
  if (!normalized) return null;
  if (normalized === PROXY_PROVIDER_ID) return null;
  return normalized;
}

/**
 * Resolve the `provider` field for the pi-ai `Model<any>` we hand to the
 * local buyer proxy. `pi-coding-agent`'s `AgentSession.setModel` calls
 * `sessionManager.appendModelChange(model.provider, model.id)` on every
 * turn, so whatever we put here is what gets persisted into the
 * conversation log. Use the real upstream provider when known so the
 * persisted provider matches what the buyer proxy will actually pin
 * the request to. Fall back to the local sentinel only when no upstream
 * is known; the runtime API key must always be registered under the
 * same name so credential lookup still works.
 */
export function resolveModelProvider(providerHint: unknown): string {
  return sanitizeProviderHint(providerHint) ?? PROXY_PROVIDER_ID;
}
