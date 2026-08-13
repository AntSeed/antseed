import {
  buildNetworkServiceOffers,
  type CatalogServiceCapabilities,
  type CatalogServiceProtocol,
  type NetworkServiceCatalogPeer,
} from '@antseed/node';

export type ChatServiceProtocol = Exclude<CatalogServiceProtocol, 'openai-images'>;
export type { CatalogServiceCapabilities, CatalogServiceProtocol };

export type NetworkPeerAddress = NetworkServiceCatalogPeer & {
  host: string;
  port: number;
  sellerContract?: string;
};

export type ChatServiceCatalogEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: CatalogServiceProtocol;
  capabilities?: CatalogServiceCapabilities;
  count: number;
  peerId?: string;
  peerLabel?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  minImageUsdPerImage?: number;
  maxImageUsdPerImage?: number;
  categories?: string[];
  description?: string;
};

export function sortChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  const protocolRank = (protocol: CatalogServiceProtocol): number => (
    protocol === 'anthropic-messages'
      ? 0
      : protocol === 'openai-chat-completions'
        ? 1
        : protocol === 'openai-responses'
          ? 2
          : 3
  );

  return entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (protocolRank(a.protocol) !== protocolRank(b.protocol)) {
      return protocolRank(a.protocol) - protocolRank(b.protocol);
    }
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

export function buildChatServiceCatalogFromPeers(peers: NetworkPeerAddress[]): ChatServiceCatalogEntry[] {
  const entries = buildNetworkServiceOffers(peers)
    .filter((offer) => offer.protocol !== null)
    .map((offer): ChatServiceCatalogEntry => {
      const peerLabel = offer.displayName
        ? `${offer.displayName} (${offer.peerId.slice(0, 8)})`
        : `${offer.peerId.slice(0, 12)}...`;
      return {
        id: offer.serviceId,
        label: offer.serviceId,
        provider: offer.provider,
        protocol: offer.protocol!,
        ...(offer.capabilities ? { capabilities: offer.capabilities } : {}),
        count: 1,
        peerId: offer.peerId,
        peerLabel,
        ...(offer.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: offer.inputUsdPerMillion } : {}),
        ...(offer.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: offer.outputUsdPerMillion } : {}),
        ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
        ...(offer.minImageUsdPerImage !== undefined ? { minImageUsdPerImage: offer.minImageUsdPerImage } : {}),
        ...(offer.maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage: offer.maxImageUsdPerImage } : {}),
        ...(offer.categories?.length ? { categories: offer.categories } : {}),
      };
    });
  return sortChatServiceCatalogEntries(entries);
}
