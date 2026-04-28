import type { ChatServiceOptionEntry, DiscoverRow } from '../core/state';

const CHAT_SERVICE_SELECTION_SEPARATOR = '\u0001';

function toNullableBigintString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v).toString();
  if (typeof v === 'bigint') return v.toString();
  return null;
}

export function normalizeDiscoverRow(raw: unknown): DiscoverRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const peerId = String(r.peerId ?? '').trim();
  const serviceId = String(r.serviceId ?? '').trim();
  if (!peerId || !serviceId) return null;
  return {
    rowKey: String(r.rowKey ?? `${peerId}:${serviceId}`),
    serviceId,
    serviceLabel: String(r.serviceLabel ?? serviceId),
    categories: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === 'string') : [],
    provider: String(r.provider ?? 'unknown'),
    protocol: String(r.protocol ?? ''),
    peerId,
    peerEvmAddress: String(r.peerEvmAddress ?? ''),
    peerDisplayName: typeof r.peerDisplayName === 'string' ? r.peerDisplayName : null,
    peerLabel: String(r.peerLabel ?? ''),
    inputUsdPerMillion: typeof r.inputUsdPerMillion === 'number' ? r.inputUsdPerMillion : null,
    outputUsdPerMillion: typeof r.outputUsdPerMillion === 'number' ? r.outputUsdPerMillion : null,
    cachedInputUsdPerMillion: typeof r.cachedInputUsdPerMillion === 'number' ? r.cachedInputUsdPerMillion : null,
    lifetimeSessions: Number(r.lifetimeSessions) || 0,
    lifetimeRequests: Number(r.lifetimeRequests) || 0,
    lifetimeInputTokens: Number(r.lifetimeInputTokens) || 0,
    lifetimeOutputTokens: Number(r.lifetimeOutputTokens) || 0,
    lifetimeFirstSessionAt: typeof r.lifetimeFirstSessionAt === 'number' ? r.lifetimeFirstSessionAt : null,
    lifetimeLastSessionAt: typeof r.lifetimeLastSessionAt === 'number' ? r.lifetimeLastSessionAt : null,
    onChainChannelCount: typeof r.onChainChannelCount === 'number' ? r.onChainChannelCount : null,
    agentId: Number(r.agentId) || 0,
    stakeUsdc: String(r.stakeUsdc ?? '0'),
    stakedAt: Number(r.stakedAt) || 0,
    onChainActiveChannelCount: Number(r.onChainActiveChannelCount) || 0,
    onChainGhostCount: Number(r.onChainGhostCount) || 0,
    onChainTotalVolumeUsdc: String(r.onChainTotalVolumeUsdc ?? '0'),
    onChainLastSettledAt: Number(r.onChainLastSettledAt) || 0,
    networkRequests: toNullableBigintString(r.networkRequests),
    networkInputTokens: toNullableBigintString(r.networkInputTokens),
    networkOutputTokens: toNullableBigintString(r.networkOutputTokens),
    selectionValue: String(r.selectionValue ?? ''),
  };
}

export function projectRowsToChatServiceOptions(rows: DiscoverRow[]): ChatServiceOptionEntry[] {
  const grouped = new Map<string, ChatServiceOptionEntry>();
  for (const row of rows) {
    const key = `${row.provider}${CHAT_SERVICE_SELECTION_SEPARATOR}${row.serviceId}${CHAT_SERVICE_SELECTION_SEPARATOR}${row.peerId}`;
    if (grouped.has(key)) continue;
    grouped.set(key, {
      id: row.serviceId,
      label: row.serviceLabel,
      provider: row.provider,
      protocol: row.protocol,
      count: 1,
      value: row.selectionValue,
      peerId: row.peerId,
      peerDisplayName: row.peerDisplayName,
      peerLabel: row.peerLabel,
      inputUsdPerMillion: row.inputUsdPerMillion,
      outputUsdPerMillion: row.outputUsdPerMillion,
      categories: row.categories,
      description: '',
    });
  }
  return Array.from(grouped.values());
}
