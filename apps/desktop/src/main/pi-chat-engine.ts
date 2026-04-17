import type { IpcMain } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { browserPreviewTool, startDevServerTool } from './chat-dev-tools.js';
import { webFetchTool } from './chat-web-fetch.js';
import { fetchNetworkStats } from './fetch-network-stats.js';
import { buildAntstationSystemPrompt } from './chat-system-prompt.js';
import {
  CHAT_DATA_DIR,
  CHAT_WORKSPACE_DIR,
  getCurrentChatWorkspaceDir,
  getWorkspaceGitStatus,
  loadChatWorkspaceDir,
  persistChatWorkspaceDir,
} from './chat-workspace.js';
import { asErrorMessage } from './utils.js';
import { StakingClient, ChannelsClient, resolveChainConfig } from '@antseed/node';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
  Usage,
} from '@mariozechner/pi-ai';

type TextBlock = { type: 'text'; text: string };
type ThinkingBlock = { type: 'thinking'; thinking: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  details?: Record<string, unknown>;
};
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

type AiMessageMeta = {
  peerId?: string;
  peerAddress?: string;
  peerProviders?: string[];
  peerReputation?: number;
  peerTrustScore?: number;
  peerCurrentLoad?: number;
  peerMaxConcurrency?: number;
  provider?: string;
  service?: string;
  requestId?: string;
  routeRequestId?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenSource?: 'usage' | 'estimated' | 'unknown';
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  estimatedCostUsd?: number;
};

type AiChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  createdAt?: number;
  meta?: AiMessageMeta;
};

type AiUsageTotals = {
  inputTokens: number;
  outputTokens: number;
};

type AiConversation = {
  id: string;
  title: string;
  service: string;
  provider?: string;
  peerId?: string;
  peerLabel?: string;
  messages: AiChatMessage[];
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
};

type AiConversationSummary = {
  id: string;
  title: string;
  service: string;
  provider?: string;
  peerId?: string;
  peerLabel?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
  totalTokens: number;
  totalEstimatedCostUsd: number;
};

type RegisterPiChatHandlersOptions = {
  ipcMain: IpcMain;
  sendToRenderer: (channel: string, payload: unknown) => void;
  configPath: string;
  isBuyerRuntimeRunning: () => boolean;
  ensureBuyerRuntimeStarted?: () => Promise<boolean>;
  appendSystemLog: (line: string) => void;
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>;
};

type SessionPathInfo = {
  path: string;
  id: string;
};

type ActiveRun = {
  conversationId: string;
  session: AgentSession;
  unsubscribe: () => void;
};

type NetworkPeerAddress = {
  peerId?: string;
  displayName?: string;
  host: string;
  port: number;
  providers?: string[];
  services?: string[];
  providerServiceApiProtocols?: Record<string, { services: Record<string, string[]> }>;
  providerPricing?: Record<string, { services: Record<string, { input: number; output: number }> }>;
  providerServiceCategories?: Record<string, { services: Record<string, string[]> }>;
  defaultInputUsdPerMillion?: number;
  defaultOutputUsdPerMillion?: number;
};

type ChatServiceProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

type ChatServiceCatalogEntry = {
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

type DiscoverRowEntry = {
  rowKey: string;
  serviceId: string;
  serviceLabel: string;
  categories: string[];
  provider: string;
  protocol: ChatServiceProtocol;
  peerId: string;
  peerEvmAddress: string;
  peerDisplayName: string | null;
  peerLabel: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  lifetimeSessions: number;
  lifetimeRequests: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeFirstSessionAt: number | null;
  lifetimeLastSessionAt: number | null;
  onChainChannelCount: number | null;
  agentId: number;
  stakeUsdc: string;
  stakedAt: number;
  onChainActiveChannelCount: number;
  onChainGhostCount: number;
  onChainTotalVolumeUsdc: string;
  onChainLastSettledAt: number;
  networkRequests: string | null;
  networkInputTokens: string | null;
  networkOutputTokens: string | null;
  selectionValue: string;
};

const CHAT_SESSIONS_DIR = path.join(CHAT_DATA_DIR, 'sessions');
const CHAT_AGENT_DIR = path.join(CHAT_DATA_DIR, 'pi-agent');

const DEFAULT_PROXY_PORT = 8377;
const DEFAULT_CHAT_SERVICE = 'claude-sonnet-4-20250514';
const PROXY_PROVIDER_ID = 'antseed-proxy';
const PROXY_RUNTIME_API_KEY = 'antseed-local';

const CHAT_SYSTEM_PROMPT_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT';
const CHAT_SYSTEM_PROMPT_FILE_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT_FILE';
const CHAT_SERVICE_SCAN_MAX_PEERS = 20;
const CHAT_SERVICE_MAX_OPTIONS = 120;
const CHAT_SERVICE_MAX_OPTIONS_PER_PROVIDER = 40;

function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}


function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function normalizeServiceId(service?: string): string {
  const trimmed = String(service ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CHAT_SERVICE;
}

function isChatServiceProtocol(value: unknown): value is ChatServiceProtocol {
  return value === 'anthropic-messages'
    || value === 'openai-chat-completions'
    || value === 'openai-responses';
}

function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function inferProviderProtocol(provider: string): ChatServiceProtocol | null {
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

const VALID_CHAT_SERVICE_PROTOCOLS = new Set<string>([
  'anthropic-messages', 'openai-chat-completions', 'openai-responses',
]);

/**
 * Resolve protocol for a service from the peer's announced providerServiceApiProtocols metadata.
 * Returns the first recognized chat protocol, or null if not found.
 */
function resolveServiceProtocol(
  apiProtocols: NetworkPeerAddress['providerServiceApiProtocols'],
  serviceId: string,
): ChatServiceProtocol | null {
  if (!apiProtocols) return null;
  for (const providerEntry of Object.values(apiProtocols)) {
    const protocols = providerEntry?.services?.[serviceId];
    if (Array.isArray(protocols)) {
      for (const p of protocols) {
        if (VALID_CHAT_SERVICE_PROTOCOLS.has(p)) {
          return p as ChatServiceProtocol;
        }
      }
    }
  }
  return null;
}

function normalizeServiceValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const service = value.trim();
  return service.length > 0 ? service : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}



function updateServiceProviderHints(
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

function updateServiceProtocolMap(
  serviceProtocolMap: Map<string, ChatServiceProtocol>,
  entries: ChatServiceCatalogEntry[],
): void {
  serviceProtocolMap.clear();
  for (const entry of entries) {
    const serviceId = normalizeServiceValue(entry.id)?.toLowerCase();
    if (!serviceId) continue;
    // First entry wins — the catalog is sorted by popularity (count desc)
    if (!serviceProtocolMap.has(serviceId)) {
      serviceProtocolMap.set(serviceId, entry.protocol);
    }
  }
}

function resolveProviderHintForService(
  explicitProvider?: string,
): string | null {
  const explicit = normalizeProviderId(explicitProvider);
  return explicit ?? null;
}

function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const peerId = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(peerId) ? peerId : null;
}

function normalizeChatServiceCatalogEntry(raw: unknown): ChatServiceCatalogEntry | null {
  const entry = asRecord(raw);
  if (!entry) {
    return null;
  }

  const id = normalizeServiceValue(entry.id);
  const provider = normalizeProviderId(entry.provider);
  const protocol = entry.protocol;
  if (!id || !provider || !isChatServiceProtocol(protocol)) {
    return null;
  }

  const count = Number(entry.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
  const label = normalizeServiceValue(entry.label) ?? id;
  const peerId = typeof entry.peerId === 'string' ? entry.peerId.trim() : undefined;
  const peerLabel = typeof entry.peerLabel === 'string' ? entry.peerLabel.trim() : undefined;
  const inputUsd = normalizeOptionalNumber(entry.inputUsdPerMillion);
  const outputUsd = normalizeOptionalNumber(entry.outputUsdPerMillion);
  const categories = Array.isArray(entry.categories) ? entry.categories.filter((c): c is string => typeof c === 'string') : undefined;
  const description = typeof entry.description === 'string' ? entry.description.trim() : undefined;
  return {
    id,
    label,
    provider,
    protocol,
    count: normalizedCount,
    ...(peerId ? { peerId } : {}),
    ...(peerLabel ? { peerLabel } : {}),
    ...(inputUsd != null && inputUsd >= 0 ? { inputUsdPerMillion: inputUsd } : {}),
    ...(outputUsd != null && outputUsd >= 0 ? { outputUsdPerMillion: outputUsd } : {}),
    ...(categories?.length ? { categories } : {}),
    ...(description ? { description } : {}),
  };
}

function normalizeChatServiceCatalogEntries(rawEntries: unknown[]): ChatServiceCatalogEntry[] {
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

function sortChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
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

function limitChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
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

/**
 * Build the chat service catalog directly from peer data (already in buyer.state.json).
 * No HTTP metadata fetches needed — providers and services are in the peer list.
 */
async function discoverChatServiceCatalog(
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>,
): Promise<ChatServiceCatalogEntry[]> {
  // Read peers directly from buyer.state.json for immediate availability.
  // Falls back to the getNetworkPeers callback if the file isn't available.
  let peers: NetworkPeerAddress[] = [];
  try {
    const { readFile } = await import('node:fs/promises');
    const { DEFAULT_BUYER_STATE_PATH } = await import('./constants.js');
    const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawPeers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
    // Show every cached peer regardless of lastSeen — the sidebar already
    // surfaces them offline, and filtering here leaves Discover empty on
    // cold-start (e.g. laptop opened after overnight) until DHT rediscovers.
    peers = rawPeers
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => ({
        peerId: typeof p.peerId === 'string' ? p.peerId : '',
        displayName: typeof p.displayName === 'string' ? p.displayName : undefined,
        host: '',
        port: 0,
        providers: Array.isArray(p.providers) ? p.providers.map(String) : [],
        services: Array.isArray(p.services) ? p.services.map(String) : [],
        providerServiceApiProtocols: (p.providerServiceApiProtocols && typeof p.providerServiceApiProtocols === 'object')
          ? p.providerServiceApiProtocols as NetworkPeerAddress['providerServiceApiProtocols']
          : undefined,
        providerPricing: (p.providerPricing && typeof p.providerPricing === 'object')
          ? p.providerPricing as NetworkPeerAddress['providerPricing']
          : undefined,
        providerServiceCategories: (p.providerServiceCategories && typeof p.providerServiceCategories === 'object')
          ? p.providerServiceCategories as NetworkPeerAddress['providerServiceCategories']
          : undefined,
        defaultInputUsdPerMillion: typeof p.defaultInputUsdPerMillion === 'number' ? p.defaultInputUsdPerMillion : undefined,
        defaultOutputUsdPerMillion: typeof p.defaultOutputUsdPerMillion === 'number' ? p.defaultOutputUsdPerMillion : undefined,
      }))
      .filter((p) => p.peerId.length === 40); // EVM address peer IDs only (40 hex chars)
  } catch {
    // File not ready yet — try the callback
    if (!getNetworkPeers) return [];
    try {
      peers = await getNetworkPeers();
    } catch {
      return [];
    }
  }

  const results: ChatServiceCatalogEntry[] = [];
  for (const peer of peers.slice(0, CHAT_SERVICE_SCAN_MAX_PEERS)) {
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

    if (serviceList.length > 0) {
      // Use explicit service names when available.
      for (const serviceId of serviceList) {
        const provider = providerList[0] ?? 'unknown';
        // Resolve protocol: first check peer metadata, then fall back to inference from provider name.
        const protocol = resolveServiceProtocol(apiProtocols, serviceId) ?? inferProviderProtocol(provider);
        if (!protocol) continue;

        const providerPricing = pricingMap?.[provider]?.services?.[serviceId] as Record<string, unknown> | undefined;
        const inputUsd = (providerPricing?.inputUsdPerMillion as number | undefined) ?? (providerPricing?.input as number | undefined) ?? defaultInput;
        const outputUsd = (providerPricing?.outputUsdPerMillion as number | undefined) ?? (providerPricing?.output as number | undefined) ?? defaultOutput;
        const categories = categoriesMap?.[provider]?.services?.[serviceId];

        results.push({
          id: serviceId,
          label: serviceId,
          provider,
          protocol,
          count: 1,
          peerId,
          peerLabel,
          ...(inputUsd != null ? { inputUsdPerMillion: inputUsd } : {}),
          ...(outputUsd != null ? { outputUsdPerMillion: outputUsd } : {}),
          ...(categories?.length ? { categories } : {}),
        });
      }
    } else if (providerList.length > 0) {
      // No services listed — create one entry per provider as a fallback.
      for (const provider of providerList) {
        const protocol = inferProviderProtocol(provider);
        if (!protocol) continue;

        results.push({
          id: provider,
          label: provider,
          provider,
          protocol,
          count: 1,
          peerId,
          peerLabel,
          ...(defaultInput != null ? { inputUsdPerMillion: defaultInput } : {}),
          ...(defaultOutput != null ? { outputUsdPerMillion: defaultOutput } : {}),
        });
      }
    }
  }

  return sortChatServiceCatalogEntries(results);
}

type OnChainPeerEnrichment = {
  agentId: number;
  stakeUsdc: string;
  stakedAt: number;
  onChainActiveChannelCount: number;
  onChainGhostCount: number;
  onChainTotalVolumeUsdc: string;
  onChainLastSettledAt: number;
};

const ON_CHAIN_ENRICHMENT_TTL_MS = 2 * 60_000;
let onChainEnrichmentCache: Map<string, { fetchedAt: number; data: OnChainPeerEnrichment }> = new Map();

export function invalidateOnChainEnrichmentCache(): void {
  onChainEnrichmentCache.clear();
  cachedStakingClient = null;
  cachedChannelsClient = null;
}

let cachedStakingClient: StakingClient | null = null;
let cachedChannelsClient: ChannelsClient | null = null;

async function loadOnChainClients(configPath: string): Promise<{ stakingClient: StakingClient; channelsClient: ChannelsClient } | null> {
  if (cachedStakingClient && cachedChannelsClient) {
    return { stakingClient: cachedStakingClient, channelsClient: cachedChannelsClient };
  }
  let overrides: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payments = (parsed.payments && typeof parsed.payments === 'object') ? parsed.payments as Record<string, unknown> : {};
    overrides = (payments.crypto && typeof payments.crypto === 'object') ? payments.crypto as Record<string, unknown> : {};
  } catch {
    // No config — use defaults
  }
  const selectedChain = (typeof overrides.chainId === 'string' && overrides.chainId.trim().length > 0)
    ? overrides.chainId
    : 'base-mainnet';
  const userRpcUrl = typeof overrides.rpcUrl === 'string' && overrides.rpcUrl.trim().length > 0 ? overrides.rpcUrl : '';
  const cc = resolveChainConfig({
    chainId: selectedChain,
    ...(userRpcUrl ? { rpcUrl: userRpcUrl } : {}),
  });
  if (!cc.stakingContractAddress) return null;
  cachedStakingClient = new StakingClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.stakingContractAddress,
    usdcAddress: cc.usdcContractAddress,
    evmChainId: cc.evmChainId,
  });
  cachedChannelsClient = new ChannelsClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.channelsContractAddress,
    evmChainId: cc.evmChainId,
  });
  return { stakingClient: cachedStakingClient, channelsClient: cachedChannelsClient };
}

async function fetchOnChainEnrichment(
  peerEvmAddresses: string[],
  stakingClient: import('@antseed/node').StakingClient,
  channelsClient: import('@antseed/node').ChannelsClient,
): Promise<Map<string, OnChainPeerEnrichment>> {
  const now = Date.now();
  const out = new Map<string, OnChainPeerEnrichment>();
  const toFetch: string[] = [];

  for (const addr of peerEvmAddresses) {
    const cached = onChainEnrichmentCache.get(addr);
    if (cached && now - cached.fetchedAt < ON_CHAIN_ENRICHMENT_TTL_MS) {
      out.set(addr, cached.data);
    } else {
      toFetch.push(addr);
    }
  }

  await Promise.all(toFetch.map(async (addr) => {
    try {
      const [agentId, stake] = await Promise.all([
        stakingClient.getAgentId(addr),
        stakingClient.getStake(addr),
      ]);
      if (agentId === 0) {
        const sentinel: OnChainPeerEnrichment = {
          agentId: 0,
          stakeUsdc: '0',
          stakedAt: 0,
          onChainActiveChannelCount: 0,
          onChainGhostCount: 0,
          onChainTotalVolumeUsdc: '0',
          onChainLastSettledAt: 0,
        };
        onChainEnrichmentCache.set(addr, { fetchedAt: now, data: sentinel });
        out.set(addr, sentinel);
        return;
      }
      const stats = await channelsClient.getAgentStats(agentId);
      const data: OnChainPeerEnrichment = {
        agentId,
        stakeUsdc: stake.toString(),
        stakedAt: 0,
        onChainActiveChannelCount: stats.channelCount,
        onChainGhostCount: stats.ghostCount,
        onChainTotalVolumeUsdc: stats.totalVolumeUsdc.toString(),
        onChainLastSettledAt: stats.lastSettledAt,
      };
      onChainEnrichmentCache.set(addr, { fetchedAt: now, data });
      out.set(addr, data);
    } catch {
      // Leave out of the result map; row will be dropped by the caller.
    }
  }));

  return out;
}

async function buildDiscoverRows(
  catalog: ChatServiceCatalogEntry[],
  peerStats: Map<string, {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    firstSessionAt: number | null;
    lastSessionAt: number | null;
  }>,
  enrichment: Map<string, OnChainPeerEnrichment>,
  buyerStateDiscoveredPeers: Record<string, {
    onChainChannelCount: number | null;
    providerPricing?: Record<string, { services?: Record<string, { cachedInputUsdPerMillion?: number }> }>;
  }>,
  networkStats: Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>,
): Promise<DiscoverRowEntry[]> {
  const rows: DiscoverRowEntry[] = [];
  for (const entry of catalog) {
    const peerId = entry.peerId ?? '';
    if (!peerId) continue;
    const evmAddress = '0x' + peerId;
    const enrichmentRow = enrichment.get(evmAddress);
    if (!enrichmentRow || enrichmentRow.agentId === 0) continue;

    const stats = peerStats.get(peerId);
    const peerBlob = buyerStateDiscoveredPeers[peerId];
    const cachedPricingEntry = peerBlob?.providerPricing?.[entry.provider]?.services?.[entry.id];
    const cachedInputUsdPerMillion = Number.isFinite(cachedPricingEntry?.cachedInputUsdPerMillion)
      ? cachedPricingEntry!.cachedInputUsdPerMillion!
      : null;

    const netForAgent = enrichmentRow.agentId > 0
      ? networkStats.get(enrichmentRow.agentId) ?? null
      : null;
    const networkRequests = netForAgent ? netForAgent.requests.toString() : null;
    const networkInputTokens = netForAgent ? netForAgent.inputTokens.toString() : null;
    const networkOutputTokens = netForAgent ? netForAgent.outputTokens.toString() : null;

    rows.push({
      rowKey: `${peerId}:${entry.id}`,
      serviceId: entry.id,
      serviceLabel: entry.label,
      categories: entry.categories ?? [],
      provider: entry.provider,
      protocol: entry.protocol,
      peerId,
      peerEvmAddress: evmAddress,
      peerDisplayName: entry.peerLabel?.split(' (')[0] ?? null,
      peerLabel: entry.peerLabel ?? peerId.slice(0, 12) + '...',
      inputUsdPerMillion: entry.inputUsdPerMillion ?? null,
      outputUsdPerMillion: entry.outputUsdPerMillion ?? null,
      cachedInputUsdPerMillion,
      lifetimeSessions: stats?.totalSessions ?? 0,
      lifetimeRequests: stats?.totalRequests ?? 0,
      lifetimeInputTokens: stats?.totalInputTokens ?? 0,
      lifetimeOutputTokens: stats?.totalOutputTokens ?? 0,
      lifetimeFirstSessionAt: stats?.firstSessionAt ?? null,
      lifetimeLastSessionAt: stats?.lastSessionAt ?? null,
      onChainChannelCount: peerBlob?.onChainChannelCount ?? null,
      agentId: enrichmentRow.agentId,
      stakeUsdc: enrichmentRow.stakeUsdc,
      stakedAt: enrichmentRow.stakedAt,
      onChainActiveChannelCount: enrichmentRow.onChainActiveChannelCount,
      onChainGhostCount: enrichmentRow.onChainGhostCount,
      onChainTotalVolumeUsdc: enrichmentRow.onChainTotalVolumeUsdc,
      onChainLastSettledAt: enrichmentRow.onChainLastSettledAt,
      networkRequests,
      networkInputTokens,
      networkOutputTokens,
      selectionValue: `${entry.provider}\u0001${entry.id}\u0001${peerId}`,
    });
  }
  return rows;
}

function toUsage(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = normalizeTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count,
  );
  const output = normalizeTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  );
  const cacheRead = normalizeTokenCount(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite = normalizeTokenCount(usage.cacheWrite ?? usage.cache_creation_input_tokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? usage.total_tokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.input) ?? 0,
      output: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.output) ?? 0,
      cacheRead: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheRead) ?? 0,
      cacheWrite: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheWrite) ?? 0,
      total: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.total) ?? 0,
    },
  };
}

function mergeUsage(base: AiUsageTotals, delta: AiUsageTotals): AiUsageTotals {
  return {
    inputTokens: normalizeTokenCount(base.inputTokens) + normalizeTokenCount(delta.inputTokens),
    outputTokens: normalizeTokenCount(base.outputTokens) + normalizeTokenCount(delta.outputTokens),
  };
}

function ensureUsageShape(base?: Partial<Usage>): Usage {
  const initial = base ?? {};
  const usage = toUsage(initial);
  return usage;
}

function convertToolContentToText(content: Array<TextContent | { type: 'image'; mimeType: string; data: string }>): string {
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    parts.push(`[image:${block.mimeType}]`);
  }
  return parts.join('\n').trim();
}

function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertPiMessageToUiBlocks(message: Message): string | ContentBlock[] {
  if (message.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: block.thinking });
        continue;
      }
      if (block.type === 'toolCall') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }

  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return message.content;
    }
    // Preserve image blocks so the UI can render them
    const hasImage = message.content.some((block) => block.type === 'image');
    if (hasImage) {
      const blocks: ContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'image') {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: (block as ImageContent).mimeType, data: (block as ImageContent).data },
          } as unknown as ContentBlock);
        } else if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
        }
      }
      return blocks;
    }
    const textParts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
    }
    return textParts.join('\n').trim();
  }

  const toolResult = message as ToolResultMessage;
  return [{
    type: 'tool_result',
    tool_use_id: toolResult.toolCallId,
    content: convertToolContentToText(toolResult.content),
    is_error: toolResult.isError,
    details:
      toolResult.details && typeof toolResult.details === 'object'
        ? (toolResult.details as Record<string, unknown>)
        : undefined,
  }];
}

function convertPiMessagesToUi(messages: Message[]): AiChatMessage[] {
  const converted: AiChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: convertPiMessageToUiBlocks(message),
        createdAt: normalizeTokenCount(message.timestamp),
      });
      continue;
    }

    if (message.role === 'assistant') {
      converted.push(
        convertAssistantMessageForUi(
          message as AssistantMessage & { meta?: AiMessageMeta },
        ),
      );
      continue;
    }

    if (message.role === 'toolResult') {
      const toolResultBlocks = convertPiMessageToUiBlocks(message);
      const last = converted[converted.length - 1];
      const toolBlocks = Array.isArray(toolResultBlocks)
        ? toolResultBlocks.filter((entry): entry is ToolResultBlock => entry.type === 'tool_result')
        : [];
      if (
        last
        && last.role === 'user'
        && Array.isArray(last.content)
        && last.content.every((entry) => entry.type === 'tool_result')
        && toolBlocks.length > 0
      ) {
        last.content.push(...toolBlocks);
      } else {
        converted.push({
          role: 'user',
          content: toolBlocks,
          createdAt: normalizeTokenCount(message.timestamp),
        });
      }
    }
  }
  return converted;
}

function deriveUsage(messages: AiChatMessage[]): AiUsageTotals {
  let usage: AiUsageTotals = { inputTokens: 0, outputTokens: 0 };
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    usage = mergeUsage(usage, {
      inputTokens: normalizeTokenCount(message.meta?.inputTokens),
      outputTokens: normalizeTokenCount(message.meta?.outputTokens),
    });
  }
  return usage;
}

function deriveCost(messages: AiChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== 'assistant') {
      return sum;
    }
    const value = Number(message.meta?.estimatedCostUsd);
    if (!Number.isFinite(value) || value <= 0) {
      return sum;
    }
    return sum + value;
  }, 0);
}

function deriveTitle(messages: AiChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
    }
  }
  return 'New conversation';
}

function makeProxyService(
  serviceId: string,
  port: number,
  protocol: ChatServiceProtocol = 'anthropic-messages',
  providerHint?: string | null,
  preferredPeerId?: string | null,
  spendingAuth?: string | null,
): Model<any> {
  const headers: Record<string, string> = {};
  if (providerHint) headers['x-antseed-provider'] = providerHint;
  if (preferredPeerId) headers['x-antseed-pin-peer'] = preferredPeerId;
  if (spendingAuth) headers['x-antseed-spending-auth'] = spendingAuth;

  // The OpenAI SDK appends API paths (e.g. /responses, /chat/completions)
  // to baseUrl, so include /v1 to match the buyer proxy's expected paths.
  const needsV1 = protocol === 'openai-responses' || protocol === 'openai-chat-completions';
  const base = {
    id: serviceId,
    name: serviceId,
    provider: PROXY_PROVIDER_ID,
    baseUrl: needsV1 ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}`,
    reasoning: true,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    headers,
  };

  if (protocol === 'openai-chat-completions') {
    return {
      ...base,
      api: 'openai-completions' as const,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens' as const,
        supportsStrictMode: false,
      },
    };
  }

  if (protocol === 'openai-responses') {
    return {
      ...base,
      api: 'openai-responses' as const,
    };
  }

  return { ...base, api: 'anthropic-messages' as const };
}

function convertUserMessageForUi(message: Message): AiChatMessage {
  return {
    role: 'user',
    content: convertPiMessageToUiBlocks(message),
    createdAt: normalizeTokenCount((message as { timestamp?: number }).timestamp),
  };
}

function convertAssistantMessageForUi(
  message: AssistantMessage & { meta?: AiMessageMeta },
): AiChatMessage {
  const usage = ensureUsageShape(message.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: message.provider,
    service: message.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
  };
  const mergedMeta: AiMessageMeta = {
    ...usageMeta,
    ...(message.meta ?? {}),
  };
  return {
    role: 'assistant',
    content: convertPiMessageToUiBlocks(message),
    createdAt: normalizeTokenCount(message.timestamp),
    meta: mergedMeta,
  };
}

function mergeAssistantMessagesForUi(base: AiChatMessage | null, next: AiChatMessage): AiChatMessage {
  const toBlocks = (content: AiChatMessage['content']): ContentBlock[] => {
    if (Array.isArray(content)) {
      return content.map((block) => ({ ...block }));
    }
    const text = String(content ?? '');
    return text.length > 0 ? [{ type: 'text', text }] : [];
  };

  if (!base) {
    return next;
  }
  const baseContent = toBlocks(base.content);
  const nextContent = toBlocks(next.content);
  return {
    ...base,
    ...next,
    createdAt: base.createdAt || next.createdAt,
    meta: {
      ...(base.meta ?? {}),
      ...(next.meta ?? {}),
    },
    content: [...baseContent, ...nextContent],
  };
}

async function isPortReachable(port: number, timeoutMs = 700): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Math.floor(port) });

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function resolveProxyPort(configPath: string): Promise<number> {
  try {
    const raw = await stat(configPath);
    if (!raw.isFile()) {
      return DEFAULT_PROXY_PORT;
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { proxyPort?: unknown };
    };
    const configured = Number(parsed.buyer?.proxyPort);
    if (Number.isFinite(configured) && configured > 0 && configured <= 65535) {
      return Math.floor(configured);
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  return DEFAULT_PROXY_PORT;
}

function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveSystemPrompt(configPath: string): Promise<string | undefined> {
  const fromEnv = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_ENV]);
  if (fromEnv) {
    return fromEnv;
  }

  const promptPath = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_FILE_ENV]);
  if (promptPath) {
    try {
      const fileText = await readFile(path.resolve(promptPath), 'utf8');
      const normalized = normalizePromptText(fileText);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Ignore invalid prompt files and continue to config fallback.
    }
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { chatSystemPrompt?: unknown };
    };
    return normalizePromptText(parsed.buyer?.chatSystemPrompt);
  } catch {
    return undefined;
  }
}

function extractToolCallFromPartial(
  partial: AssistantMessage,
  contentIndex: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const block = partial.content[contentIndex];
  if (!block || block.type !== 'toolCall') {
    return {
      id: `tool-${String(contentIndex)}`,
      name: 'tool',
      arguments: {},
    };
  }
  return {
    id: block.id || `tool-${String(contentIndex)}`,
    name: block.name || 'tool',
    arguments: (block.arguments ?? {}) as Record<string, unknown>,
  };
}

const ANTSEED_PEER_CUSTOM_TYPE = 'antseed:peer';

type AntseedPeerData = { peerId: string; peerLabel?: string };

function extractPeerFromEntries(manager: SessionManager): AntseedPeerData | null {
  const entries = manager.getEntries();
  // Walk backwards to find the latest antseed:peer custom entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === 'custom' && 'customType' in entry && entry.customType === ANTSEED_PEER_CUSTOM_TYPE) {
      const data = (entry as { data?: unknown }).data as AntseedPeerData | undefined;
      if (data?.peerId) return data;
    }
  }
  return null;
}

class PiConversationStore {
  private readonly sessionsDir = CHAT_SESSIONS_DIR;
  private readonly ready: Promise<void>;
  private readonly pathCache = new Map<string, string>();
  private readonly pendingManagers = new Map<string, SessionManager>();

  constructor() {
    this.ready = this.ensureDirs();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(CHAT_AGENT_DIR, { recursive: true });
  }

  private async ensureWorkspaceDir(): Promise<string> {
    await this.ready;
    const workspaceDir = getCurrentChatWorkspaceDir();
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async listSessionPaths(): Promise<SessionPathInfo[]> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const sessions = await SessionManager.list(workspaceDir, this.sessionsDir);
    const infos = sessions.map((entry) => ({ id: entry.id, path: entry.path }));
    this.pathCache.clear();
    for (const info of infos) {
      this.pathCache.set(info.id, info.path);
    }
    return infos;
  }

  private async buildConversationFromManager(manager: SessionManager): Promise<AiConversation> {
    const context = manager.buildSessionContext();
    const messages = convertPiMessagesToUi(context.messages as Message[]);
    const usage = deriveUsage(messages);
    const header = manager.getHeader();
    const createdAtRaw = header ? Date.parse(header.timestamp) : Date.now();
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
    const latestMessageAt = messages.reduce((max, message) => {
      const ts = normalizeTokenCount(message.createdAt);
      return ts > max ? ts : max;
    }, 0);

    let updatedAt = Math.max(createdAt, latestMessageAt);
    const sessionPath = manager.getSessionFile();
    if (sessionPath && existsSync(sessionPath)) {
      try {
        const fileStat = await stat(sessionPath);
        updatedAt = Math.max(updatedAt, Math.floor(fileStat.mtimeMs));
      } catch {
        // Keep the computed updatedAt when stat fails.
      }
    } else {
      updatedAt = Math.max(updatedAt, Date.now());
    }

    const peerData = extractPeerFromEntries(manager);
    return {
      id: manager.getSessionId(),
      title: manager.getSessionName() || deriveTitle(messages),
      service: normalizeServiceId(context.model?.modelId),
      provider: normalizeProviderId(context.model?.provider) ?? undefined,
      messages,
      createdAt,
      updatedAt,
      usage,
      ...(peerData?.peerId ? { peerId: peerData.peerId } : {}),
      ...(peerData?.peerLabel ? { peerLabel: peerData.peerLabel } : {}),
    };
  }

  private async resolvePath(id: string): Promise<string | null> {
    await this.ready;
    const cached = this.pathCache.get(id);
    if (cached && existsSync(cached)) {
      return cached;
    }
    const all = await this.listSessionPaths();
    const found = all.find((entry) => entry.id === id);
    return found?.path ?? null;
  }

  private async readConversationFromPath(sessionPath: string): Promise<AiConversation | null> {
    try {
      const manager = SessionManager.open(sessionPath, this.sessionsDir);
      return await this.buildConversationFromManager(manager);
    } catch {
      return null;
    }
  }

  async list(): Promise<AiConversationSummary[]> {
    const sessionPaths = await this.listSessionPaths();
    const summaryById = new Map<string, AiConversationSummary>();
    for (const info of sessionPaths) {
      const conversation = await this.readConversationFromPath(info.path);
      if (!conversation) {
        continue;
      }
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
        ...(conversation.peerId ? { peerId: conversation.peerId } : {}),
        ...(conversation.peerLabel ? { peerLabel: conversation.peerLabel } : {}),
      });
    }

    for (const [conversationId, manager] of this.pendingManagers.entries()) {
      if (summaryById.has(conversationId)) {
        continue;
      }
      const conversation = await this.buildConversationFromManager(manager);
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
      });
    }

    return [...summaryById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<AiConversation | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return await this.buildConversationFromManager(pending);
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return await this.readConversationFromPath(sessionPath);
  }

  async create(service?: string, provider?: string): Promise<AiConversation> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const manager = SessionManager.create(workspaceDir, this.sessionsDir);
    const providerId = normalizeProviderId(provider);
    const modelProvider = providerId ?? PROXY_PROVIDER_ID;
    manager.appendModelChange(modelProvider, normalizeServiceId(service));
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) {
      throw new Error('Failed to create persisted pi session');
    }
    const conversation = await this.buildConversationFromManager(manager);
    this.pendingManagers.set(conversation.id, manager);
    this.pathCache.set(conversation.id, sessionPath);
    return conversation;
  }

  async setPeer(id: string, peerId: string, peerLabel?: string): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, { peerId, peerLabel } satisfies AntseedPeerData);
  }

  async delete(id: string): Promise<void> {
    const pending = this.pendingManagers.get(id);
    const pendingPath = pending?.getSessionFile() ?? null;
    this.pendingManagers.delete(id);

    const sessionPath = (await this.resolvePath(id)) ?? pendingPath;
    if (!sessionPath) {
      this.pathCache.delete(id);
      return;
    }
    try {
      await unlink(sessionPath);
    } catch {
      // Session may already be deleted.
    }
    this.pathCache.delete(id);
  }

  async openSessionManager(id: string): Promise<SessionManager | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return pending;
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return SessionManager.open(sessionPath, this.sessionsDir);
  }

  markPersistedIfAvailable(id: string): void {
    const pending = this.pendingManagers.get(id);
    if (!pending) {
      return;
    }
    const sessionPath = pending.getSessionFile();
    if (!sessionPath) {
      return;
    }
    if (!existsSync(sessionPath)) {
      return;
    }
    this.pendingManagers.delete(id);
    this.pathCache.set(id, sessionPath);
  }
}

function toToolOutputString(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const result = value as { content?: Array<{ type?: string; text?: string; mimeType?: string }> };
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''));
    } else {
      parts.push(`[image:${String(block.mimeType ?? 'unknown')}]`);
    }
  }
  return parts.join('\n').trim();
}

function parseAssistantMetaFromSessionEvent(
  assistant: AssistantMessage,
  proxyMeta: AiMessageMeta | undefined,
): AiMessageMeta {
  const usage = ensureUsageShape(assistant.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: assistant.provider,
    service: assistant.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
    estimatedCostUsd: usage.cost.total > 0 ? usage.cost.total : undefined,
  };
  const merged: AiMessageMeta = {
    ...usageMeta,
    ...(proxyMeta ?? {}),
  };
  if (!merged.tokenSource || merged.tokenSource === 'unknown') {
    merged.tokenSource = usageMeta.tokenSource;
  }
  if (!merged.totalTokens || merged.totalTokens <= 0) {
    merged.totalTokens = totalTokens;
  }
  if (!merged.inputTokens || merged.inputTokens <= 0) {
    merged.inputTokens = usage.input;
  }
  if (!merged.outputTokens || merged.outputTokens <= 0) {
    merged.outputTokens = usage.output;
  }
  return merged;
}

function normalizePaymentBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.peerId) return body;
  const inner = body.error;
  if (typeof inner === 'object' && inner !== null) {
    const innerObj = inner as Record<string, unknown>;
    if (innerObj.peerId) {
      return { ...body, peerId: innerObj.peerId };
    }
  }
  return body;
}


function toConversationTitle(userMessage: string): string {
  const normalized = userMessage.trim();
  if (normalized.length === 0) {
    return 'New conversation';
  }
  return normalized.slice(0, 60) + (normalized.length > 60 ? '...' : '');
}

export function registerPiChatHandlers({
  ipcMain,
  sendToRenderer,
  configPath,
  isBuyerRuntimeRunning,
  ensureBuyerRuntimeStarted,
  appendSystemLog,
  getNetworkPeers,
}: RegisterPiChatHandlersOptions): void {
  void loadChatWorkspaceDir().catch(() => {});
  const store = new PiConversationStore();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const serviceProviderHints = new Map<string, string[]>();
  /** Cached payment-required info from 402 responses, keyed by conversationId. */
  const cachedPaymentRequired = new Map<string, Record<string, unknown>>();
  const serviceProtocolMap = new Map<string, ChatServiceProtocol>();
  const preferredPeerByConversationId = new Map<string, string>();

  const cacheFallbackPaymentRequired = (conversationId: string, suggestedAmount: string): void => {
    const peerId = preferredPeerByConversationId.get(conversationId) ?? null;
    if (!peerId) {
      return;
    }
    const existing = cachedPaymentRequired.get(conversationId) ?? {};
    cachedPaymentRequired.set(conversationId, {
      ...existing,
      peerId,
      suggestedAmount,
    });
  };

  const clearActiveRun = (run: ActiveRun | null): void => {
    if (!run) {
      return;
    }

    try {
      run.unsubscribe();
    } catch {
      // Ignore listener cleanup failures.
    }

    try {
      run.session.dispose();
    } catch {
      // Ignore disposal races.
    }

    if (activeRunsByConversation.get(run.conversationId) === run) {
      activeRunsByConversation.delete(run.conversationId);
    }
  };

  const abortAndClearActiveRun = async (run: ActiveRun | null): Promise<void> => {
    if (!run) {
      return;
    }

    try {
      await run.session.abort();
    } catch {
      // Ignore abort races.
    }

    clearActiveRun(run);
  };

  const isProxyAvailable = async (port: number): Promise<boolean> => {
    return await isPortReachable(port);
  };

  const waitForBuyerProxy = async (port: number, timeoutMs = 20_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await isProxyAvailable(port)) {
          return true;
        }
      } catch {
        // transient error — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  const runStreamingPrompt = async (
    conversationId: string,
    userMessage: string,
    serviceOverride?: string,
    providerOverride?: string,
    imageBase64?: string,
    imageMimeType?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const trimmedMessage = userMessage.trim();
    if (trimmedMessage.length === 0 && !imageBase64) {
      return { ok: false, error: 'Empty message' };
    }

    const existingRun = activeRunsByConversation.get(conversationId);
    if (existingRun) {
      appendSystemLog(
        `Cancelling existing in-flight chat request for conversation ${existingRun.conversationId.slice(0, 8)}...`,
      );
      await abortAndClearActiveRun(existingRun);
    }

    const proxyPort = await resolveProxyPort(configPath);
    const runtimeRunning = isBuyerRuntimeRunning();
    let proxyAvailable = await isProxyAvailable(proxyPort);
    if (!proxyAvailable && ensureBuyerRuntimeStarted) {
      if (runtimeRunning) {
        appendSystemLog(`Buyer runtime is running. Waiting for proxy :${proxyPort}...`);
      } else {
        appendSystemLog(`Buyer proxy offline on port ${proxyPort}; attempting to start Buyer runtime...`);
      }
      try {
        const started = runtimeRunning ? true : await ensureBuyerRuntimeStarted();
        if (started) {
          if (!runtimeRunning) {
            appendSystemLog(`Buyer runtime start requested. Waiting for proxy :${proxyPort}...`);
          }
          proxyAvailable = await waitForBuyerProxy(proxyPort);
        }
      } catch (error) {
        appendSystemLog(`Buyer runtime auto-start failed: ${asErrorMessage(error)}`);
      }
    }
    if (!proxyAvailable) {
      return {
        ok: false,
        error: `Buyer proxy is not reachable on port ${proxyPort}. Start Buyer runtime or fix buyer.proxyPort in config.`,
      };
    }

    const sessionManager = await store.openSessionManager(conversationId);
    if (!sessionManager) {
      return { ok: false, error: 'Conversation not found' };
    }

    const context = sessionManager.buildSessionContext();

    const serviceId = normalizeServiceId(serviceOverride || context.model?.modelId);
    const preferredPeerId = preferredPeerByConversationId.get(conversationId) ?? null;
    const providerHint = resolveProviderHintForService(
      providerOverride,
    );
    const protocol = await resolveProtocolForSend(serviceId);
    const proxyModel = makeProxyService(serviceId, proxyPort, protocol, providerHint, preferredPeerId, null);

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROXY_PROVIDER_ID, PROXY_RUNTIME_API_KEY);
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    // Pass the system prompt via resourceLoader so it is applied on every turn.
    // (agent-session rebuilds _baseSystemPrompt from the loader each turn, so a
    // one-shot session.agent.setSystemPrompt call would be overridden.)
    // Priority: user override (env/config) → AntStation default.
    const userSystemPrompt = await resolveSystemPrompt(configPath);
    const chatWorkspaceDir = getCurrentChatWorkspaceDir();
    const settingsManager = SettingsManager.create(chatWorkspaceDir, CHAT_AGENT_DIR);
    const resourceLoader = new DefaultResourceLoader({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      settingsManager,
      systemPrompt: buildAntstationSystemPrompt(userSystemPrompt),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: chatWorkspaceDir,
      agentDir: CHAT_AGENT_DIR,
      sessionManager,
      authStorage,
      modelRegistry,
      model: proxyModel,
      customTools: [webFetchTool, browserPreviewTool, startDevServerTool],
      resourceLoader,
    });

    // Activate all tools. Pi defaults to only [read, bash, edit, write] —
    // without this, other tools are missing from the API tool list, causing
    // the model to emit raw XML tool calls instead of structured tool_use.
    session.setActiveToolsByName([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
      'web_fetch', 'open_browser_preview', 'start_dev_server',
    ]);

    await session.setModel(proxyModel);
    session.agent.sessionId = conversationId;

    const existingUserMessages = session.messages.filter((message) => message.role === 'user').length;
    if (existingUserMessages === 0 && (!session.sessionName || session.sessionName.trim().length === 0)) {
      session.setSessionName(toConversationTitle(trimmedMessage));
    }

    const turnMetaQueue: AiMessageMeta[] = [];
    const toolArgsById = new Map<string, Record<string, unknown>>();
    // Pi's native streaming handles all API formats (anthropic-messages,
    // openai-completions, openai-responses) via model.api + model.baseUrl.
    // No custom streamFn needed — the buyer proxy at model.baseUrl is a
    // transparent HTTP proxy that speaks the same API as the upstream provider.

    let turnIndex = 0;
    let userPersisted = false;
    let streamDone = false;
    let pendingAssistantMessage: AiChatMessage | null = null;

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'turn_start') {
        sendToRenderer('chat:ai-stream-start', { conversationId, turn: turnIndex });
        turnIndex += 1;
        return;
      }

      if (event.type === 'message_update') {
        const message = event.message as Message;
        if (message.role !== 'assistant') {
          return;
        }
        const update = event.assistantMessageEvent as AssistantMessageEvent;
        if (update.type === 'text_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'text_delta') {
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'text_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'text',
          });
          return;
        }
        if (update.type === 'thinking_start') {
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'thinking_delta') {
          sendToRenderer('chat:ai-stream-delta', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
            text: update.delta,
          });
          return;
        }
        if (update.type === 'thinking_end') {
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'thinking',
          });
          return;
        }
        if (update.type === 'toolcall_start') {
          const tool = extractToolCallFromPartial(update.partial, update.contentIndex);
          if (isToolArgumentsObject(tool.arguments)) {
            toolArgsById.set(tool.id, tool.arguments);
          }
          sendToRenderer('chat:ai-stream-block-start', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: tool.id,
            toolName: tool.name,
          });
          return;
        }
        if (update.type === 'toolcall_end') {
          const toolInput = isToolArgumentsObject(update.toolCall.arguments)
            ? update.toolCall.arguments
            : {};
          toolArgsById.set(update.toolCall.id, toolInput);
          sendToRenderer('chat:ai-stream-block-stop', {
            conversationId,
            index: update.contentIndex,
            blockType: 'tool_use',
            toolId: update.toolCall.id,
            toolName: update.toolCall.name,
            input: toolInput,
          });
        }
        return;
      }

      if (event.type === 'tool_execution_start') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        if (eventArgs) {
          toolArgsById.set(event.toolCallId, eventArgs);
        }
        sendToRenderer('chat:ai-tool-executing', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
        });
        return;
      }

      if (event.type === 'tool_execution_update') {
        const eventArgs = isToolArgumentsObject(event.args) ? event.args : undefined;
        sendToRenderer('chat:ai-tool-update', {
          conversationId,
          toolUseId: event.toolCallId,
          name: event.toolName,
          input: eventArgs ?? toolArgsById.get(event.toolCallId) ?? {},
          output: toToolOutputString(event.partialResult),
          details:
            event.partialResult &&
            typeof event.partialResult === 'object' &&
            'details' in event.partialResult &&
            event.partialResult.details &&
            typeof event.partialResult.details === 'object'
              ? (event.partialResult.details as Record<string, unknown>)
              : undefined,
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        toolArgsById.delete(event.toolCallId);
        const details =
          event.result &&
          typeof event.result === 'object' &&
          'details' in event.result &&
          event.result.details &&
          typeof event.result.details === 'object'
            ? (event.result.details as Record<string, unknown>)
            : undefined;
        sendToRenderer('chat:ai-tool-result', {
          conversationId,
          toolUseId: event.toolCallId,
          output: toToolOutputString(event.result),
          isError: Boolean(event.isError),
          details,
        });

        // Auto-open browser preview panel when a preview tool completes successfully
        if (
          !event.isError &&
          (event.toolName === 'open_browser_preview' || event.toolName === 'start_dev_server')
        ) {
          const url = typeof details?.url === 'string' ? details.url : undefined;
          if (url) {
            sendToRenderer('browser-preview:open', { url });
          }
        }
        return;
      }

      if (event.type === 'message_end') {
        const message = event.message as Message | (AssistantMessage & { meta?: AiMessageMeta });
        if (message.role === 'user' && !userPersisted) {
          userPersisted = true;
          sendToRenderer('chat:ai-user-persisted', {
            conversationId,
            message: convertUserMessageForUi(message),
          });
          return;
        }
        if (message.role === 'assistant') {
          // Detect payment errors from the provider's 402 JSON response
          const msgAny = message as unknown as Record<string, unknown>;
          const errorMsg = typeof msgAny.errorMessage === 'string' ? msgAny.errorMessage : '';
          const rawContent = Array.isArray(msgAny.content)
            ? (msgAny.content as Array<Record<string, unknown>>).map((b) => String(b.text ?? '')).join('')
            : String(msgAny.content ?? '');

          // Check errorMessage first (Pi agent may put "402 {"error":"payment_required",...}" there)
          if (/402.*payment_required|payment_required/i.test(errorMsg) || /402.*payment_required|payment_required/i.test(rawContent)) {
            // Try to parse the full payment body from content, errorMessage, or embedded JSON
            let paymentBody: Record<string, unknown> | null = null;
            try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
            if (!paymentBody) {
              try { paymentBody = JSON.parse(errorMsg) as Record<string, unknown>; } catch { /* not JSON */ }
            }
            // SDK wraps the body as "402 {json}" — extract the embedded JSON
            if (!paymentBody) {
              const jsonStart = errorMsg.indexOf('{');
              if (jsonStart >= 0) {
                try { paymentBody = JSON.parse(errorMsg.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
              }
            }
            if (paymentBody) paymentBody = normalizePaymentBody(paymentBody);
            const suggestedAmount = typeof paymentBody?.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            if (paymentBody?.peerId) {
              cachedPaymentRequired.set(conversationId, paymentBody);
            } else {
              cacheFallbackPaymentRequired(conversationId, suggestedAmount);
            }
            sendToRenderer('chat:ai-stream-error', {
              conversationId,
              error: `payment_required:${suggestedAmount}`,
            });
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          // Also check if the response body itself is a payment_required JSON
          let paymentBody: Record<string, unknown> | null = null;
          try { paymentBody = JSON.parse(rawContent) as Record<string, unknown>; } catch { /* not JSON */ }
          if (paymentBody?.error === 'payment_required') {
            paymentBody = normalizePaymentBody(paymentBody);
            const suggestedAmount = typeof paymentBody.suggestedAmount === 'string'
              ? paymentBody.suggestedAmount : '100000';
            // Cache payment info so the approve IPC handler can build the SpendingAuth
            cachedPaymentRequired.set(conversationId, paymentBody);
            sendToRenderer('chat:ai-stream-error', {
              conversationId,
              error: `payment_required:${suggestedAmount}`,
            });
            const activeRun = activeRunsByConversation.get(conversationId);
            if (activeRun) void abortAndClearActiveRun(activeRun);
            return;
          }

          const proxyMeta = turnMetaQueue.shift();
          const parsedMeta = parseAssistantMetaFromSessionEvent(message, proxyMeta);
          const peerId = normalizePeerId(parsedMeta.peerId);
          if (peerId) {
            const prevPeerId = preferredPeerByConversationId.get(conversationId);
            preferredPeerByConversationId.set(conversationId, peerId);
            // Persist peer to session file if it's new or changed
            if (peerId !== prevPeerId) {
              const peerLabel = lastServiceCatalogEntries.find((e) => e.peerId === peerId)?.peerLabel;
              void store.setPeer(conversationId, peerId, peerLabel);
            }
          }
          const assistantMessage = message as AssistantMessage & { meta?: AiMessageMeta };
          assistantMessage.meta = parsedMeta;
          pendingAssistantMessage = mergeAssistantMessagesForUi(
            pendingAssistantMessage,
            convertAssistantMessageForUi(assistantMessage),
          );
        }
        return;
      }

      if (event.type === 'agent_end') {
        // Don't finalize here — auto-retry may follow with a new agent_start.
        // The post-session.prompt code handles final chat:ai-done / chat:ai-stream-done.
      }
    });

    const run: ActiveRun = { conversationId, session, unsubscribe };
    activeRunsByConversation.set(conversationId, run);

    try {
      const images: ImageContent[] = imageBase64 && imageMimeType
        ? [{ type: 'image', data: imageBase64, mimeType: imageMimeType }]
        : [];
      await session.prompt(trimmedMessage || ' ', { images: images.length > 0 ? images : undefined });

      // Check if the agent received a 402 payment_required response.
      // The node returns JSON with "error":"payment_required" which the agent
      // treats as a completed turn with empty/error content.
      if (pendingAssistantMessage) {
        const lastMsg = pendingAssistantMessage as AiChatMessage;
        const c = lastMsg.content;
        const lastText = typeof c === 'string' ? c : Array.isArray(c)
          ? c.map((b) => typeof b === 'object' && b !== null && 'text' in b ? String(b.text) : '').join('')
          : '';
        let payBody: Record<string, unknown> | null = null;
        try { payBody = JSON.parse(lastText) as Record<string, unknown>; } catch { /* not JSON */ }
        if (payBody?.error === 'payment_required') {
          payBody = normalizePaymentBody(payBody);
          const amt = typeof payBody.suggestedAmount === 'string' ? payBody.suggestedAmount : '100000';
          if (payBody.peerId) {
            cachedPaymentRequired.set(conversationId, payBody);
          } else {
            cacheFallbackPaymentRequired(conversationId, amt);
          }
          pendingAssistantMessage = null;
          sendToRenderer('chat:ai-stream-error', {
            conversationId,
            error: `payment_required:${amt}`,
          });
          return { ok: false, error: 'Payment required' };
        }
      }

      if (pendingAssistantMessage) {
        sendToRenderer('chat:ai-done', {
          conversationId,
          message: pendingAssistantMessage,
        });
        pendingAssistantMessage = null;
      }
      if (!streamDone) {
        streamDone = true;
        sendToRenderer('chat:ai-stream-done', { conversationId });
      }
      return { ok: true };
    } catch (error) {
      // Always discard any buffered assistant message on error — it will not be committed.
      pendingAssistantMessage = null;
      if ((error as Error).name === 'AbortError') {
        sendToRenderer('chat:ai-stream-error', { conversationId, error: 'Request aborted' });
        return { ok: false, error: 'Aborted' };
      }
      const message = asErrorMessage(error);
      // Map insufficient balance / 402 errors to payment_required format
      // so the renderer shows the Add Credits card
      const isPaymentError = /insufficient.*balance|escrow.*balance|402.*payment/i.test(message);
      if (isPaymentError) {
        // Try to extract the payment_required JSON from the error message (SDK wraps it as "402 {json}")
        let payBody: Record<string, unknown> | null = null;
        const jsonStart = message.indexOf('{');
        if (jsonStart >= 0) {
          try { payBody = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>; } catch { /* not JSON */ }
        }
        if (payBody) payBody = normalizePaymentBody(payBody);
        const amt = typeof payBody?.suggestedAmount === 'string' ? payBody.suggestedAmount : '100000';
        if (payBody?.peerId) {
          cachedPaymentRequired.set(conversationId, payBody);
        } else {
          const peerId = preferredPeerByConversationId.get(conversationId) ?? '';
          cachedPaymentRequired.set(conversationId, {
            ...(payBody ?? {}),
            peerId,
            suggestedAmount: amt,
          });
        }
        sendToRenderer('chat:ai-stream-error', { conversationId, error: `payment_required:${amt}` });
      } else {
        sendToRenderer('chat:ai-stream-error', { conversationId, error: message });
      }
      appendSystemLog(`Pi chat error: ${message}`);
      return { ok: false, error: message };
    } finally {
      clearActiveRun(run);
      store.markPersistedIfAvailable(conversationId);
    }
  };

  let lastServiceCatalogEntries: ChatServiceCatalogEntry[] = [];
  let lastServiceCatalogRefreshAt = 0;
  const SERVICE_CATALOG_DEBOUNCE_MS = 5_000;
  let serviceCatalogRefreshPromise: Promise<ChatServiceCatalogEntry[]> | null = null;

  const refreshServiceCatalogFromNetwork = async (): Promise<ChatServiceCatalogEntry[]> => {
    // Deduplicate concurrent calls
    if (serviceCatalogRefreshPromise) return serviceCatalogRefreshPromise;
    // Debounce rapid calls (e.g. UI refreshes)
    if (Date.now() - lastServiceCatalogRefreshAt < SERVICE_CATALOG_DEBOUNCE_MS && lastServiceCatalogEntries.length > 0) {
      return lastServiceCatalogEntries;
    }

    serviceCatalogRefreshPromise = (async () => {
      const entries = await discoverChatServiceCatalog(getNetworkPeers);
      const limited = limitChatServiceCatalogEntries(normalizeChatServiceCatalogEntries(entries));
      updateServiceProviderHints(serviceProviderHints, limited);
      updateServiceProtocolMap(serviceProtocolMap, limited);
      lastServiceCatalogRefreshAt = Date.now();
      lastServiceCatalogEntries = limited;
      return limited;
    })().finally(() => { serviceCatalogRefreshPromise = null; });

    return serviceCatalogRefreshPromise;
  };

  const resolveProtocolForSend = async (serviceId: string): Promise<ChatServiceProtocol> => {
    const normalizedServiceId = serviceId.trim().toLowerCase();
    const existing = serviceProtocolMap.get(normalizedServiceId);
    if (existing) {
      return existing;
    }

    const refreshed = await refreshServiceCatalogFromNetwork();
    return refreshed.find((entry) => entry.id.trim().toLowerCase() === normalizedServiceId)?.protocol ?? 'anthropic-messages';
  };

  ipcMain.handle('chat:ai-get-proxy-status', async () => {
    const port = await resolveProxyPort(configPath);
    const running = await isProxyAvailable(port);
    return {
      ok: true,
      data: {
        running,
        port,
      },
    };
  });

  ipcMain.handle('api:try-proxy-request', async (
    _event,
    params: { port: number; path: string; method: string; headers: Record<string, string>; body: string },
  ) => {
    try {
      const url = `http://127.0.0.1:${params.port}${params.path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(url, {
        method: params.method || 'POST',
        headers: params.headers || {},
        body: params.body || undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      return { ok: true, status: res.status, body: text, error: null as string | null };
    } catch (e) {
      const err = e as Error;
      return { ok: false, status: 0, body: '', error: err?.message ?? String(e) };
    }
  });

  ipcMain.handle('chat:ai-list-discover-rows', async () => {
    try {
      const entries = await refreshServiceCatalogFromNetwork();

      const buyerPort = await resolveProxyPort(configPath);
      const statsMap = new Map<string, {
        totalSessions: number;
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        firstSessionAt: number | null;
        lastSessionAt: number | null;
      }>();
      // Per-peer lifetime metering. The buyer-proxy exposes
      // /_antseed/metering/<peerId>; fetch in parallel for every catalog peer.
      const uniqueCatalogPeerIds = Array.from(new Set(
        entries.map((e) => e.peerId ?? '').filter((p) => p.length > 0)
      ));
      await Promise.all(uniqueCatalogPeerIds.map(async (peerId) => {
        try {
          const resp = await fetch(
            `http://127.0.0.1:${buyerPort}/_antseed/metering/${encodeURIComponent(peerId)}`,
          );
          if (!resp.ok) return;
          const body = await resp.json() as Record<string, unknown> | null;
          if (!body || typeof body !== 'object') return;
          const sessions = Number(body.lifetimeSessions) || 0;
          const reqs = Number(body.lifetimeRequests) || 0;
          const inTok = Number(body.lifetimeInputTokens) || 0;
          const outTok = Number(body.lifetimeOutputTokens) || 0;
          const firstAt = typeof body.lifetimeFirstSessionAt === 'number' ? body.lifetimeFirstSessionAt : null;
          const lastAt = typeof body.lifetimeLastSessionAt === 'number' ? body.lifetimeLastSessionAt : null;
          if (sessions === 0 && reqs === 0 && inTok === 0 && outTok === 0 && firstAt == null && lastAt == null) return;
          statsMap.set(peerId, {
            totalSessions: sessions,
            totalRequests: reqs,
            totalInputTokens: inTok,
            totalOutputTokens: outTok,
            firstSessionAt: firstAt,
            lastSessionAt: lastAt,
          });
        } catch {
          // Ignore — peer simply has no metering info
        }
      }));

      const { readFile } = await import('node:fs/promises');
      const { DEFAULT_BUYER_STATE_PATH } = await import('./constants.js');
      let discoveredPeersMap: Record<string, {
        onChainChannelCount: number | null;
        providerPricing?: Record<string, { services?: Record<string, { cachedInputUsdPerMillion?: number }> }>;
      }> = {};
      try {
        const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const arr = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
        for (const p of arr) {
          if (p && typeof p === 'object' && typeof (p as { peerId?: unknown }).peerId === 'string') {
            const rec = p as Record<string, unknown>;
            discoveredPeersMap[rec.peerId as string] = {
              onChainChannelCount: typeof rec.onChainChannelCount === 'number' ? rec.onChainChannelCount : null,
              providerPricing: rec.providerPricing as Record<string, {
                services?: Record<string, { cachedInputUsdPerMillion?: number }>
              }> | undefined,
            };
          }
        }
      } catch {
        // No state file yet
      }

      const uniqueAddresses = Array.from(new Set(
        entries
          .map((e) => (e.peerId ? '0x' + e.peerId : ''))
          .filter((a) => a.length === 42)
      ));
      const clients = await loadOnChainClients(configPath);
      if (!clients) {
        return { ok: true, data: [] as DiscoverRowEntry[] };
      }
      const { stakingClient, channelsClient } = clients;
      const enrichment = await fetchOnChainEnrichment(uniqueAddresses, stakingClient, channelsClient);

      // Network-wide stats from @antseed/network-stats. On non-mainnet chains and on any
      // failure this returns an empty map and buildDiscoverRows falls back to local stats.
      const networkStats = await (async () => {
        try {
          const raw = await readFile(configPath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const payments = (parsed.payments && typeof parsed.payments === 'object') ? parsed.payments as Record<string, unknown> : {};
          const overrides = (payments.crypto && typeof payments.crypto === 'object') ? payments.crypto as Record<string, unknown> : {};
          const selectedChain = (typeof overrides.chainId === 'string' && overrides.chainId.trim().length > 0)
            ? overrides.chainId
            : 'base-mainnet';
          const cc = resolveChainConfig({ chainId: selectedChain });
          return await fetchNetworkStats(cc.networkStatsUrl);
        } catch {
          return new Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>();
        }
      })();

      const rows = await buildDiscoverRows(entries, statsMap, enrichment, discoveredPeersMap, networkStats);
      return { ok: true, data: rows };
    } catch (error) {
      return { ok: false, data: [] as DiscoverRowEntry[], error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const conversations = await store.list();
    // Enrich summaries: prefer in-memory peer, fall back to persisted
    const enriched = conversations.map((c) => {
      const memPeerId = preferredPeerByConversationId.get(c.id);
      const peerId = memPeerId || c.peerId;
      if (peerId && !preferredPeerByConversationId.has(c.id)) {
        // Warm the in-memory cache from persisted data
        preferredPeerByConversationId.set(c.id, peerId);
      }
      return peerId ? { ...c, peerId } : c;
    });
    return { ok: true, data: enriched };
  });

  ipcMain.handle('chat:ai-get-workspace', async () => {
    const workspaceDir = await loadChatWorkspaceDir();
    return {
      ok: true,
      data: {
        current: workspaceDir,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-workspace-git-status', async () => {
    try {
      const workspaceDir = await loadChatWorkspaceDir();
      return {
        ok: true,
        data: await getWorkspaceGitStatus(workspaceDir),
      };
    } catch (error) {
      return {
        ok: false,
        error: asErrorMessage(error),
      };
    }
  });

  ipcMain.handle('chat:ai-set-workspace', async (_event, workspaceDir: string) => {
    const current = await persistChatWorkspaceDir(workspaceDir);
    return {
      ok: true,
      data: {
        current,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    const peerId = preferredPeerByConversationId.get(id);
    const enriched = peerId ? { ...conversation, peerId } : conversation;
    return { ok: true, data: enriched };
  });

  ipcMain.handle('chat:ai-create-conversation', async (_event, service: string, provider?: string, peerId?: string) => {
    const conversation = await store.create(service, provider);
    const trimmedPeerId = peerId?.trim() ?? '';
    if (trimmedPeerId) {
      preferredPeerByConversationId.set(conversation.id, trimmedPeerId);
      // Resolve peer label from service options
      const peerLabel = lastServiceCatalogEntries.find((e) => e.peerId === trimmedPeerId)?.peerLabel;
      await store.setPeer(conversation.id, trimmedPeerId, peerLabel);
    } else {
      preferredPeerByConversationId.delete(conversation.id);
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    preferredPeerByConversationId.delete(id);
    cachedPaymentRequired.delete(id);
    await store.delete(id);
    return { ok: true };
  });

  ipcMain.handle('chat:ai-rename-conversation', async (_event, id: string, title: string) => {
    const manager = await store.openSessionManager(id);
    if (!manager) {
      return { ok: false, error: 'Conversation not found' };
    }
    manager.appendSessionInfo(title.trim());
    return { ok: true };
  });

  ipcMain.handle(
    'chat:ai-send-stream',
    async (_event, conversationId: string, userMessage: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string) => {
      return await runStreamingPrompt(conversationId, userMessage, service, provider, imageBase64, imageMimeType);
    },
  );

  ipcMain.handle(
    'chat:ai-send',
    async (_event, conversationId: string, userMessage: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string) => {
      return await runStreamingPrompt(conversationId, userMessage, service, provider, imageBase64, imageMimeType);
    },
  );

  ipcMain.handle('chat:ai-abort', async (_event, conversationId?: string) => {
    const trimmedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
    const activeRuns = trimmedConversationId
      ? [activeRunsByConversation.get(trimmedConversationId)].filter((run): run is ActiveRun => Boolean(run))
      : Array.from(activeRunsByConversation.values());
    if (activeRuns.length === 0) {
      return { ok: true };
    }
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
    return { ok: true };
  });

  ipcMain.handle('chat:ai-select-peer', async (_event, peerId: string | null) => {
    const normalizedPeerId = peerId && peerId.trim().length > 0 ? peerId.trim() : null;
    if (!normalizedPeerId) {
      preferredPeerByConversationId.clear();
      return { ok: true };
    }
    // Eager connection warmup via buyer proxy
    const proxyPort = await resolveProxyPort(configPath);
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/_antseed/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId: normalizedPeerId }),
      });
      const result = await response.json() as { ok: boolean; error?: string };
      return { ok: result.ok, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  });

}
