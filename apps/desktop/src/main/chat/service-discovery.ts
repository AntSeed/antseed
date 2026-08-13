/**
 * Builds the catalog of services buyers can route to, and the enriched
 * Discover rows behind the Explore view.
 *
 * Source data is the buyer proxy's canonical `/v1/models` response; desktop-
 * local history, health, and identity details are layered on top.
 */

import { readFile } from 'node:fs/promises';
import { readPeerHealth, type RawPeerHealth } from '../runtime/peer-cache.js';
import {
  DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
  DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
} from '../runtime/config-io.js';
import { normalizeProviderId } from './provider-hint.js';
import {
  sortChatServiceCatalogEntries,
  type CatalogServiceCapabilities,
  type CatalogServiceProtocol,
  type ChatServiceCatalogEntry,
  type ChatServiceProtocol,
} from './service-catalog.js';
import {
  asPlainObject,
  isChatServiceProtocol,
  normalizeNonNegativeNumber,
  normalizeOptionalNumber,
  normalizeServiceValue,
} from './normalize.js';
import type { DesktopVerificationLink } from '../connected-apps/domain-site-metadata.js';

export type BuyerMaxPricingDefaults = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
};

export type DiscoverRowEntry = {
  rowKey: string;
  serviceId: string;
  serviceLabel: string;
  categories: string[];
  provider: string;
  protocol: CatalogServiceProtocol;
  capabilities: CatalogServiceCapabilities | null;
  peerId: string;
  peerEvmAddress: string;
  sellerEvmAddress: string;
  sellerContract: string | null;
  verificationLinks: DiscoverVerificationLink[];
  peerIconUrl: string | null;
  peerDisplayName: string | null;
  peerLabel: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
  maxImageUsdPerImage: number | null;
  lifetimeSessions: number;
  lifetimeRequests: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeFirstSessionAt: number | null;
  lifetimeLastSessionAt: number | null;
  onChainChannelCount: number | null;
  agentId: number;
  stakeUsdc: string;
  onChainActiveChannelCount: number;
  onChainGhostCount: number;
  onChainTotalVolumeUsdc: string;
  onChainLastSettledAt: number;
  onChainReputationScore: number | null;
  onChainTrustScore: number | null;
  effectiveReputationScore: number | null;
  onChainSybilRisk: number | null;
  onChainSybilFlags: string[];
  networkRequests: string | null;
  networkInputTokens: string | null;
  networkOutputTokens: string | null;
  peerCooldownUntil: number | null;
  peerFailureStreak: number;
  peerLastFailureReason: string | null;
  selectionValue: string;
};

export type DiscoverVerificationLink = DesktopVerificationLink;

export const CHAT_SERVICE_MAX_OPTIONS = 5000;
export const CHAT_SERVICE_MAX_OPTIONS_PER_PROVIDER = 1000;

const CAPABILITY_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);
const CAPABILITY_PARAMETERS = /^[a-z][a-z0-9_]*$/;

function normalizeCatalogServiceCapabilities(raw: unknown): CatalogServiceCapabilities | null {
  const value = asPlainObject(raw);
  if (!value) return null;
  const positiveInteger = (candidate: unknown): number | undefined => (
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
      ? candidate
      : undefined
  );
  const modalities = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    const normalized = [...new Set(candidate.filter(
      (item): item is string => typeof item === 'string' && CAPABILITY_MODALITIES.has(item),
    ))];
    return normalized.length > 0 ? normalized : undefined;
  };
  const parameters = Array.isArray(value.supportedParameters)
    ? [...new Set(value.supportedParameters.filter(
        (item): item is string => typeof item === 'string' && CAPABILITY_PARAMETERS.test(item),
      ))]
    : undefined;
  const contextWindow = positiveInteger(value.contextWindow);
  const maxOutputTokens = positiveInteger(value.maxOutputTokens);
  const inputs = modalities(value.inputs);
  const outputs = modalities(value.outputs);
  const normalized: CatalogServiceCapabilities = {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    ...(typeof value.reasoning === 'boolean' ? { reasoning: value.reasoning } : {}),
    ...(typeof value.toolUse === 'boolean' ? { toolUse: value.toolUse } : {}),
    ...(typeof value.structuredOutput === 'boolean' ? { structuredOutput: value.structuredOutput } : {}),
    ...(parameters?.length ? { supportedParameters: parameters } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export async function loadBuyerMaxPricingDefaults(configPath: string): Promise<BuyerMaxPricingDefaults> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const buyer = asPlainObject(parsed.buyer);
    const maxPricing = asPlainObject(buyer?.maxPricing);
    const defaults = asPlainObject(maxPricing?.defaults);
    const input = normalizeNonNegativeNumber(defaults?.inputUsdPerMillion);
    const output = normalizeNonNegativeNumber(defaults?.outputUsdPerMillion);
    const cachedInput = normalizeNonNegativeNumber(defaults?.cachedInputUsdPerMillion);
    return {
      inputUsdPerMillion: input ?? DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
      outputUsdPerMillion: output ?? DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
      ...(cachedInput != null ? { cachedInputUsdPerMillion: cachedInput } : {}),
    };
  } catch {
    return {
      inputUsdPerMillion: DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
      outputUsdPerMillion: DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
    };
  }
}

export function isPriceAllowedByBuyerMax(
  inputUsdPerMillion: number | null | undefined,
  outputUsdPerMillion: number | null | undefined,
  cachedInputUsdPerMillion: number | null | undefined,
  maxPricing: BuyerMaxPricingDefaults,
): boolean {
  if (inputUsdPerMillion != null && inputUsdPerMillion > maxPricing.inputUsdPerMillion) {
    return false;
  }
  if (outputUsdPerMillion != null && outputUsdPerMillion > maxPricing.outputUsdPerMillion) {
    return false;
  }
  if (cachedInputUsdPerMillion != null) {
    if (inputUsdPerMillion != null && cachedInputUsdPerMillion > inputUsdPerMillion) {
      return false;
    }
    const maxCachedInput = maxPricing.cachedInputUsdPerMillion ?? maxPricing.inputUsdPerMillion;
    if (cachedInputUsdPerMillion > maxCachedInput) {
      return false;
    }
  }
  return true;
}

export function isCatalogEntryAllowedByBuyerMax(
  entry: ChatServiceCatalogEntry,
  maxPricing: BuyerMaxPricingDefaults,
): boolean {
  return isPriceAllowedByBuyerMax(
    entry.inputUsdPerMillion,
    entry.outputUsdPerMillion,
    entry.cachedInputUsdPerMillion,
    maxPricing,
  );
}

export function updateServiceProviderHints(
  serviceProviderHints: Map<string, string[]>,
  entries: ChatServiceCatalogEntry[],
): void {
  serviceProviderHints.clear();
  for (const entry of entries) {
    const serviceId = normalizeServiceValue(entry.id)?.toLowerCase();
    const provider = normalizeProviderId(entry.provider);
    if (!serviceId || !provider || !isChatServiceProtocol(entry.protocol)) {
      continue;
    }
    const providers = serviceProviderHints.get(serviceId) ?? [];
    if (!providers.includes(provider)) {
      providers.push(provider);
      serviceProviderHints.set(serviceId, providers);
    }
  }
}

export function updateServiceProtocolMap(
  serviceProtocolMap: Map<string, ChatServiceProtocol>,
  entries: ChatServiceCatalogEntry[],
): void {
  serviceProtocolMap.clear();
  for (const entry of entries) {
    const serviceId = normalizeServiceValue(entry.id)?.toLowerCase();
    if (!serviceId || !isChatServiceProtocol(entry.protocol)) continue;
    // First entry wins — the catalog is sorted by popularity (count desc)
    if (!serviceProtocolMap.has(serviceId)) {
      serviceProtocolMap.set(serviceId, entry.protocol);
    }
  }
}

export function normalizeChatServiceCatalogEntry(raw: unknown): ChatServiceCatalogEntry | null {
  const entry = asPlainObject(raw);
  if (!entry) {
    return null;
  }

  const id = normalizeServiceValue(entry.id);
  const provider = normalizeProviderId(entry.provider);
  const protocol = entry.protocol;
  if (!id || !provider || (protocol !== 'openai-images' && !isChatServiceProtocol(protocol))) {
    return null;
  }

  const count = Number(entry.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
  const label = normalizeServiceValue(entry.label) ?? id;
  const peerId = typeof entry.peerId === 'string' ? entry.peerId.trim() : undefined;
  const peerLabel = typeof entry.peerLabel === 'string' ? entry.peerLabel.trim() : undefined;
  const inputUsd = normalizeOptionalNumber(entry.inputUsdPerMillion);
  const outputUsd = normalizeOptionalNumber(entry.outputUsdPerMillion);
  const cachedInputUsd = normalizeOptionalNumber(entry.cachedInputUsdPerMillion);
  const minImageUsd = normalizeOptionalNumber(entry.minImageUsdPerImage);
  const maxImageUsd = normalizeOptionalNumber(entry.maxImageUsdPerImage);
  const categories = Array.isArray(entry.categories) ? entry.categories.filter((c): c is string => typeof c === 'string') : undefined;
  const description = typeof entry.description === 'string' ? entry.description.trim() : undefined;
  const capabilities = normalizeCatalogServiceCapabilities(entry.capabilities);
  const effectiveReputationScore = normalizeOptionalNumber(entry.effectiveReputationScore);
  return {
    id,
    label,
    provider,
    protocol,
    ...(capabilities ? { capabilities } : {}),
    count: normalizedCount,
    ...(peerId ? { peerId } : {}),
    ...(peerLabel ? { peerLabel } : {}),
    ...(effectiveReputationScore != null && effectiveReputationScore >= 0 ? { effectiveReputationScore } : {}),
    ...(inputUsd != null && inputUsd >= 0 ? { inputUsdPerMillion: inputUsd } : {}),
    ...(outputUsd != null && outputUsd >= 0 ? { outputUsdPerMillion: outputUsd } : {}),
    ...(cachedInputUsd != null && cachedInputUsd >= 0 ? { cachedInputUsdPerMillion: cachedInputUsd } : {}),
    ...(minImageUsd != null && minImageUsd >= 0 ? { minImageUsdPerImage: minImageUsd } : {}),
    ...(maxImageUsd != null && maxImageUsd >= 0 ? { maxImageUsdPerImage: maxImageUsd } : {}),
    ...(categories?.length ? { categories } : {}),
    ...(description ? { description } : {}),
  };
}

export function normalizeChatServiceCatalogEntries(rawEntries: unknown[]): ChatServiceCatalogEntry[] {
  const deduped = new Map<string, ChatServiceCatalogEntry>();
  for (const rawEntry of rawEntries) {
    const entry = normalizeChatServiceCatalogEntry(rawEntry);
    if (!entry) {
      continue;
    }
    const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}\u0000${entry.peerId ?? ''}`;
    const existing = deduped.get(key);
    if (existing) {
      existing.count = Math.max(existing.count, entry.count);
      continue;
    }
    deduped.set(key, { ...entry });
  }
  return sortChatServiceCatalogEntries([...deduped.values()]);
}

export function limitChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  if (entries.length <= CHAT_SERVICE_MAX_OPTIONS) {
    return entries;
  }

  const limited: ChatServiceCatalogEntry[] = [];
  const perProviderCount = new Map<string, number>();
  for (const entry of entries) {
    const provider = entry.provider;
    const providerCount = perProviderCount.get(provider) ?? 0;
    if (providerCount >= CHAT_SERVICE_MAX_OPTIONS_PER_PROVIDER) {
      continue;
    }
    limited.push(entry);
    perProviderCount.set(provider, providerCount + 1);
    if (limited.length >= CHAT_SERVICE_MAX_OPTIONS) {
      break;
    }
  }

  return limited;
}

export type BuyerStateDiscoveredPeer = {
  onChainAgentId: number | null;
  onChainStakeUsdcMicros: number | null;
  onChainChannelCount: number | null;
  onChainGhostCount: number | null;
  onChainTotalVolumeUsdcMicros: number | null;
  onChainLastSettledAtSec: number | null;
  onChainReputationScore: number | null;
  onChainTrustScore: number | null;
  onChainSybilRisk: number | null;
  onChainSybilFlags: string[];
  sellerContract?: string;
  verificationLinks: DiscoverVerificationLink[];
  peerIconUrl: string | null;
};

export function invalidateOnChainEnrichmentCache(): void {
  // On-chain enrichment now comes from the buyer daemon's buyer.state.json.
  // The desktop process intentionally performs no staking/channel RPC here.
}

export async function buildDiscoverRows(
  catalog: ChatServiceCatalogEntry[],
  peerStats: Map<string, {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
  }>,
  buyerStateDiscoveredPeers: Record<string, BuyerStateDiscoveredPeer>,
  networkStats: Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>,
  peerHealth: Record<string, RawPeerHealth> = {},
): Promise<DiscoverRowEntry[]> {
  const rows: DiscoverRowEntry[] = [];
  for (const entry of catalog) {
    const peerId = entry.peerId ?? '';
    if (!peerId) continue;
    const peerEvmAddress = '0x' + peerId;
    const peerBlob = buyerStateDiscoveredPeers[peerId];
    const sellerHex = typeof peerBlob?.sellerContract === 'string' ? peerBlob.sellerContract.trim().toLowerCase().replace(/^0x/, '') : '';
    const sellerEvmAddress = /^[0-9a-f]{40}$/.test(sellerHex) ? `0x${sellerHex}` : peerEvmAddress;

    const stats = peerStats.get(peerId);
    const agentId = peerBlob?.onChainAgentId ?? 0;
    const stakeUsdc = String(peerBlob?.onChainStakeUsdcMicros ?? 0);
    const onChainActiveChannelCount = peerBlob?.onChainChannelCount ?? 0;
    const onChainGhostCount = peerBlob?.onChainGhostCount ?? 0;
    const onChainTotalVolumeUsdc = String(peerBlob?.onChainTotalVolumeUsdcMicros ?? 0);
    const onChainLastSettledAt = peerBlob?.onChainLastSettledAtSec ?? 0;
    const onChainReputationScore = peerBlob?.onChainReputationScore ?? null;
    const onChainTrustScore = peerBlob?.onChainTrustScore ?? null;
    const onChainSybilRisk = peerBlob?.onChainSybilRisk ?? null;
    const onChainSybilFlags = peerBlob?.onChainSybilFlags ?? [];
    const netForAgent = agentId > 0 ? networkStats.get(agentId) ?? null : null;
    const networkRequests = netForAgent ? netForAgent.requests.toString() : null;
    const networkInputTokens = netForAgent ? netForAgent.inputTokens.toString() : null;
    const networkOutputTokens = netForAgent ? netForAgent.outputTokens.toString() : null;
    const health = readPeerHealth(peerHealth[peerId], Date.now());

    rows.push({
      rowKey: `${peerId}:${entry.id}`,
      serviceId: entry.id,
      serviceLabel: entry.label,
      categories: entry.categories ?? [],
      provider: entry.provider,
      protocol: entry.protocol,
      capabilities: entry.capabilities ?? null,
      peerId,
      peerEvmAddress,
      sellerEvmAddress,
      sellerContract: /^[0-9a-f]{40}$/.test(sellerHex) ? `0x${sellerHex}` : null,
      verificationLinks: peerBlob?.verificationLinks ?? [],
      peerIconUrl: peerBlob?.peerIconUrl ?? null,
      peerDisplayName: entry.peerLabel?.split(' (')[0] ?? null,
      peerLabel: entry.peerLabel ?? peerId.slice(0, 12) + '...',
      inputUsdPerMillion: entry.inputUsdPerMillion ?? null,
      outputUsdPerMillion: entry.outputUsdPerMillion ?? null,
      cachedInputUsdPerMillion: entry.cachedInputUsdPerMillion ?? null,
      minImageUsdPerImage: entry.minImageUsdPerImage ?? null,
      maxImageUsdPerImage: entry.maxImageUsdPerImage ?? null,
      lifetimeSessions: stats?.totalSessions ?? 0,
      lifetimeRequests: stats?.totalRequests ?? 0,
      lifetimeInputTokens: stats?.totalInputTokens ?? 0,
      lifetimeOutputTokens: stats?.totalOutputTokens ?? 0,
      lifetimeFirstSessionAt: stats?.firstSessionAt ?? null,
      lifetimeLastSessionAt: stats?.lastSessionAt ?? null,
      onChainChannelCount: peerBlob?.onChainChannelCount ?? null,
      agentId,
      stakeUsdc,
      onChainActiveChannelCount,
      onChainGhostCount,
      onChainTotalVolumeUsdc,
      onChainLastSettledAt,
      onChainReputationScore,
      onChainTrustScore,
      effectiveReputationScore: entry.effectiveReputationScore ?? null,
      onChainSybilRisk,
      onChainSybilFlags,
      networkRequests,
      networkInputTokens,
      networkOutputTokens,
      peerCooldownUntil: health.cooldownUntil,
      peerFailureStreak: health.failureStreak,
      peerLastFailureReason: health.lastFailureReason,
      selectionValue: `${entry.provider}\u0001${entry.id}\u0001${peerId}`,
    });
  }
  return rows;
}
