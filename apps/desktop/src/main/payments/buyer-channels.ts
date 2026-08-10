/**
 * Payment channels and usage totals as read back from the buyer daemon, plus
 * the on-chain enrichment the Credits view needs (channel status, and spend
 * authorized but not yet settled).
 */
import { ChannelsClient, type CloseChannelResultPayload } from '@antseed/node';
import { LOCALHOST_URL } from '../constants.js';
import { pendingSpendFromChannels } from '../billing/credits-balance.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { getCachedChannelsClient, loadCachedCryptoConfig, setCachedChannelsClient } from './credits.js';
import {
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
} from './channel-control.js';

export {
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
} from './channel-control.js';

/** Per-service usage from the buyer daemon. `serviceIdHash` is
    keccak256(serviceName); `serviceName` is resolved by the main process from
    the buyer's peer cache (null when the name is no longer advertised). */
export type DesktopBuyerServiceUsage = {
  serviceIdHash: string;
  serviceName: string | null;
  amountUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  requestCount: number;
};

export type DesktopBuyerUsageTotals = {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
  services: DesktopBuyerServiceUsage[];
};

export type DesktopPaymentChannelSummary = {
  channelId: string;
  peerId: string;
  seller: string;
  reserveMax: string;
  cumulativeSigned: string;
  /** Amount the seller has already settled on-chain (base units). Filled by
      enrichChannelStatuses; '0' until the channel is checked against chain. */
  settledUsdc: string;
  reservedAt: number;
  status: string;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
  cooperativeCloseSupported: boolean;
};

export type DesktopRewardsSummary = {
  available: boolean;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
  error: string | null;
};

export const MAX_SPENDING_AUTH_BASE_UNITS = 5_000_000n;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const EMPTY_BUYER_USAGE_TOTALS: DesktopBuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  services: [],
};

export const EMPTY_REWARDS_SUMMARY: DesktopRewardsSummary = {
  available: false,
  pendingAnts: '0',
  currentEpoch: null,
  transfersEnabled: false,
  error: null,
};

function readNumberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function readStringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function normalizeBuyerServiceUsage(value: unknown): DesktopBuyerServiceUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const serviceIdHash = readStringField(raw, 'serviceIdHash');
  if (!serviceIdHash) return null;
  return {
    serviceIdHash,
    serviceName: null,
    amountUsdc: readStringField(raw, 'amountUsdc') || '0',
    inputTokens: readStringField(raw, 'inputTokens') || '0',
    cachedInputTokens: readStringField(raw, 'cachedInputTokens') || '0',
    outputTokens: readStringField(raw, 'outputTokens') || '0',
    requestCount: readNumberField(raw, 'requestCount'),
  };
}

export function normalizeBuyerUsageTotals(value: unknown): DesktopBuyerUsageTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_BUYER_USAGE_TOTALS;
  }
  const raw = value as Record<string, unknown>;
  const services = Array.isArray(raw.services)
    ? raw.services.map(normalizeBuyerServiceUsage).filter((s): s is DesktopBuyerServiceUsage => s !== null)
    : [];
  return {
    totalRequests: readNumberField(raw, 'totalRequests'),
    totalInputTokens: readStringField(raw, 'totalInputTokens') || '0',
    totalOutputTokens: readStringField(raw, 'totalOutputTokens') || '0',
    totalSettlements: readNumberField(raw, 'totalSettlements'),
    uniqueSellers: readNumberField(raw, 'uniqueSellers'),
    activeChannels: readNumberField(raw, 'activeChannels'),
    services,
  };
}

export async function requestCooperativeChannelClose(peerId: string): Promise<CloseChannelResultPayload> {
  const port = await resolveBuyerProxyPort();
  return requestCooperativeChannelCloseAtPort(port, peerId);
}

export async function fetchBuyerProxyJson(pathname: string): Promise<Record<string, unknown> | null> {
  const port = await resolveBuyerProxyPort();
  try {
    const response = await fetch(`${LOCALHOST_URL}:${port}${pathname}`);
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function formatAnts(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = value % 1_000_000_000_000_000_000n;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${padded.slice(0, 6)}`;
}



// AntseedChannels grace period between requestClose() and withdraw().
const CHANNEL_CLOSE_GRACE_SECS = 900;
// Bound the on-chain enrichment fan-out per refresh.
const CHANNEL_ENRICH_MAX = 12;

// The local ChannelStore can lag the chain (a seller-side settle/close is not
// always observed), so rows that look active are re-checked on-chain before
// the activity view offers a Close action on a dead channel.
async function enrichChannelStatuses(channels: DesktopPaymentChannelSummary[]): Promise<void> {
  const cc = await loadCachedCryptoConfig();
  if (!cc?.channelsAddress) return;
  let client = getCachedChannelsClient();
  if (!client) {
    client = new ChannelsClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: cc.channelsAddress,
      evmChainId: cc.chainId,
    });
    setCachedChannelsClient(client);
  }
  const candidates = channels
    .filter((row) => row.status === 'active' || row.status === 'open')
    .slice(0, CHANNEL_ENRICH_MAX);
  await Promise.allSettled(candidates.map(async (row) => {
    const info = await client.getSession(row.channelId);
    const closeRequestedAt = Number(info.closeRequestedAt);
    row.settledUsdc = info.settled.toString();
    if (info.status === 2) row.status = 'settled';
    else if (info.status === 3) row.status = 'timedout';
    else if (info.status === 1 && closeRequestedAt > 0) {
      const now = Math.floor(Date.now() / 1000);
      row.status = now < closeRequestedAt + CHANNEL_CLOSE_GRACE_SECS ? 'closing' : 'withdrawable';
    }
    // status 0 (no on-chain record) is ambiguous — a channel may exist
    // locally before its on-chain reserve lands. Keep the local status.
  }));
}

/** Fetch buyer channels from the local proxy and re-check them on-chain. */
export async function loadBuyerChannels(all: boolean): Promise<DesktopPaymentChannelSummary[] | null> {
  const body = await fetchBuyerProxyJson(`/_antseed/channels${all ? '?all=1' : ''}`);
  if (!body) return null;
  const channels = Array.isArray(body['channels'])
    ? body['channels']
      .map((entry) => normalizePaymentChannelSummary(entry))
      .filter((entry): entry is DesktopPaymentChannelSummary => entry !== null)
    : [];
  await enrichChannelStatuses(channels).catch(() => {});
  return channels;
}

// Pending spend rides on the credits poll, which runs every 60s normally and
// every 5s while the payment card is up. Cache it so the fast poll reuses one
// buyer-proxy round trip plus its channel reads instead of repeating them.
const PENDING_SPEND_TTL_MS = 20_000;
let cachedPendingSpend = 0n;
let cachedPendingSpendAt = 0;

export function notePendingSpend(channels: readonly DesktopPaymentChannelSummary[]): bigint {
  cachedPendingSpend = pendingSpendFromChannels(channels);
  cachedPendingSpendAt = Date.now();
  return cachedPendingSpend;
}

/**
 * Signed-but-unsettled spend across the buyer's open channels. Falls back to
 * the last known value when the buyer proxy is unreachable — dropping to 0
 * there would silently inflate the displayed balance.
 */
export async function getPendingSpendUsdc(): Promise<bigint> {
  if (Date.now() - cachedPendingSpendAt < PENDING_SPEND_TTL_MS) return cachedPendingSpend;
  const channels = await loadBuyerChannels(false).catch(() => null);
  if (!channels) return cachedPendingSpend;
  return notePendingSpend(channels);
}
