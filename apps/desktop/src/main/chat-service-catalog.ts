export type ChatServiceProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

export type NetworkPeerAddress = {
  peerId?: string;
  displayName?: string;
  host: string;
  port: number;
  providers?: string[];
  services?: string[];
  sellerContract?: string;
  providerServiceApiProtocols?: Record<string, { services: Record<string, string[]> }>;
  providerPricing?: Record<string, {
    defaults?: {
      inputUsdPerMillion?: number;
      outputUsdPerMillion?: number;
      cachedInputUsdPerMillion?: number;
      input?: number;
      output?: number;
    };
    services?: Record<string, {
      inputUsdPerMillion?: number;
      outputUsdPerMillion?: number;
      cachedInputUsdPerMillion?: number;
      input?: number;
      output?: number;
    }>;
  }>;
  providerServiceCategories?: Record<string, { services: Record<string, string[]> }>;
  defaultInputUsdPerMillion?: number;
  defaultOutputUsdPerMillion?: number;
};

export type ChatServiceCatalogEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: ChatServiceProtocol;
  count: number;
  peerId?: string;
  peerLabel?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  categories?: string[];
  description?: string;
};

const VALID_CHAT_SERVICE_PROTOCOLS = new Set<string>([
  'anthropic-messages', 'openai-chat-completions', 'openai-responses',
]);

export function inferProviderProtocol(provider: string): ChatServiceProtocol | null {
  if (provider === 'openai-responses') {
    return 'openai-responses';
  }
  if (provider === 'openai' || provider === 'openrouter' || provider === 'local-llm') {
    return 'openai-chat-completions';
  }
  if (provider === 'anthropic' || provider === 'claude-code' || provider === 'claude-oauth') {
    return 'anthropic-messages';
  }
  return null;
}

export function resolveProviderServiceProtocol(
  apiProtocols: NetworkPeerAddress['providerServiceApiProtocols'],
  provider: string,
  serviceId: string,
): ChatServiceProtocol | null {
  const protocols = apiProtocols?.[provider]?.services?.[serviceId];
  if (!Array.isArray(protocols)) return null;
  for (const p of protocols) {
    if (VALID_CHAT_SERVICE_PROTOCOLS.has(p)) {
      return p as ChatServiceProtocol;
    }
  }
  return null;
}

export function resolveProviderServicePricing(
  pricingMap: NetworkPeerAddress['providerPricing'],
  provider: string,
  serviceId: string,
  defaultInput?: number,
  defaultOutput?: number,
): { inputUsdPerMillion?: number; outputUsdPerMillion?: number } {
  const providerPricing = pricingMap?.[provider];
  const servicePricing = providerPricing?.services?.[serviceId];
  const defaultPricing = providerPricing?.defaults;
  const inputUsd = servicePricing?.inputUsdPerMillion
    ?? servicePricing?.input
    ?? defaultPricing?.inputUsdPerMillion
    ?? defaultPricing?.input
    ?? defaultInput;
  const outputUsd = servicePricing?.outputUsdPerMillion
    ?? servicePricing?.output
    ?? defaultPricing?.outputUsdPerMillion
    ?? defaultPricing?.output
    ?? defaultOutput;
  return {
    ...(inputUsd != null ? { inputUsdPerMillion: inputUsd } : {}),
    ...(outputUsd != null ? { outputUsdPerMillion: outputUsd } : {}),
  };
}

export function sortChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  const protocolRank = (protocol: ChatServiceProtocol): number => (
    protocol === 'anthropic-messages'
      ? 0
      : protocol === 'openai-chat-completions'
        ? 1
        : 2
  );

  return entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (protocolRank(a.protocol) !== protocolRank(b.protocol)) {
      return protocolRank(a.protocol) - protocolRank(b.protocol);
    }
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.id.localeCompare(b.id);
  });
}

export function buildChatServiceCatalogFromPeers(peers: NetworkPeerAddress[]): ChatServiceCatalogEntry[] {
  const results: ChatServiceCatalogEntry[] = [];
  for (const peer of peers) {
    const peerId = peer.peerId;
    const peerLabel = peer.displayName
      ? `${peer.displayName} (${peerId?.slice(0, 8) ?? ''})`
      : peerId ? peerId.slice(0, 12) + '...' : undefined;

    const providerList = peer.providers ?? [];
    const serviceList = peer.services ?? [];
    const apiProtocols = peer.providerServiceApiProtocols;
    const pricingMap = peer.providerPricing;
    const categoriesMap = peer.providerServiceCategories;
    const defaultInput = peer.defaultInputUsdPerMillion;
    const defaultOutput = peer.defaultOutputUsdPerMillion;

    if (providerList.length > 0) {
      // Build rows from each provider's own announced service map. The flattened
      // `peer.services` list is peer-wide, so pairing every service with
      // providerList[0] makes services belonging to a second provider inherit
      // the first provider's defaults/pricing.
      const emittedProviderServices = new Set<string>();
      for (const provider of providerList) {
        const providerServiceIds = new Set<string>([
          ...Object.keys(pricingMap?.[provider]?.services ?? {}),
          ...Object.keys(apiProtocols?.[provider]?.services ?? {}),
          ...Object.keys(categoriesMap?.[provider]?.services ?? {}),
        ]);

        for (const serviceId of providerServiceIds) {
          emittedProviderServices.add(`${provider}\u0000${serviceId}`);
          const protocol = resolveProviderServiceProtocol(apiProtocols, provider, serviceId) ?? inferProviderProtocol(provider);
          if (!protocol) continue;

          const { inputUsdPerMillion, outputUsdPerMillion } = resolveProviderServicePricing(
            pricingMap,
            provider,
            serviceId,
            defaultInput,
            defaultOutput,
          );
          const categories = categoriesMap?.[provider]?.services?.[serviceId];

          results.push({
            id: serviceId,
            label: serviceId,
            provider,
            protocol,
            count: 1,
            ...(peerId ? { peerId } : {}),
            ...(peerLabel ? { peerLabel } : {}),
            ...(inputUsdPerMillion != null ? { inputUsdPerMillion } : {}),
            ...(outputUsdPerMillion != null ? { outputUsdPerMillion } : {}),
            ...(categories?.length ? { categories } : {}),
          });
        }
      }

      // Backward-compatible fallback for older state files that only contain a
      // peer-wide `services` array. In that ambiguous shape we keep the old
      // first-provider behavior, but do not override provider-specific rows
      // already emitted above.
      if (serviceList.length > 0) {
        const fallbackProvider = providerList[0] ?? 'unknown';
        for (const serviceId of serviceList) {
          if (emittedProviderServices.size > 0 && emittedProviderServices.has(`${fallbackProvider}\u0000${serviceId}`)) {
            continue;
          }
          if (emittedProviderServices.size > 0) {
            continue;
          }
          const protocol = resolveProviderServiceProtocol(apiProtocols, fallbackProvider, serviceId) ?? inferProviderProtocol(fallbackProvider);
          if (!protocol) continue;
          const { inputUsdPerMillion, outputUsdPerMillion } = resolveProviderServicePricing(
            pricingMap,
            fallbackProvider,
            serviceId,
            defaultInput,
            defaultOutput,
          );
          const categories = categoriesMap?.[fallbackProvider]?.services?.[serviceId];

          results.push({
            id: serviceId,
            label: serviceId,
            provider: fallbackProvider,
            protocol,
            count: 1,
            ...(peerId ? { peerId } : {}),
            ...(peerLabel ? { peerLabel } : {}),
            ...(inputUsdPerMillion != null ? { inputUsdPerMillion } : {}),
            ...(outputUsdPerMillion != null ? { outputUsdPerMillion } : {}),
            ...(categories?.length ? { categories } : {}),
          });
        }
      } else {
        // No services listed — create one entry per provider as a fallback.
        for (const provider of providerList) {
          const protocol = inferProviderProtocol(provider);
          if (!protocol) continue;

          const { inputUsdPerMillion, outputUsdPerMillion } = resolveProviderServicePricing(
            pricingMap,
            provider,
            provider,
            defaultInput,
            defaultOutput,
          );
          results.push({
            id: provider,
            label: provider,
            provider,
            protocol,
            count: 1,
            ...(peerId ? { peerId } : {}),
            ...(peerLabel ? { peerLabel } : {}),
            ...(inputUsdPerMillion != null ? { inputUsdPerMillion } : {}),
            ...(outputUsdPerMillion != null ? { outputUsdPerMillion } : {}),
          });
        }
      }
    }
  }

  return sortChatServiceCatalogEntries(results);
}
