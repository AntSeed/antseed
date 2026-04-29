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

export type ServiceProviderMetadata = {
  providerServiceApiProtocols?: Record<string, { services?: Record<string, string[]> }>;
  providerPricing?: Record<string, { services?: Record<string, unknown> }>;
  providerServiceCategories?: Record<string, { services?: Record<string, string[]> }>;
};

/**
 * Resolve the peer providers that actually advertise metadata for a service.
 *
 * Some peers expose multiple upstream provider lanes at once (for example
 * `openai-responses` for GPT models and `openai` for MiniMax). The Desktop
 * chat model must bind the selected service to the provider lane that owns
 * that service; otherwise the SDK can pick the wrong API shape and turn a
 * MiniMax chat-completions request into an unsupported `/v1/responses` call.
 */
export function providersForServiceMetadata(
  providerList: string[],
  metadata: ServiceProviderMetadata,
  serviceId: string,
): string[] {
  const providers = new Set<string>();

  for (const [provider, entry] of Object.entries(metadata.providerServiceApiProtocols ?? {})) {
    if (Array.isArray(entry?.services?.[serviceId])) {
      providers.add(provider);
    }
  }
  for (const [provider, entry] of Object.entries(metadata.providerPricing ?? {})) {
    if (entry?.services?.[serviceId]) {
      providers.add(provider);
    }
  }
  for (const [provider, entry] of Object.entries(metadata.providerServiceCategories ?? {})) {
    if (Array.isArray(entry?.services?.[serviceId])) {
      providers.add(provider);
    }
  }

  if (providers.size === 0 && providerList.length > 0) {
    providers.add(providerList[0]!);
  }

  const providerRank = new Map(providerList.map((provider, index) => [provider, index]));
  return [...providers].sort((left, right) => {
    const leftRank = providerRank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = providerRank.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}
