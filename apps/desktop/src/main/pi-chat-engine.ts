import type { IpcMain } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from '@mariozechner/pi-coding-agent';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  StreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from '@mariozechner/pi-ai';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';

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
  model?: string;
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
  model: string;
  provider?: string;
  messages: AiChatMessage[];
  createdAt: number;
  updatedAt: number;
  usage: AiUsageTotals;
};

type AiConversationSummary = {
  id: string;
  title: string;
  model: string;
  provider?: string;
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
  host: string;
  port: number;
  providers?: string[];
};

type ChatModelProtocol = 'anthropic-messages' | 'openai-chat-completions';

type ChatModelCatalogEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: ChatModelProtocol;
  count: number;
};

const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
const CHAT_SESSIONS_DIR = path.join(CHAT_DATA_DIR, 'sessions');
const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
const CHAT_AGENT_DIR = path.join(CHAT_DATA_DIR, 'pi-agent');
const DEFAULT_PROXY_PORT = 8377;
const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const PROXY_PROVIDER_ID = 'antseed-proxy';
const PROXY_RUNTIME_API_KEY = 'antseed-local';
const CHAT_SYSTEM_PROMPT_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT';
const CHAT_SYSTEM_PROMPT_FILE_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT_FILE';
const CHAT_STREAM_TOTAL_TIMEOUT_ENV = 'ANTSEED_CHAT_STREAM_TOTAL_TIMEOUT_MS';
const CHAT_STREAM_IDLE_TIMEOUT_ENV = 'ANTSEED_CHAT_STREAM_IDLE_TIMEOUT_MS';
const DEFAULT_CHAT_STREAM_TOTAL_TIMEOUT_MS = 240_000;
const DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS = 45_000;
const CHAT_MODEL_METADATA_FETCH_TIMEOUT_MS = 2_500;
const CHAT_MODEL_SCAN_MAX_PEERS = 20;
const CHAT_MODEL_API_FETCH_TIMEOUT_MS = 3_500;
const CHAT_MODEL_SCAN_MAX_PROVIDERS = 12;
const CHAT_MODEL_MAX_OPTIONS = 120;
const CHAT_MODEL_MAX_OPTIONS_PER_PROVIDER = 40;
const CHAT_MODEL_CACHE_FILE = path.join(CHAT_DATA_DIR, 'model-catalog-cache.json');
const CHAT_MODEL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CHAT_MODEL_CACHE_REFRESH_DEBOUNCE_MS = 60_000;

function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function resolveTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), 1_000), 30 * 60 * 1_000);
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseTokenSource(value: unknown): AiMessageMeta['tokenSource'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'usage' || normalized === 'estimated') {
    return normalized;
  }
  return 'unknown';
}

function parseHeaderNumber(headers: Headers, key: string): number | undefined {
  const value = headers.get(key);
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseHeaderCsv(headers: Headers, key: string): string[] | undefined {
  const raw = headers.get(key);
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseProxyMeta(response: Response, requestStartedAt: number): AiMessageMeta {
  const peerIdRaw = response.headers.get('x-antseed-peer-id');
  const peerAddressRaw = response.headers.get('x-antseed-peer-address');
  const peerProvidersRaw = parseHeaderCsv(response.headers, 'x-antseed-peer-providers');
  const providerRaw = response.headers.get('x-antseed-provider');
  const modelRaw = response.headers.get('x-antseed-model');
  const requestIdRaw = response.headers.get('request-id') ?? response.headers.get('x-request-id');
  const routeRequestIdRaw = response.headers.get('x-antseed-request-id');

  const inputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-input-tokens'));
  const outputTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-output-tokens'));
  const headerTotalTokens = normalizeTokenCount(parseHeaderNumber(response.headers, 'x-antseed-total-tokens'));
  const totalTokens = headerTotalTokens > 0 ? headerTotalTokens : inputTokens + outputTokens;

  const inputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-input-usd-per-million'));
  const outputUsdPerMillion = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-output-usd-per-million'));
  const estimatedCostUsd = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-estimated-cost-usd'));
  const peerReputation = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-reputation'));
  const peerTrustScore = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-trust-score'));
  const peerCurrentLoad = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-current-load'));
  const peerMaxConcurrency = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-peer-max-concurrency'));
  const latencyFromHeader = normalizeOptionalNumber(parseHeaderNumber(response.headers, 'x-antseed-latency-ms'));

  const latencyMs = latencyFromHeader !== undefined
    ? Math.max(0, Math.floor(latencyFromHeader))
    : Math.max(0, Date.now() - requestStartedAt);

  return {
    peerId: typeof peerIdRaw === 'string' && peerIdRaw.trim().length > 0 ? peerIdRaw.trim() : undefined,
    peerAddress: typeof peerAddressRaw === 'string' && peerAddressRaw.trim().length > 0 ? peerAddressRaw.trim() : undefined,
    peerProviders: peerProvidersRaw,
    peerReputation,
    peerTrustScore,
    peerCurrentLoad,
    peerMaxConcurrency,
    provider: typeof providerRaw === 'string' && providerRaw.trim().length > 0 ? providerRaw.trim() : undefined,
    model: typeof modelRaw === 'string' && modelRaw.trim().length > 0 ? modelRaw.trim() : undefined,
    requestId: typeof requestIdRaw === 'string' && requestIdRaw.trim().length > 0 ? requestIdRaw.trim() : undefined,
    routeRequestId: typeof routeRequestIdRaw === 'string' && routeRequestIdRaw.trim().length > 0 ? routeRequestIdRaw.trim() : undefined,
    latencyMs,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource: parseTokenSource(response.headers.get('x-antseed-token-source')),
    inputUsdPerMillion,
    outputUsdPerMillion,
    estimatedCostUsd,
  };
}

function normalizeModelId(model?: string): string {
  const trimmed = String(model ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CHAT_MODEL;
}

function isChatModelProtocol(value: unknown): value is ChatModelProtocol {
  return value === 'anthropic-messages' || value === 'openai-chat-completions';
}

function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function inferProviderProtocol(provider: string): ChatModelProtocol | null {
  if (provider === 'openai' || provider === 'openrouter' || provider === 'local-llm') {
    return 'openai-chat-completions';
  }
  if (provider === 'anthropic' || provider === 'claude-code' || provider === 'claude-oauth') {
    return 'anthropic-messages';
  }
  return null;
}

function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const host = value.trim();
  return host.length > 0 ? host : null;
}

function isPublicMetadataHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase();
  if (host.length === 0 || host === 'localhost' || host.endsWith('.local') || host.includes('/') || host.includes('@')) {
    return false;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 4) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return false;
    }
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 0) return false;
    return true;
  }

  if (host === '::1' || host === '::' || host.startsWith('::ffff:')) {
    return false;
  }

  if (
    host.startsWith('fe80:') ||
    host.startsWith('fe81:') ||
    host.startsWith('fe82:') ||
    host.startsWith('fe83:') ||
    host.startsWith('fe84:') ||
    host.startsWith('fe85:') ||
    host.startsWith('fe86:') ||
    host.startsWith('fe87:') ||
    host.startsWith('fe88:') ||
    host.startsWith('fe89:') ||
    host.startsWith('fe8a:') ||
    host.startsWith('fe8b:') ||
    host.startsWith('fe8c:') ||
    host.startsWith('fe8d:') ||
    host.startsWith('fe8e:') ||
    host.startsWith('fe8f:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return false;
  }

  return true;
}

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isFinite(port)) {
    return null;
  }
  const normalized = Math.floor(port);
  if (normalized < 1 || normalized > 65535) {
    return null;
  }
  return normalized;
}

function normalizeModelValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const model = value.trim();
  return model.length > 0 ? model : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveProtocolForModel(
  provider: string,
  matrixRaw: unknown,
  modelId: string,
): ChatModelProtocol | null {
  const matrix = asRecord(matrixRaw);
  if (matrix) {
    const targetKey = modelId.trim().toLowerCase();
    for (const [key, value] of Object.entries(matrix)) {
      if (key.trim().toLowerCase() !== targetKey || !Array.isArray(value)) {
        continue;
      }
      for (const protocolCandidate of value) {
        if (isChatModelProtocol(protocolCandidate)) {
          return protocolCandidate;
        }
      }
    }
  }
  return inferProviderProtocol(provider);
}

function updateModelProviderHints(
  modelProviderHints: Map<string, string[]>,
  entries: ChatModelCatalogEntry[],
): void {
  modelProviderHints.clear();
  for (const entry of entries) {
    const modelId = normalizeModelValue(entry.id)?.toLowerCase();
    const provider = normalizeProviderId(entry.provider);
    if (!modelId || !provider || !inferProviderProtocol(provider)) {
      continue;
    }
    const providers = modelProviderHints.get(modelId) ?? [];
    if (!providers.includes(provider)) {
      providers.push(provider);
      modelProviderHints.set(modelId, providers);
    }
  }
}

function resolveProviderHintForModel(
  explicitProvider?: string,
): string | null {
  const explicit = normalizeProviderId(explicitProvider);
  if (explicit && inferProviderProtocol(explicit)) {
    return explicit;
  }
  return null;
}

function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const peerId = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(peerId) ? peerId : null;
}

function normalizeChatModelCatalogEntry(raw: unknown): ChatModelCatalogEntry | null {
  const entry = asRecord(raw);
  if (!entry) {
    return null;
  }

  const id = normalizeModelValue(entry.id);
  const provider = normalizeProviderId(entry.provider);
  const protocol = entry.protocol;
  if (!id || !provider || !isChatModelProtocol(protocol) || !inferProviderProtocol(provider)) {
    return null;
  }

  const count = Number(entry.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
  const label = normalizeModelValue(entry.label) ?? id;
  return {
    id,
    label,
    provider,
    protocol,
    count: normalizedCount,
  };
}

function normalizeChatModelCatalogEntries(rawEntries: unknown[]): ChatModelCatalogEntry[] {
  const deduped = new Map<string, ChatModelCatalogEntry>();
  for (const rawEntry of rawEntries) {
    const entry = normalizeChatModelCatalogEntry(rawEntry);
    if (!entry) {
      continue;
    }
    const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}`;
    const existing = deduped.get(key);
    if (existing) {
      existing.count = Math.max(existing.count, entry.count);
      continue;
    }
    deduped.set(key, { ...entry });
  }
  return sortChatModelCatalogEntries([...deduped.values()]);
}

async function readChatModelCatalogCache(): Promise<{ updatedAt: number; entries: ChatModelCatalogEntry[] } | null> {
  try {
    const raw = await readFile(CHAT_MODEL_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { updatedAt?: unknown; entries?: unknown };
    const updatedAt = Number(parsed.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      return null;
    }
    const entries = normalizeChatModelCatalogEntries(Array.isArray(parsed.entries) ? parsed.entries : []);
    if (entries.length === 0) {
      return null;
    }
    return {
      updatedAt: Math.floor(updatedAt),
      entries: limitChatModelCatalogEntries(entries),
    };
  } catch {
    return null;
  }
}

async function writeChatModelCatalogCache(entries: ChatModelCatalogEntry[]): Promise<void> {
  const normalized = limitChatModelCatalogEntries(normalizeChatModelCatalogEntries(entries));
  if (normalized.length === 0) {
    return;
  }
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  const payload = {
    updatedAt: Date.now(),
    entries: normalized,
  };
  await writeFile(CHAT_MODEL_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

function sortChatModelCatalogEntries(entries: ChatModelCatalogEntry[]): ChatModelCatalogEntry[] {
  const protocolRank = (protocol: ChatModelProtocol): number => (
    protocol === 'anthropic-messages' ? 0 : 1
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

function limitChatModelCatalogEntries(entries: ChatModelCatalogEntry[]): ChatModelCatalogEntry[] {
  if (entries.length <= CHAT_MODEL_MAX_OPTIONS) {
    return entries;
  }

  const limited: ChatModelCatalogEntry[] = [];
  const perProviderCount = new Map<string, number>();
  for (const entry of entries) {
    const provider = entry.provider;
    const providerCount = perProviderCount.get(provider) ?? 0;
    if (providerCount >= CHAT_MODEL_MAX_OPTIONS_PER_PROVIDER) {
      continue;
    }
    limited.push(entry);
    perProviderCount.set(provider, providerCount + 1);
    if (limited.length >= CHAT_MODEL_MAX_OPTIONS) {
      break;
    }
  }

  return limited;
}

async function fetchPeerMetadata(host: string, port: number): Promise<Record<string, unknown> | null> {
  if (!isPublicMetadataHost(host)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_MODEL_METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${host}:${String(port)}/metadata`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return asRecord(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractChatModelCatalog(metadata: Record<string, unknown>): Omit<ChatModelCatalogEntry, 'count'>[] {
  const providersRaw = metadata.providers;
  if (!Array.isArray(providersRaw)) {
    return [];
  }

  const models: Omit<ChatModelCatalogEntry, 'count'>[] = [];
  for (const providerEntry of providersRaw) {
    const providerRecord = asRecord(providerEntry);
    if (!providerRecord) {
      continue;
    }
    const providerId = normalizeProviderId(providerRecord.provider);
    if (!providerId) {
      continue;
    }
    const modelListRaw = providerRecord.models;
    if (!Array.isArray(modelListRaw)) {
      continue;
    }
    for (const modelRaw of modelListRaw) {
      const modelId = normalizeModelValue(modelRaw);
      if (!modelId) {
        continue;
      }
      const protocol = resolveProtocolForModel(providerId, providerRecord.modelApiProtocols, modelId);
      if (!protocol) {
        continue;
      }
      models.push({
        id: modelId,
        label: modelId,
        provider: providerId,
        protocol,
      });
    }
  }
  return models;
}

async function discoverChatModelCatalog(
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>,
): Promise<ChatModelCatalogEntry[]> {
  if (!getNetworkPeers) {
    return [];
  }

  let peers: NetworkPeerAddress[] = [];
  try {
    peers = await getNetworkPeers();
  } catch {
    return [];
  }

  const uniqueTargets: Array<{ host: string; port: number }> = [];
  const seen = new Set<string>();
  for (const peer of peers.slice(0, CHAT_MODEL_SCAN_MAX_PEERS)) {
    const host = normalizeHost(peer.host);
    const port = normalizePort(peer.port);
    if (!host || !port) {
      continue;
    }
    const key = `${host}:${String(port)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueTargets.push({ host, port });
  }

  if (uniqueTargets.length === 0) {
    return [];
  }

  const responses = await Promise.all(uniqueTargets.map(async (target) => {
    return await fetchPeerMetadata(target.host, target.port);
  }));

  const aggregate = new Map<string, ChatModelCatalogEntry>();
  for (const metadata of responses) {
    if (!metadata) {
      continue;
    }
    const entries = extractChatModelCatalog(metadata);
    for (const entry of entries) {
      const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}`;
      const existing = aggregate.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      aggregate.set(key, {
        ...entry,
        count: 1,
      });
    }
  }

  return sortChatModelCatalogEntries(Array.from(aggregate.values()));
}

function extractModelIdsFromApiPayload(payload: unknown): string[] {
  let modelEntries: unknown[] = [];
  if (Array.isArray(payload)) {
    modelEntries = payload;
  } else {
    const root = asRecord(payload);
    if (root) {
      if (Array.isArray(root.data)) {
        modelEntries = root.data;
      } else if (Array.isArray(root.models)) {
        modelEntries = root.models;
      }
    }
  }

  if (modelEntries.length === 0) {
    return [];
  }

  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of modelEntries) {
    let candidate: unknown = entry;
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      candidate = record.id ?? record.model ?? record.name;
    }
    const modelId = normalizeModelValue(candidate);
    if (!modelId) {
      continue;
    }
    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    modelIds.push(modelId);
  }
  return modelIds;
}

async function fetchProxyProviderModelCatalog(
  proxyPort: number,
  provider: string,
): Promise<ChatModelCatalogEntry[]> {
  const protocol = inferProviderProtocol(provider);
  if (!protocol) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_MODEL_API_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/v1/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-antseed-provider': provider,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const modelIds = extractModelIdsFromApiPayload(payload);
    return modelIds.map((modelId) => ({
      id: modelId,
      label: modelId,
      provider,
      protocol,
      count: 1,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverChatModelCatalogFromApi(
  proxyPort: number,
  getNetworkPeers?: () => Promise<NetworkPeerAddress[]>,
): Promise<ChatModelCatalogEntry[]> {
  if (!getNetworkPeers) {
    return [];
  }

  let peers: NetworkPeerAddress[] = [];
  try {
    peers = await getNetworkPeers();
  } catch {
    return [];
  }

  const providerSet = new Set<string>();
  for (const peer of peers) {
    if (!Array.isArray(peer.providers)) {
      continue;
    }
    for (const providerRaw of peer.providers) {
      const provider = normalizeProviderId(providerRaw);
      // Skip openrouter — its /v1/models returns the full catalog of hundreds
      // of unrelated models. Models from openrouter peers come via DHT metadata.
      if (!provider || provider === 'openrouter' || !inferProviderProtocol(provider)) {
        continue;
      }
      providerSet.add(provider);
      if (providerSet.size >= CHAT_MODEL_SCAN_MAX_PROVIDERS) {
        break;
      }
    }
    if (providerSet.size >= CHAT_MODEL_SCAN_MAX_PROVIDERS) {
      break;
    }
  }

  const providers = Array.from(providerSet.values());
  if (providers.length === 0) {
    return [];
  }

  const providerEntries = await Promise.all(
    providers.map(async (provider) => await fetchProxyProviderModelCatalog(proxyPort, provider)),
  );

  const aggregate = new Map<string, ChatModelCatalogEntry>();
  for (const entries of providerEntries) {
    for (const entry of entries) {
      const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}`;
      const existing = aggregate.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        aggregate.set(key, entry);
      }
    }
  }

  return sortChatModelCatalogEntries(Array.from(aggregate.values()));
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

function convertPiMessageToUiBlocks(message: Message): string | ContentBlock[] {
  if (message.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
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

function makeProxyModel(modelId: string, port: number): Model<'anthropic-messages'> {
  return {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    provider: PROXY_PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

function mapStopReason(value: unknown): AssistantMessage['stopReason'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'end_turn' || normalized === 'stop' || normalized === 'stop_sequence') {
    return 'stop';
  }
  if (normalized === 'max_tokens' || normalized === 'length') {
    return 'length';
  }
  if (normalized === 'tool_use' || normalized === 'tooluse') {
    return 'toolUse';
  }
  return 'stop';
}

function escapeJsonControlCharactersInStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) {
      continue;
    }
    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      out += char;
      continue;
    }

    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 0x20) {
      if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else if (char === '\b') out += '\\b';
      else if (char === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += char;
  }

  return out;
}

function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parseObject = (value: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(value);
      if (isToolArgumentsObject(parsed)) {
        return parsed;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const direct = parseObject(trimmed);
  if (direct) {
    return direct;
  }

  const repaired = parseObject(escapeJsonControlCharactersInStrings(trimmed));
  if (repaired) {
    return repaired;
  }

  return undefined;
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
    model: message.model,
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

function anthropicContentFromUser(content: Extract<Message, { role: 'user' }>['content']): unknown {
  if (typeof content === 'string') {
    return content;
  }
  const blocks: unknown[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length === 0) {
        continue;
      }
      blocks.push({ type: 'text', text });
      continue;
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.mimeType,
        data: block.data,
      },
    });
  }
  return blocks;
}

function anthropicContentFromAssistant(content: AssistantMessage['content']): unknown[] {
  const blocks: unknown[] = [];
  for (const block of content) {
    // Skip undefined holes from unhandled SSE block types (e.g. redacted_thinking).
    if (!block) {
      continue;
    }
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text.length === 0) {
        continue;
      }
      blocks.push({ type: 'text', text });
      continue;
    }
    // Strip thinking blocks: the proxy routes to arbitrary models (OpenRouter,
    // local LLMs, etc.) that do not understand Anthropic-format thinking blocks.
    // Echoing them back causes broken multi-turn conversations.
    if (block.type === 'thinking') {
      continue;
    }
    blocks.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.arguments ?? {},
    });
  }
  return blocks;
}

function anthropicContentFromToolResult(message: ToolResultMessage): unknown[] {
  const content = convertToolContentToText(message.content);
  return [{
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: content.length > 0 ? content : '(no tool output)',
    is_error: message.isError,
  }];
}

function getAssistantToolUseIds(content: unknown[]): string[] {
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (typedBlock.type !== 'tool_use') continue;
    const id = String(typedBlock.id ?? '').trim();
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

function getToolResultIdFromAnthropicBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const typedBlock = block as { type?: unknown; tool_use_id?: unknown };
  if (typedBlock.type !== 'tool_result') return null;
  const id = String(typedBlock.tool_use_id ?? '').trim();
  return id.length > 0 ? id : null;
}

function convertContextMessagesToAnthropic(messages: Message[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      const content = anthropicContentFromUser(message.content);
      if (typeof content === 'string' && content.length === 0) {
        continue;
      }
      if (Array.isArray(content) && content.length === 0) {
        continue;
      }
      converted.push({
        role: 'user',
        content,
      });
      continue;
    }
    if (message.role === 'assistant') {
      let content = anthropicContentFromAssistant(message.content);
      const toolUseIds = getAssistantToolUseIds(content);
      if (toolUseIds.length > 0) {
        const nextMessage = messages[index + 1];
        if (!nextMessage || nextMessage.role !== 'toolResult') {
          content = content.filter((block) => {
            if (!block || typeof block !== 'object') return false;
            const typedBlock = block as { type?: unknown };
            return typedBlock.type !== 'tool_use';
          });
        }
      }
      if (content.length === 0) {
        converted.push({
          role: 'assistant',
          content: [{ type: 'text', text: '…' }],
        });
        continue;
      }
      converted.push({
        role: 'assistant',
        content,
      });
      continue;
    }
    if (message.role === 'toolResult') {
      const contentBlocks: unknown[] = [];
      let toolIndex = index;
      while (toolIndex < messages.length) {
        const toolMessage = messages[toolIndex];
        if (!toolMessage || toolMessage.role !== 'toolResult') break;
        contentBlocks.push(...anthropicContentFromToolResult(toolMessage as ToolResultMessage));
        toolIndex += 1;
      }
      index = toolIndex - 1;
      const filteredBlocks = contentBlocks.filter((block) => {
        const toolUseId = getToolResultIdFromAnthropicBlock(block);
        return toolUseId !== null;
      });
      if (filteredBlocks.length === 0) {
        continue;
      }
      converted.push({
        role: 'user',
        content: filteredBlocks,
      });
    }
  }
  return converted;
}

function convertToolsToAnthropic(tools?: Tool[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
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

function createBuyerProxyStreamFn(
  onMeta: (meta: AiMessageMeta) => void,
  providerHint: string | null,
  preferredPeerId: string | null,
): (model: Model<any>, context: Context, options?: StreamOptions) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const totalTimeoutMs = resolveTimeoutMs(process.env[CHAT_STREAM_TOTAL_TIMEOUT_ENV], DEFAULT_CHAT_STREAM_TOTAL_TIMEOUT_MS);
    const idleTimeoutMs = resolveTimeoutMs(process.env[CHAT_STREAM_IDLE_TIMEOUT_ENV], DEFAULT_CHAT_STREAM_IDLE_TIMEOUT_MS);
    const timeoutController = new AbortController();
    const parentSignal = options?.signal;
    let timeoutErrorMessage: string | null = null;
    let totalTimeout: ReturnType<typeof setTimeout> | null = null;
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimeout = (): void => {
      if (!idleTimeout) return;
      clearTimeout(idleTimeout);
      idleTimeout = null;
    };
    const clearTotalTimeout = (): void => {
      if (!totalTimeout) return;
      clearTimeout(totalTimeout);
      totalTimeout = null;
    };
    const triggerTimeoutAbort = (message: string): void => {
      if (timeoutController.signal.aborted) return;
      timeoutErrorMessage = message;
      timeoutController.abort();
    };
    const resetIdleTimeout = (): void => {
      clearIdleTimeout();
      idleTimeout = setTimeout(() => {
        triggerTimeoutAbort(`Proxy stream idle timeout after ${String(idleTimeoutMs)}ms`);
      }, idleTimeoutMs);
    };

    totalTimeout = setTimeout(() => {
      triggerTimeoutAbort(`Proxy stream timed out after ${String(totalTimeoutMs)}ms`);
    }, totalTimeoutMs);

    const onParentAbort = (): void => {
      if (timeoutController.signal.aborted) return;
      timeoutController.abort();
    };
    if (parentSignal) {
      if (parentSignal.aborted) {
        timeoutController.abort();
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    void (async () => {
      const startedAt = Date.now();
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: ensureUsageShape(),
        stopReason: 'stop',
        timestamp: Date.now(),
      };

      const url = `${String(model.baseUrl).replace(/\/+$/, '')}/v1/messages`;
      const requestBody = {
        model: model.id,
        max_tokens: Number(options?.maxTokens) > 0 ? Math.floor(Number(options?.maxTokens)) : DEFAULT_MAX_TOKENS,
        stream: true,
        ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
        ...(context.tools ? { tools: convertToolsToAnthropic(context.tools) } : {}),
        messages: convertContextMessagesToAnthropic(context.messages),
      };
      const requestBodyJson = JSON.stringify(requestBody);

      let responseMeta: AiMessageMeta | undefined;

      const setUsage = (usageData: unknown): void => {
        const next = toUsage(usageData);
        if (next.input > 0) message.usage.input = next.input;
        if (next.output > 0) message.usage.output = next.output;
        if (next.cacheRead > 0) message.usage.cacheRead = next.cacheRead;
        if (next.cacheWrite > 0) message.usage.cacheWrite = next.cacheWrite;
        if (next.totalTokens > 0) message.usage.totalTokens = next.totalTokens;
      };

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(providerHint ? { 'x-antseed-provider': providerHint } : {}),
            ...(preferredPeerId ? { 'x-antseed-prefer-peer': preferredPeerId } : {}),
            ...(options?.headers ?? {}),
          },
          body: requestBodyJson,
          signal: timeoutController.signal,
        });

        responseMeta = parseProxyMeta(response, startedAt);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Proxy returned ${response.status}: ${errorText.slice(0, 280)}`);
        }

        stream.push({ type: 'start', partial: message });

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
          const payload = await response.json() as {
            content?: Array<{
              type: string;
              text?: string;
              thinking?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            usage?: unknown;
            stop_reason?: string;
          };
          setUsage(payload.usage);

          const blocks = payload.content ?? [];
          for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index];
            if (!block) {
              continue;
            }
            if (block.type === 'text') {
              const text = String(block.text ?? '');
              message.content.push({ type: 'text', text });
              stream.push({ type: 'text_start', contentIndex: index, partial: message });
              stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: message });
              stream.push({ type: 'text_end', contentIndex: index, content: text, partial: message });
              continue;
            }
            if (block.type === 'thinking') {
              const thinking = String(block.thinking ?? '');
              message.content.push({ type: 'thinking', thinking });
              stream.push({ type: 'thinking_start', contentIndex: index, partial: message });
              stream.push({ type: 'thinking_delta', contentIndex: index, delta: thinking, partial: message });
              stream.push({ type: 'thinking_end', contentIndex: index, content: thinking, partial: message });
              continue;
            }
            if (block.type === 'tool_use') {
              const toolCall = {
                type: 'toolCall' as const,
                id: String(block.id ?? `tool-${String(index)}`),
                name: String(block.name ?? 'tool'),
                arguments: (block.input ?? {}) as Record<string, unknown>,
              };
              message.content.push(toolCall);
              stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
            }
          }

          message.stopReason = mapStopReason(payload.stop_reason);
          message.usage.totalTokens = message.usage.totalTokens > 0
            ? message.usage.totalTokens
            : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
          stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : (message.stopReason === 'length' ? 'length' : 'stop'), message });
          onMeta({
            ...responseMeta,
            inputTokens: responseMeta.inputTokens || message.usage.input,
            outputTokens: responseMeta.outputTokens || message.usage.output,
            totalTokens: responseMeta.totalTokens || message.usage.totalTokens,
            tokenSource: responseMeta.tokenSource === 'unknown' ? 'usage' : responseMeta.tokenSource,
          });
          stream.end();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Proxy response is missing stream body');
        }

        let sseBuffer = '';
        const decoder = new TextDecoder();
        const toolJsonByContentIndex = new Map<number, string>();

        resetIdleTimeout();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdleTimeout();

          const chunkText = decoder.decode(value, { stream: true });
          sseBuffer += chunkText;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) {
              continue;
            }
            const payloadText = line.slice(5).trim();
            if (payloadText.length === 0 || payloadText === '[DONE]') {
              continue;
            }
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(payloadText) as Record<string, unknown>;
            } catch {
              continue;
            }

            const eventType = String(payload.type ?? '');
            if (eventType === 'message_start') {
              setUsage((payload.message as Record<string, unknown> | undefined)?.usage);
              continue;
            }

            if (eventType === 'content_block_start') {
              const index = Number(payload.index ?? 0);
              const block = (payload.content_block ?? {}) as Record<string, unknown>;
              const blockType = String(block.type ?? 'text');

              if (blockType === 'text') {
                const text = String(block.text ?? '');
                message.content[index] = { type: 'text', text };
                stream.push({ type: 'text_start', contentIndex: index, partial: message });
                if (text.length > 0) {
                  stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: message });
                }
                continue;
              }

              if (blockType === 'thinking') {
                const thinking = String(block.thinking ?? '');
                message.content[index] = { type: 'thinking', thinking };
                stream.push({ type: 'thinking_start', contentIndex: index, partial: message });
                if (thinking.length > 0) {
                  stream.push({ type: 'thinking_delta', contentIndex: index, delta: thinking, partial: message });
                }
                continue;
              }

              if (blockType === 'tool_use') {
                const toolCall = {
                  type: 'toolCall' as const,
                  id: String(block.id ?? `tool-${String(index)}`),
                  name: String(block.name ?? 'tool'),
                  arguments: (block.input ?? {}) as Record<string, unknown>,
                };
                message.content[index] = toolCall;
                toolJsonByContentIndex.set(index, '');
                stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              } else {
                // Unknown block type (e.g. redacted_thinking, signature).
                // Fill the index so later blocks don't create sparse holes
                // in the content array. Use an empty thinking block as a
                // no-op placeholder that anthropicContentFromAssistant strips.
                message.content[index] = { type: 'thinking', thinking: '' };
              }
              continue;
            }

            if (eventType === 'content_block_delta') {
              const index = Number(payload.index ?? 0);
              const delta = (payload.delta ?? {}) as Record<string, unknown>;
              const deltaType = String(delta.type ?? '');

              if (deltaType === 'text_delta') {
                const current = message.content[index];
                const nextDelta = String(delta.text ?? '');
                if (current && current.type === 'text') {
                  current.text += nextDelta;
                }
                stream.push({ type: 'text_delta', contentIndex: index, delta: nextDelta, partial: message });
                continue;
              }

              if (deltaType === 'thinking_delta') {
                const current = message.content[index];
                const nextDelta = String(delta.thinking ?? '');
                if (current && current.type === 'thinking') {
                  current.thinking += nextDelta;
                }
                stream.push({ type: 'thinking_delta', contentIndex: index, delta: nextDelta, partial: message });
                continue;
              }

              if (deltaType === 'input_json_delta') {
                const nextDelta = String(delta.partial_json ?? '');
                const previous = toolJsonByContentIndex.get(index) ?? '';
                const merged = `${previous}${nextDelta}`;
                toolJsonByContentIndex.set(index, merged);
                const current = message.content[index];
                if (current && current.type === 'toolCall') {
                  const parsed = parseToolJson(merged);
                  if (parsed) {
                    current.arguments = parsed;
                  }
                }
                stream.push({ type: 'toolcall_delta', contentIndex: index, delta: nextDelta, partial: message });
              }
              continue;
            }

            if (eventType === 'content_block_stop') {
              const index = Number(payload.index ?? 0);
              const current = message.content[index];
              if (!current) continue;

              if (current.type === 'text') {
                stream.push({ type: 'text_end', contentIndex: index, content: current.text, partial: message });
              } else if (current.type === 'thinking') {
                stream.push({ type: 'thinking_end', contentIndex: index, content: current.thinking, partial: message });
              } else if (current.type === 'toolCall') {
                const merged = toolJsonByContentIndex.get(index) ?? '';
                const parsed = parseToolJson(merged);
                if (parsed) {
                  current.arguments = parsed;
                }
                stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: current, partial: message });
              }
              continue;
            }

            if (eventType === 'message_delta' || eventType === 'message_stop') {
              setUsage(payload.usage);
              setUsage((payload.message as Record<string, unknown> | undefined)?.usage);
              const delta = payload.delta as Record<string, unknown> | undefined;
              if (delta?.stop_reason !== undefined) {
                message.stopReason = mapStopReason(delta.stop_reason);
              }
            }
          }
        }

        message.usage.totalTokens = message.usage.totalTokens > 0
          ? message.usage.totalTokens
          : message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;

        const doneReason: 'stop' | 'length' | 'toolUse' = message.stopReason === 'toolUse'
          ? 'toolUse'
          : (message.stopReason === 'length' ? 'length' : 'stop');
        stream.push({ type: 'done', reason: doneReason, message });
        onMeta({
          ...responseMeta,
          inputTokens: responseMeta?.inputTokens || message.usage.input,
          outputTokens: responseMeta?.outputTokens || message.usage.output,
          totalTokens: responseMeta?.totalTokens || message.usage.totalTokens,
          tokenSource: responseMeta?.tokenSource === 'unknown' ? 'usage' : responseMeta?.tokenSource,
        });
        stream.end();
      } catch (error) {
        const aborted = Boolean(parentSignal?.aborted);
        const errorMessage = timeoutErrorMessage
          ?? (error instanceof Error ? error.message : String(error));
        const failed: AssistantMessage = {
          ...message,
          stopReason: aborted ? 'aborted' : 'error',
          errorMessage,
          timestamp: Date.now(),
        };
        // Emit meta even on error so peer info is available in the UI.
        if (responseMeta) {
          onMeta(responseMeta);
        }
        stream.push({
          type: 'error',
          reason: aborted ? 'aborted' : 'error',
          error: failed,
        });
        stream.end();
      } finally {
        clearIdleTimeout();
        clearTotalTimeout();
        if (parentSignal) {
          parentSignal.removeEventListener('abort', onParentAbort);
        }
      }
    })();

    return stream;
  };
}

class PiConversationStore {
  private readonly sessionsDir = CHAT_SESSIONS_DIR;
  private readonly workspaceDir = CHAT_WORKSPACE_DIR;
  private readonly ready: Promise<void>;
  private readonly pathCache = new Map<string, string>();
  private readonly pendingManagers = new Map<string, SessionManager>();

  constructor() {
    this.ready = this.ensureDirs();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(CHAT_AGENT_DIR, { recursive: true });
  }

  private async listSessionPaths(): Promise<SessionPathInfo[]> {
    await this.ready;
    const sessions = await SessionManager.list(this.workspaceDir, this.sessionsDir);
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

    return {
      id: manager.getSessionId(),
      title: manager.getSessionName() || deriveTitle(messages),
      model: normalizeModelId(context.model?.modelId),
      provider: normalizeProviderId(context.model?.provider) ?? undefined,
      messages,
      createdAt,
      updatedAt,
      usage,
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
        model: conversation.model,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
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
        model: conversation.model,
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

  async create(model?: string, provider?: string): Promise<AiConversation> {
    await this.ready;
    const manager = SessionManager.create(this.workspaceDir, this.sessionsDir);
    const providerId = normalizeProviderId(provider);
    const modelProvider = providerId && inferProviderProtocol(providerId) ? providerId : PROXY_PROVIDER_ID;
    manager.appendModelChange(modelProvider, normalizeModelId(model));
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) {
      throw new Error('Failed to create persisted pi session');
    }
    const conversation = await this.buildConversationFromManager(manager);
    this.pendingManagers.set(conversation.id, manager);
    this.pathCache.set(conversation.id, sessionPath);
    return conversation;
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
    model: assistant.model,
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

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'Unexpected error';
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
  appendSystemLog,
  getNetworkPeers,
}: RegisterPiChatHandlersOptions): void {
  const store = new PiConversationStore();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const modelProviderHints = new Map<string, string[]>();
  const preferredPeerByConversationId = new Map<string, string>();
  let modelCatalogRefreshPromise: Promise<ChatModelCatalogEntry[]> | null = null;
  let lastModelCatalogRefreshAt = 0;

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
    if (isBuyerRuntimeRunning()) {
      return true;
    }
    return await isPortReachable(port);
  };

  const runStreamingPrompt = async (
    conversationId: string,
    userMessage: string,
    modelOverride?: string,
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
    if (!(await isProxyAvailable(proxyPort))) {
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
    const modelId = normalizeModelId(modelOverride || context.model?.modelId);
    const preferredPeerId = preferredPeerByConversationId.get(conversationId) ?? null;
    const providerHint = resolveProviderHintForModel(
      providerOverride,
    );
    const proxyModel = makeProxyModel(modelId, proxyPort);

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROXY_PROVIDER_ID, PROXY_RUNTIME_API_KEY);
    const modelRegistry = new ModelRegistry(authStorage);

    const { session } = await createAgentSession({
      cwd: CHAT_WORKSPACE_DIR,
      agentDir: CHAT_AGENT_DIR,
      sessionManager,
      authStorage,
      modelRegistry,
      model: proxyModel,
    });

    await session.setModel(proxyModel);
    session.agent.sessionId = conversationId;
    const systemPrompt = await resolveSystemPrompt(configPath);
    if (systemPrompt) {
      session.agent.setSystemPrompt(systemPrompt);
    }

    const existingUserMessages = session.messages.filter((message) => message.role === 'user').length;
    if (existingUserMessages === 0 && (!session.sessionName || session.sessionName.trim().length === 0)) {
      session.setSessionName(toConversationTitle(trimmedMessage));
    }

    const turnMetaQueue: AiMessageMeta[] = [];
    const toolArgsById = new Map<string, Record<string, unknown>>();
    session.agent.streamFn = createBuyerProxyStreamFn((meta) => {
      turnMetaQueue.push(meta);
    }, providerHint, preferredPeerId ?? null);

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
        sendToRenderer('chat:ai-tool-result', {
          conversationId,
          toolUseId: event.toolCallId,
          output: toToolOutputString(event.result),
          isError: Boolean(event.isError),
          details:
            event.result &&
            typeof event.result === 'object' &&
            'details' in event.result &&
            event.result.details &&
            typeof event.result.details === 'object'
              ? (event.result.details as Record<string, unknown>)
              : undefined,
        });
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
          const proxyMeta = turnMetaQueue.shift();
          const parsedMeta = parseAssistantMetaFromSessionEvent(message, proxyMeta);
          const peerId = normalizePeerId(parsedMeta.peerId);
          if (peerId) {
            preferredPeerByConversationId.set(conversationId, peerId);
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
      }
    });

    const run: ActiveRun = { conversationId, session, unsubscribe };
    activeRunsByConversation.set(conversationId, run);

    try {
      const images: ImageContent[] = imageBase64 && imageMimeType
        ? [{ type: 'image', data: imageBase64, mimeType: imageMimeType }]
        : [];
      await session.prompt(trimmedMessage || ' ', { images: images.length > 0 ? images : undefined });
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
      preferredPeerByConversationId.delete(conversationId);
      sendToRenderer('chat:ai-stream-error', { conversationId, error: message });
      appendSystemLog(`Pi chat error: ${message}`);
      return { ok: false, error: message };
    } finally {
      clearActiveRun(run);
      store.markPersistedIfAvailable(conversationId);
    }
  };

  const refreshModelCatalogFromNetwork = async (force = false): Promise<ChatModelCatalogEntry[]> => {
    const now = Date.now();
    if (!force && modelCatalogRefreshPromise) {
      return await modelCatalogRefreshPromise;
    }
    if (!force && now - lastModelCatalogRefreshAt < CHAT_MODEL_CACHE_REFRESH_DEBOUNCE_MS) {
      const cached = await readChatModelCatalogCache();
      if (cached) {
        return cached.entries;
      }
    }

    modelCatalogRefreshPromise = (async () => {
      // Fetch peers and proxy port once, in parallel, so both discovery paths
      // share a single dashboard round-trip instead of each making their own.
      const [peers, proxyPort] = await Promise.all([
        getNetworkPeers ? getNetworkPeers().catch(() => [] as NetworkPeerAddress[]) : Promise.resolve([] as NetworkPeerAddress[]),
        resolveProxyPort(configPath),
      ]);

      const getPeers = async (): Promise<NetworkPeerAddress[]> => peers;

      // Run both peer-aware discovery paths concurrently.
      const [modelsFromMetadata, modelsFromApi] = await Promise.all([
        discoverChatModelCatalog(getPeers),
        isProxyAvailable(proxyPort).then((up) =>
          up ? discoverChatModelCatalogFromApi(proxyPort, getPeers) : [],
        ),
      ]);

      // Merge results, deduplicating by (id, provider, protocol).
      const merged = new Map<string, ChatModelCatalogEntry>();
      for (const entry of [...modelsFromMetadata, ...modelsFromApi]) {
        const key = `${entry.id}\u0000${entry.provider}\u0000${entry.protocol}`;
        const existing = merged.get(key);
        if (existing) {
          existing.count = Math.max(existing.count, entry.count);
        } else {
          merged.set(key, { ...entry });
        }
      }

      const limited = limitChatModelCatalogEntries(normalizeChatModelCatalogEntries(Array.from(merged.values())));
      updateModelProviderHints(modelProviderHints, limited);
      void writeChatModelCatalogCache(limited).catch(() => undefined);
      lastModelCatalogRefreshAt = Date.now();
      return limited;
    })().finally(() => {
      modelCatalogRefreshPromise = null;
    });

    return await modelCatalogRefreshPromise;
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

  ipcMain.handle('chat:ai-list-models', async () => {
    try {
      const cached = await readChatModelCatalogCache();
      if (cached) {
        updateModelProviderHints(modelProviderHints, cached.entries);
        const cacheAgeMs = Date.now() - cached.updatedAt;
        if (cacheAgeMs <= CHAT_MODEL_CACHE_MAX_AGE_MS) {
          if (cacheAgeMs > CHAT_MODEL_CACHE_REFRESH_DEBOUNCE_MS) {
            void refreshModelCatalogFromNetwork(false).catch((error) => {
              appendSystemLog(`Background model catalog refresh failed: ${asErrorMessage(error)}`);
            });
          }
          return {
            ok: true,
            data: cached.entries,
          };
        }
      }
      const limitedModels = await refreshModelCatalogFromNetwork(true);
      if (limitedModels.length === 0 && cached) {
        return {
          ok: true,
          data: cached.entries,
        };
      }
      return {
        ok: true,
        data: limitedModels,
      };
    } catch (error) {
      return {
        ok: false,
        data: [] as ChatModelCatalogEntry[],
        error: asErrorMessage(error),
      };
    }
  });

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const conversations = await store.list();
    return { ok: true, data: conversations };
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-create-conversation', async (_event, model: string, provider?: string) => {
    const conversation = await store.create(model, provider);
    preferredPeerByConversationId.delete(conversation.id);
    return { ok: true, data: conversation };
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    preferredPeerByConversationId.delete(id);
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
    async (_event, conversationId: string, userMessage: string, model?: string, provider?: string, imageBase64?: string, imageMimeType?: string) => {
      return await runStreamingPrompt(conversationId, userMessage, model, provider, imageBase64, imageMimeType);
    },
  );

  ipcMain.handle(
    'chat:ai-send',
    async (_event, conversationId: string, userMessage: string, model?: string, provider?: string, imageBase64?: string, imageMimeType?: string) => {
      return await runStreamingPrompt(conversationId, userMessage, model, provider, imageBase64, imageMimeType);
    },
  );

  ipcMain.handle('chat:ai-abort', async () => {
    const activeRuns = Array.from(activeRunsByConversation.values());
    if (activeRuns.length === 0) {
      return { ok: true };
    }
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
    return { ok: true };
  });
}
