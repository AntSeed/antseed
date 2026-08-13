import type {
  CatalogServiceCapabilities,
  CatalogServiceProtocol,
} from '@antseed/node';

export type ChatServiceProtocol = Exclude<CatalogServiceProtocol, 'openai-images'>;
export type { CatalogServiceCapabilities, CatalogServiceProtocol };

export type ChatServiceCatalogEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: CatalogServiceProtocol;
  capabilities?: CatalogServiceCapabilities;
  count: number;
  peerId?: string;
  peerLabel?: string;
  effectiveReputationScore?: number | null;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  minImageUsdPerImage?: number;
  maxImageUsdPerImage?: number;
  categories?: string[];
  description?: string;
};

type NetworkModelsPeerOffer = {
  peerId?: unknown;
  displayName?: unknown;
  provider?: unknown;
  serviceId?: unknown;
  protocol?: unknown;
  capabilities?: unknown;
  categories?: unknown;
  effectiveReputationScore?: unknown;
  inputUsdPerMillion?: unknown;
  outputUsdPerMillion?: unknown;
  cachedInputUsdPerMillion?: unknown;
  minImageUsdPerImage?: unknown;
  maxImageUsdPerImage?: unknown;
};

type NetworkModelsEntry = {
  name?: unknown;
  peers?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeCapabilities(value: unknown): CatalogServiceCapabilities | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const capabilities: CatalogServiceCapabilities = {};
  if (typeof raw.contextWindow === 'number' && Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0) {
    capabilities.contextWindow = raw.contextWindow;
  }
  if (typeof raw.maxOutputTokens === 'number' && Number.isSafeInteger(raw.maxOutputTokens) && raw.maxOutputTokens > 0) {
    capabilities.maxOutputTokens = raw.maxOutputTokens;
  }
  for (const key of ['inputs', 'outputs'] as const) {
    if (Array.isArray(raw[key])) {
      const values = raw[key].filter((item): item is string => typeof item === 'string');
      if (values.length > 0) capabilities[key] = values;
    }
  }
  if (typeof raw.reasoning === 'boolean') capabilities.reasoning = raw.reasoning;
  if (typeof raw.toolUse === 'boolean') capabilities.toolUse = raw.toolUse;
  if (typeof raw.structuredOutput === 'boolean') capabilities.structuredOutput = raw.structuredOutput;
  if (Array.isArray(raw.supportedParameters)) {
    const values = raw.supportedParameters.filter((item): item is string => typeof item === 'string');
    if (values.length > 0) capabilities.supportedParameters = values;
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

/**
 * Flattens the buyer proxy's canonical `/v1/models` response into the exact
 * peer offers consumed by Desktop. Model identity, deduplication, pricing,
 * capabilities, reputation penalties, and peer order all come from the proxy.
 */
export function buildChatServiceCatalogFromNetworkModels(payload: unknown): ChatServiceCatalogEntry[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) return [];

  const entries: ChatServiceCatalogEntry[] = [];
  for (const rawModel of root.data) {
    const model = asRecord(rawModel) as NetworkModelsEntry | null;
    if (!model || !Array.isArray(model.peers)) continue;
    const label = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : null;
    for (const rawOffer of model.peers) {
      const offer = asRecord(rawOffer) as NetworkModelsPeerOffer | null;
      if (!offer) continue;
      const peerId = typeof offer.peerId === 'string' ? offer.peerId.trim() : '';
      const provider = typeof offer.provider === 'string' ? offer.provider.trim() : '';
      const serviceId = typeof offer.serviceId === 'string' ? offer.serviceId.trim() : '';
      const protocol = offer.protocol;
      if (!peerId || !provider || !serviceId || (
        protocol !== 'anthropic-messages'
        && protocol !== 'openai-chat-completions'
        && protocol !== 'openai-responses'
        && protocol !== 'openai-images'
      )) continue;

      const displayName = typeof offer.displayName === 'string' ? offer.displayName.trim() : '';
      const capabilities = normalizeCapabilities(offer.capabilities);
      const categories = Array.isArray(offer.categories)
        ? offer.categories.filter((item): item is string => typeof item === 'string')
        : [];
      const effectiveReputationScore = nonNegativeNumber(offer.effectiveReputationScore);
      const inputUsdPerMillion = nonNegativeNumber(offer.inputUsdPerMillion);
      const outputUsdPerMillion = nonNegativeNumber(offer.outputUsdPerMillion);
      const cachedInputUsdPerMillion = nonNegativeNumber(offer.cachedInputUsdPerMillion);
      const minImageUsdPerImage = nonNegativeNumber(offer.minImageUsdPerImage);
      const maxImageUsdPerImage = nonNegativeNumber(offer.maxImageUsdPerImage);

      entries.push({
        id: serviceId,
        label: label ?? serviceId,
        provider,
        protocol,
        ...(capabilities ? { capabilities } : {}),
        count: 1,
        peerId,
        peerLabel: displayName ? `${displayName} (${peerId.slice(0, 8)})` : `${peerId.slice(0, 12)}...`,
        effectiveReputationScore: effectiveReputationScore ?? null,
        ...(inputUsdPerMillion !== undefined ? { inputUsdPerMillion } : {}),
        ...(outputUsdPerMillion !== undefined ? { outputUsdPerMillion } : {}),
        ...(cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion } : {}),
        ...(minImageUsdPerImage !== undefined ? { minImageUsdPerImage } : {}),
        ...(maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage } : {}),
        ...(categories.length > 0 ? { categories } : {}),
      });
    }
  }
  return entries;
}

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
