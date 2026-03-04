import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  DashboardDataResult,
  DashboardEndpoint,
  DaemonStateSnapshot,
  DesktopBridge,
  LogEvent,
  RuntimeMode,
  RuntimeProcessState,
  RuntimeSnapshot,
  WalletConnectState,
} from '../types/bridge';
import {
  getUiShellState,
  setActiveView,
  setEarningsPeriod,
  subscribeUiShellSnapshot,
} from '../state/ui-shell-store';
import type { ChatRenderableMessage } from '../components/chat/types';

type Tone = 'idle' | 'active' | 'warn' | 'bad';
type SortDirection = 'asc' | 'desc';
type PeerSortKey = 'peerId' | 'source' | 'providers' | 'inputUsdPerMillion' | 'outputUsdPerMillion' | 'capacityMsgPerHour' | 'reputation' | 'location';
type SessionSortKey = 'sessionId' | 'provider' | 'startedAt' | 'totalTokens' | 'totalRequests' | 'durationMs' | 'avgLatencyMs' | 'peerSwitches';

type NetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups: number;
  successfulLookups: number;
  lookupSuccessRate: number;
  averageLookupLatencyMs: number;
  healthReason: string;
};

type NetworkPeer = {
  peerId: string;
  displayName: string | null;
  host: string;
  port: number;
  providers: string[];
  models: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: string;
  location: string | null;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

type ChatConversation = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  totalTokens?: number;
  messages: ChatMessage[];
};

type ChatConversationSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  messageCount: number;
  totalEstimatedCostUsd: number;
};

type DashboardBundle = {
  network: DashboardDataResult;
  peers: DashboardDataResult;
  sessions: DashboardDataResult;
  earnings: DashboardDataResult;
  status: DashboardDataResult;
  dataSources: DashboardDataResult;
  config: DashboardDataResult;
};

type SettingsFormState = {
  proxyPort: number;
  preferredProviders: string;
  buyerMaxInputUsdPerMillion: number;
  buyerMaxOutputUsdPerMillion: number;
  minRep: number;
  paymentMethod: string;
};

const bridge = window.antseedDesktop as DesktopBridge | undefined;
const DEFAULT_DASHBOARD_PORT = 3117;
const POLL_INTERVAL_MS = 5000;
const PEER_MODEL_SCAN_COOLDOWN_MS = 10_000;
const CHAT_DEFAULT_MODEL = 'claude-sonnet-4.6';
const PINNED_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus' },
  { id: 'claude-haiku-4-20250514', label: 'Claude Haiku' },
];
const ROUTER_PACKAGE_ALIASES: Record<string, string> = {
  local: '@antseed/router-local',
  'claude-code': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-claude-code': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
  '@antseed/router-local': '@antseed/router-local',
};

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function formatInt(value: unknown): string {
  return Math.round(safeNumber(value, 0)).toLocaleString();
}

function formatMoney(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return `$${parsed.toFixed(2)}`;
    }
    return `$${value}`;
  }
  return `$${safeNumber(value, 0).toFixed(2)}`;
}

function formatPrice(value: unknown): string {
  const n = safeNumber(value, 0);
  if (n <= 0) return 'n/a';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatLatency(value: unknown): string {
  const n = safeNumber(value, 0);
  return n <= 0 ? 'n/a' : `${Math.round(n)}ms`;
}

function formatDuration(value: unknown): string {
  const ms = safeNumber(value, 0);
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(value: unknown): string {
  const ts = safeNumber(value, 0);
  return ts > 0 ? new Date(ts).toLocaleString() : 'n/a';
}

function formatRelativeTime(value: unknown): string {
  const ts = safeNumber(value, 0);
  if (ts <= 0) return 'n/a';
  const delta = Date.now() - ts;
  if (delta <= 0) return 'now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatShortId(value: unknown, head = 8, tail = 6): string {
  const id = safeString(value, '');
  if (!id) return 'unknown';
  if (id.length <= head + tail + 3) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

function formatEndpoint(peer: Partial<NetworkPeer>): string {
  const host = safeString(peer.host, '').trim();
  const port = safeNumber(peer.port, 0);
  if (host.length > 0 && port > 0) {
    return `${host}:${port}`;
  }
  return '-';
}

function toneClass(tone: Tone): string {
  return `connection-badge badge-${tone}`;
}

function defaultNetworkStats(): NetworkStats {
  return {
    totalPeers: 0,
    dhtNodeCount: 0,
    dhtHealthy: false,
    lastScanAt: null,
    totalLookups: 0,
    successfulLookups: 0,
    lookupSuccessRate: 0,
    averageLookupLatencyMs: 0,
    healthReason: 'dashboard offline',
  };
}

function networkHealth(stats: NetworkStats, peerCount: number): { label: string; tone: Tone } {
  if (stats.dhtHealthy) return { label: 'Healthy', tone: 'active' };
  if (peerCount > 0) return { label: 'Limited', tone: 'warn' };
  return { label: 'Down', tone: 'bad' };
}

function normalizePeer(raw: unknown, fallbackSource: string): NetworkPeer | null {
  const peer = safeRecord(raw);
  const peerId = safeString(peer.peerId, '').trim();
  if (!peerId) return null;

  return {
    peerId,
    displayName: safeString(peer.displayName, '').trim() || null,
    host: safeString(peer.host, ''),
    port: safeNumber(peer.port, 0),
    providers: safeArray<string>(peer.providers).map((entry) => safeString(entry, '')).filter((entry) => entry.length > 0),
    models: safeArray<string>(peer.models).map((entry) => safeString(entry, '')).filter((entry) => entry.length > 0),
    inputUsdPerMillion: safeNumber(peer.inputUsdPerMillion, 0),
    outputUsdPerMillion: safeNumber(peer.outputUsdPerMillion, 0),
    capacityMsgPerHour: safeNumber(peer.capacityMsgPerHour, 0),
    reputation: safeNumber(peer.reputation, 0),
    lastSeen: safeNumber(peer.lastSeen, 0),
    source: safeString(peer.source, fallbackSource) || fallbackSource,
    location: safeString(peer.location, '') || null,
  };
}

function normalizeNetworkData(networkData: unknown, daemonPeersData: unknown): { peers: NetworkPeer[]; stats: NetworkStats } {
  const networkRoot = safeRecord(networkData);
  const daemonRoot = safeRecord(daemonPeersData);

  const networkPeers = safeArray(networkRoot.peers);
  const daemonPeers = safeArray(daemonRoot.peers);
  const stats = {
    ...defaultNetworkStats(),
    ...safeRecord(networkRoot.stats),
  } as NetworkStats;

  const byPeerId = new Map<string, NetworkPeer>();

  for (const raw of networkPeers) {
    const normalized = normalizePeer(raw, 'dht');
    if (!normalized) continue;
    byPeerId.set(normalized.peerId, normalized);
  }

  for (const raw of daemonPeers) {
    const normalized = normalizePeer(raw, 'daemon');
    if (!normalized) continue;
    const existing = byPeerId.get(normalized.peerId);
    if (!existing) {
      byPeerId.set(normalized.peerId, normalized);
      continue;
    }
    if (!existing.displayName && normalized.displayName) existing.displayName = normalized.displayName;
    if (existing.providers.length === 0 && normalized.providers.length > 0) existing.providers = normalized.providers;
    if (existing.models.length === 0 && normalized.models.length > 0) existing.models = normalized.models;
    if (existing.inputUsdPerMillion <= 0 && normalized.inputUsdPerMillion > 0) existing.inputUsdPerMillion = normalized.inputUsdPerMillion;
    if (existing.outputUsdPerMillion <= 0 && normalized.outputUsdPerMillion > 0) existing.outputUsdPerMillion = normalized.outputUsdPerMillion;
    if (existing.capacityMsgPerHour <= 0 && normalized.capacityMsgPerHour > 0) existing.capacityMsgPerHour = normalized.capacityMsgPerHour;
    if (existing.reputation <= 0 && normalized.reputation > 0) existing.reputation = normalized.reputation;
    if (!existing.location && normalized.location) existing.location = normalized.location;
    if ((!existing.host || existing.host.length === 0) && normalized.host.length > 0) {
      existing.host = normalized.host;
      existing.port = normalized.port;
    }
    if (!existing.source || existing.source === 'dht') existing.source = normalized.source;
  }

  const peers = Array.from(byPeerId.values()).sort((a, b) => {
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    return b.lastSeen - a.lastSeen;
  });

  stats.totalPeers = peers.length;
  return { peers, stats };
}

function resolvePeerDisplayName(peer: NetworkPeer): string {
  if (peer.displayName && peer.displayName.trim().length > 0) return peer.displayName.trim();
  const endpoint = formatEndpoint(peer);
  if (endpoint !== '-') return endpoint;
  return formatShortId(peer.peerId);
}

function sortItems<T extends Record<string, unknown>>(items: T[], key: keyof T | string, dir: SortDirection): T[] {
  return [...items].sort((a, b) => {
    let va: unknown = a[key as keyof T];
    let vb: unknown = b[key as keyof T];
    if (Array.isArray(va)) va = va.join(', ');
    if (Array.isArray(vb)) vb = vb.join(', ');
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va == null) va = '';
    if (vb == null) vb = '';
    const av = typeof va === 'number' ? va : String(va);
    const bv = typeof vb === 'number' ? vb : String(vb);
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function modelLabel(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === 'claude-sonnet-4.6' || normalized === 'claude-sonnet-4-6' || normalized.includes('sonnet-4.6')) {
    return 'Claude Sonnet 4.6';
  }
  if (normalized.includes('claude-sonnet')) return 'Claude Sonnet';
  if (normalized.includes('claude-opus')) return 'Claude Opus';
  if (normalized.includes('claude-haiku')) return 'Claude Haiku';
  if (normalized === 'moonshotai/kimi-k2.5') return 'Kimi K2.5';
  return modelId;
}

function collectPeerModels(peers: NetworkPeer[]): string[] {
  const models = new Set<string>();
  for (const peer of peers) {
    for (const model of peer.models) {
      const trimmed = model.trim();
      if (trimmed.length > 0) {
        models.add(trimmed);
      }
    }
  }
  return Array.from(models).sort((a, b) => a.localeCompare(b));
}

function canonicalModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replaceAll('.', '-')
    .replaceAll('_', '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function modelStem(modelId: string): string {
  const canonical = canonicalModelId(modelId);
  const slashIndex = canonical.lastIndexOf('/');
  return slashIndex >= 0 ? canonical.slice(slashIndex + 1) : canonical;
}

function resolvePeerModelId(requestedModel: string, availableModels: string[]): string | null {
  const requested = requestedModel.trim();
  if (availableModels.length === 0) {
    return requested.length > 0 ? requested : null;
  }
  if (requested.length === 0) {
    return availableModels[0] ?? null;
  }

  const exact = availableModels.find((model) => model === requested);
  if (exact) return exact;

  const requestedCanonical = canonicalModelId(requested);
  const canonicalMatch = availableModels.find((model) => canonicalModelId(model) === requestedCanonical);
  if (canonicalMatch) return canonicalMatch;

  const requestedStem = modelStem(requested);
  const stemMatch = availableModels.find((model) => modelStem(model) === requestedStem);
  if (stemMatch) return stemMatch;

  return null;
}

function shortModelName(model: unknown): string {
  const raw = safeString(model, '').trim();
  if (!raw) return 'unknown-model';
  return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSimpleMarkdown(raw: string): string {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

function isProxyPortOccupiedMessage(value: unknown): boolean {
  const message = safeString(value, '').toLowerCase();
  return message.includes('eaddrinuse') || message.includes('address already in use');
}

function normalizePluginSlug(value: unknown, fallback: string): string {
  const raw = safeString(value, fallback).trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || fallback;
}

function resolveRouterPackageName(value: unknown): string {
  const raw = safeString(value, 'local').trim().toLowerCase();
  if (!raw) return ROUTER_PACKAGE_ALIASES['local']!;
  if (ROUTER_PACKAGE_ALIASES[raw]) return ROUTER_PACKAGE_ALIASES[raw]!;
  if (raw.startsWith('@')) return raw;
  if (raw.startsWith('router-')) return `@antseed/${raw}`;
  return `@antseed/router-${normalizePluginSlug(raw, 'local')}`;
}

function parseChatConversationSummary(raw: unknown): ChatConversationSummary | null {
  const conv = safeRecord(raw);
  const id = safeString(conv.id, '');
  if (!id) return null;
  return {
    id,
    title: safeString(conv.title, 'New conversation'),
    model: safeString(conv.model, CHAT_DEFAULT_MODEL),
    createdAt: safeNumber(conv.createdAt, Date.now()),
    updatedAt: safeNumber(conv.updatedAt, Date.now()),
    totalTokens: safeNumber(conv.totalTokens, 0),
    messageCount: safeNumber(conv.messageCount, 0),
    totalEstimatedCostUsd: safeNumber(conv.totalEstimatedCostUsd, 0),
  };
}

function parseChatMessage(raw: unknown): ChatMessage {
  const msg = safeRecord(raw);
  return {
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content ?? '',
    createdAt: safeNumber(msg.createdAt, 0) || undefined,
    meta: safeRecord(msg.meta),
  };
}

function parseChatConversation(raw: unknown): ChatConversation | null {
  const conv = safeRecord(raw);
  const id = safeString(conv.id, '');
  if (!id) return null;
  return {
    id,
    title: safeString(conv.title, 'New conversation'),
    model: safeString(conv.model, CHAT_DEFAULT_MODEL),
    createdAt: safeNumber(conv.createdAt, Date.now()),
    updatedAt: safeNumber(conv.updatedAt, Date.now()),
    usage: safeRecord(conv.usage),
    totalTokens: safeNumber(conv.totalTokens, 0),
    messages: safeArray(conv.messages).map((msg) => parseChatMessage(msg)),
  };
}

function compactInlineText(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
}

function summarizeToolInput(input: unknown): string {
  const payload = safeRecord(input);
  const preferredKeys = ['command', 'cmd', 'path', 'query', 'pattern', 'file', 'target'];
  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return compactInlineText(value);
    }
    if (Array.isArray(value) && value.length > 0) {
      return compactInlineText(value.map((entry) => String(entry)).join(' '));
    }
  }

  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return compactInlineText(value);
    }
  }
  return '';
}

function isToolResultOnlyUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  return message.content.every((block) => safeString(safeRecord(block).type, '') === 'tool_result');
}

function renderChatMessageContent(message: ChatMessage): string {
  if (Array.isArray(message.content)) {
    const blocks = message.content.map((block) => {
      const typed = safeRecord(block);
      const type = safeString(typed.type, '');
      if (type === 'text') {
        return `<div class="chat-bubble-content">${renderSimpleMarkdown(safeString(typed.text, ''))}</div>`;
      }
      if (type === 'thinking') {
        return `<div class="thinking-block"><div class="thinking-block-header">Reasoning</div><div class="thinking-block-body">${escapeHtml(safeString(typed.thinking, ''))}</div></div>`;
      }
      if (type === 'tool_use') {
        const toolName = safeString(typed.name, 'tool');
        const summary = summarizeToolInput(typed.input);
        const label = summary.length > 0 ? `${toolName} (${summary})` : toolName;
        return `<div class="tool-inline"><div class="tool-inline-header"><span class="tool-inline-dot running"></span><span class="tool-inline-status running">Running</span><span class="tool-inline-label">${escapeHtml(label)}</span></div></div>`;
      }
      if (type === 'tool_result') {
        return `<div class="tool-inline"><div class="tool-inline-header"><span class="tool-inline-dot success"></span><span class="tool-inline-status success">Done</span><span class="tool-inline-label">result</span></div><pre class="tool-inline-output">${escapeHtml(safeString(typed.content, ''))}</pre></div>`;
      }
      return '';
    });
    return blocks.join('');
  }
  return `<div class="chat-bubble-content">${renderSimpleMarkdown(safeString(message.content, ''))}</div>`;
}

function normalizeStreamDraftBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return content.map((block) => ({ ...safeRecord(block) }));
  }
  const text = safeString(content, '');
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

function ensureStreamDraftBlock(
  blocks: Array<Record<string, unknown>>,
  index: number,
  blockType: string,
  blockStart?: { toolId?: string; toolName?: string; input?: Record<string, unknown> },
): Record<string, unknown> {
  while (blocks.length <= index) {
    blocks.push({ type: 'text', text: '' });
  }
  const current = safeRecord(blocks[index]);
  const currentType = safeString(current.type, '');
  if (currentType === blockType) {
    return current;
  }

  if (blockType === 'thinking') {
    const next = { type: 'thinking', thinking: '' };
    blocks[index] = next;
    return next;
  }
  if (blockType === 'tool_use') {
    const next = {
      type: 'tool_use',
      id: safeString(blockStart?.toolId, ''),
      name: safeString(blockStart?.toolName, 'tool'),
      input: safeRecord(blockStart?.input),
    };
    blocks[index] = next;
    return next;
  }
  if (blockType === 'tool_result') {
    const next = {
      type: 'tool_result',
      tool_use_id: safeString(blockStart?.toolId, ''),
      content: '',
      is_error: false,
    };
    blocks[index] = next;
    return next;
  }

  const next = { type: 'text', text: '' };
  blocks[index] = next;
  return next;
}

function patchStreamingAssistantDraft(
  messages: ChatMessage[],
  conversationId: string,
  patch: (blocks: Array<Record<string, unknown>>) => void,
): ChatMessage[] {
  const next = [...messages];
  let targetIndex = -1;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    const meta = safeRecord(candidate?.meta);
    if (
      candidate?.role === 'assistant'
      && meta.__streaming === true
      && safeString(meta.__conversationId, '') === conversationId
    ) {
      targetIndex = index;
      break;
    }
  }

  if (targetIndex === -1) {
    next.push({
      role: 'assistant',
      content: [],
      createdAt: Date.now(),
      meta: {
        __streaming: true,
        __conversationId: conversationId,
      },
    });
    targetIndex = next.length - 1;
  }

  const target = next[targetIndex]!;
  const blocks = normalizeStreamDraftBlocks(target.content);
  patch(blocks);

  next[targetIndex] = {
    ...target,
    content: blocks,
    createdAt: target.createdAt ?? Date.now(),
    meta: {
      ...safeRecord(target.meta),
      __streaming: true,
      __conversationId: conversationId,
    },
  };

  return next;
}

function formatCompactNumber(value: unknown): string {
  const numberValue = safeNumber(value, 0);
  return numberValue > 0 ? Math.floor(numberValue).toLocaleString() : '0';
}

function viewClass(active: boolean): string {
  return active ? 'view active' : 'view';
}

function maybeError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

export function useDesktopViewModel() {
  const shellState = useSyncExternalStore(subscribeUiShellSnapshot, getUiShellState, getUiShellState);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [processes, setProcesses] = useState<RuntimeProcessState[]>([]);
  const [daemonState, setDaemonState] = useState<DaemonStateSnapshot | null>(null);
  const [dashboardData, setDashboardData] = useState<DashboardBundle>({
    network: { ok: false, data: null, error: 'not loaded', status: null },
    peers: { ok: false, data: null, error: 'not loaded', status: null },
    sessions: { ok: false, data: null, error: 'not loaded', status: null },
    earnings: { ok: false, data: null, error: 'not loaded', status: null },
    status: { ok: false, data: null, error: 'not loaded', status: null },
    dataSources: { ok: false, data: null, error: 'not loaded', status: null },
    config: { ok: false, data: null, error: 'not loaded', status: null },
  });
  const [refreshing, setRefreshing] = useState(false);
  const [connectWarning, setConnectWarning] = useState<string | null>(null);
  const [peerFilter, setPeerFilter] = useState('');
  const [peerSort, setPeerSort] = useState<{ key: PeerSortKey; dir: SortDirection }>({
    key: 'reputation',
    dir: 'desc',
  });
  const [sessionSort, setSessionSort] = useState<{ key: SessionSortKey; dir: SortDirection }>({
    key: 'startedAt',
    dir: 'desc',
  });
  const [settings, setSettings] = useState<SettingsFormState>({
    proxyPort: 8377,
    preferredProviders: '',
    buyerMaxInputUsdPerMillion: 0,
    buyerMaxOutputUsdPerMillion: 0,
    minRep: 0,
    paymentMethod: 'crypto',
  });
  const [settingsPopulated, setSettingsPopulated] = useState(false);
  const [configMessage, setConfigMessage] = useState('Loading config...');
  const [configSaving, setConfigSaving] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<Set<string>>(new Set());
  const [pluginInstallBusy, setPluginInstallBusy] = useState(false);
  const [pluginHints, setPluginHints] = useState<{ router: string | null }>({
    router: null,
  });
  const [walletInfo, setWalletInfo] = useState<Record<string, unknown> | null>(null);
  const [walletMode, setWalletModeState] = useState<'node' | 'external'>('node');
  const [walletActionMessage, setWalletActionMessage] = useState<string>('');
  const [walletActionTone, setWalletActionTone] = useState<'success' | 'error' | ''>('');
  const [walletAmount, setWalletAmount] = useState('');
  const [walletMessage, setWalletMessage] = useState('Loading wallet info...');
  const [wcState, setWcState] = useState<WalletConnectState>({
    connected: false,
    address: null,
    chainId: null,
    pairingUri: null,
  });
  const [chatConversations, setChatConversations] = useState<ChatConversationSummary[]>([]);
  const [chatActiveConversation, setChatActiveConversation] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState(CHAT_DEFAULT_MODEL);
  const [chatProxy, setChatProxy] = useState<{ running: boolean; port: number }>({
    running: false,
    port: 0,
  });
  const [chatThreadTitle, setChatThreadTitle] = useState('Conversation');
  const [chatThreadMeta, setChatThreadMeta] = useState('No conversation selected');
  const [chatStreamingStartedAt, setChatStreamingStartedAt] = useState<number>(0);
  const [chatStreamingNow, setChatStreamingNow] = useState<number>(Date.now());
  const [chatStreamingLabel, setChatStreamingLabel] = useState('Generating response...');
  const refreshTimerRef = useRef<number | null>(null);
  const startupTaskStartedRef = useRef(false);
  const peerModelScanAtRef = useRef<number>(0);
  const chatActiveConversationRef = useRef<string | null>(null);

  const getDashboardPort = useCallback(() => {
    return DEFAULT_DASHBOARD_PORT;
  }, []);

  const appendSystemLog = useCallback((line: string) => {
    const event: LogEvent = {
      mode: 'dashboard',
      stream: 'system',
      line,
      timestamp: Date.now(),
    };
    setLogs((current) => {
      const next = [...current, event];
      if (next.length > 1200) {
        return next.slice(next.length - 1200);
      }
      return next;
    });
  }, []);

  const processByMode = useCallback((mode: RuntimeMode): RuntimeProcessState | null => {
    return processes.find((entry) => entry.mode === mode) ?? null;
  }, [processes]);

  const isModeRunning = useCallback((mode: RuntimeMode): boolean => {
    const entry = processByMode(mode);
    return Boolean(entry?.running);
  }, [processByMode]);

  const runtimeSummary = useMemo(() => {
    if (isModeRunning('connect')) {
      return 'Buyer runtime connected';
    }
    if (chatProxy.running) {
      return `Buyer proxy reachable on ${chatProxy.port}`;
    }
    return 'Buyer runtime offline';
  }, [chatProxy.port, chatProxy.running, isModeRunning]);

  const getDashboardData = useCallback(async (
    endpoint: DashboardEndpoint,
    query: Record<string, string | number | boolean> | undefined = undefined,
  ): Promise<DashboardDataResult> => {
    if (!bridge) {
      return { ok: false, data: null, error: 'Desktop bridge unavailable', status: null };
    }

    if (bridge.getDashboardData) {
      try {
        return await bridge.getDashboardData(endpoint, {
          port: getDashboardPort(),
          query,
        });
      } catch (err) {
        return {
          ok: false,
          data: null,
          error: maybeError(err, 'Dashboard API failed'),
          status: null,
        };
      }
    }

    if (endpoint === 'network' && bridge.getNetwork) {
      const legacy = await bridge.getNetwork(getDashboardPort());
      if (!legacy.ok) {
        return {
          ok: false,
          data: null,
          error: safeString(legacy.error, 'Failed to query network'),
          status: null,
        };
      }
      return { ok: true, data: legacy, error: null, status: 200 };
    }

    if (endpoint === 'peers' && bridge.getNetwork) {
      const legacy = await bridge.getNetwork(getDashboardPort());
      if (!legacy.ok) {
        return {
          ok: false,
          data: null,
          error: safeString(legacy.error, 'Failed to query peers'),
          status: null,
        };
      }
      const peers = safeArray(legacy.peers);
      return {
        ok: true,
        data: {
          peers,
          total: peers.length,
          degraded: false,
        },
        error: null,
        status: 200,
      };
    }

    return {
      ok: false,
      data: null,
      error: 'Dashboard endpoint unavailable',
      status: null,
    };
  }, [getDashboardPort]);

  const refreshDashboardBundle = useCallback(async () => {
    const [network, peers, sessions, earnings, status, dataSources, config] = await Promise.all([
      getDashboardData('network'),
      getDashboardData('peers'),
      getDashboardData('sessions', { limit: 100, offset: 0 }),
      getDashboardData('earnings', { period: shellState.earningsPeriod }),
      getDashboardData('status'),
      getDashboardData('data-sources'),
      getDashboardData('config'),
    ]);

    setDashboardData({
      network,
      peers,
      sessions,
      earnings,
      status,
      dataSources,
      config,
    });

    if (config.ok) {
      const root = safeRecord(config.data);
      const configPayload = safeRecord(root.config ?? root);
      if (!settingsPopulated) {
        const buyer = safeRecord(configPayload.buyer);
        const buyerPricing = safeRecord(safeRecord(safeRecord(buyer.maxPricing).defaults));
        const payments = safeRecord(configPayload.payments);
        setSettings({
          proxyPort: safeNumber(buyer.proxyPort, 8377),
          preferredProviders: safeArray<string>(buyer.preferredProviders).join(', '),
          buyerMaxInputUsdPerMillion: safeNumber(buyerPricing.inputUsdPerMillion, 0),
          buyerMaxOutputUsdPerMillion: safeNumber(buyerPricing.outputUsdPerMillion, 0),
          minRep: safeNumber(buyer.minPeerReputation, 0),
          paymentMethod: safeString(payments.preferredMethod, 'crypto'),
        });
        setSettingsPopulated(true);
      }
      setConfigMessage('Settings loaded from dashboard API.');
    } else {
      setConfigMessage(`Unable to load config: ${config.error ?? 'unknown error'}`);
    }
  }, [getDashboardData, settingsPopulated, shellState.earningsPeriod]);

  const refreshWalletInfo = useCallback(async () => {
    if (!bridge?.walletGetInfo) return;
    try {
      const result = await bridge.walletGetInfo(getDashboardPort());
      if (result.ok) {
        const info = safeRecord(result.data);
        setWalletInfo(info);
        const address = safeString(info.address, '');
        if (address) {
          setWalletMessage('Wallet derived from node identity.');
        } else {
          setWalletMessage('Configure wallet address in Settings.');
        }
      } else {
        setWalletMessage(result.error ?? 'Unable to load wallet info');
      }
    } catch {
      setWalletMessage('Wallet bridge unavailable');
    }
  }, [getDashboardPort]);

  const refreshWcState = useCallback(async () => {
    if (!bridge?.walletConnectState) return;
    try {
      const result = await bridge.walletConnectState();
      if (result.ok) {
        setWcState(result.data);
      }
    } catch {
      // Ignore unavailable WalletConnect in this environment.
    }
  }, []);

  const refreshChatConversations = useCallback(async () => {
    if (!bridge?.chatAiListConversations) return;
    try {
      const result = await bridge.chatAiListConversations();
      if (!result.ok) return;
      const conversations = safeArray(result.data)
        .map((entry) => parseChatConversationSummary(entry))
        .filter((entry): entry is ChatConversationSummary => entry !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setChatConversations(conversations);
      if (!chatActiveConversation && conversations.length > 0) {
        setChatActiveConversation(conversations[0]!.id);
      }
    } catch (err) {
      setChatError(maybeError(err, 'Failed to load conversations'));
    }
  }, [chatActiveConversation]);

  const refreshChatProxyStatus = useCallback(async () => {
    if (!bridge?.chatAiGetProxyStatus) return;
    try {
      const result = await bridge.chatAiGetProxyStatus();
      if (result.ok) {
        setChatProxy(result.data);
      }
    } catch {
      setChatProxy({ running: false, port: 0 });
    }
  }, []);

  const refreshPluginInventory = useCallback(async () => {
    if (!bridge?.pluginsList) return;
    try {
      const result = await bridge.pluginsList();
      if (!result.ok) {
        throw new Error(result.error ?? 'Failed to read installed plugins');
      }
      const packages = safeArray(result.plugins)
        .map((entry) => safeString(safeRecord(entry).package, ''))
        .filter((entry) => entry.length > 0);
      setInstalledPlugins(new Set(packages));
    } catch (err) {
      appendSystemLog(`Plugin inventory refresh failed: ${maybeError(err, 'unknown error')}`);
    }
  }, [appendSystemLog]);

  const refreshAll = useCallback(async () => {
    if (!bridge?.getState || refreshing) return;
    setRefreshing(true);
    try {
      const snapshot = await bridge.getState() as RuntimeSnapshot;
      setProcesses(safeArray(snapshot.processes));
      setLogs(safeArray<LogEvent>(snapshot.logs).slice(-1200));
      setDaemonState(snapshot.daemonState ?? null);
      await Promise.all([
        refreshDashboardBundle(),
        refreshWalletInfo(),
        refreshChatConversations(),
        refreshChatProxyStatus(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [
    refreshing,
    refreshDashboardBundle,
    refreshWalletInfo,
    refreshChatConversations,
    refreshChatProxyStatus,
  ]);

  const refreshAllRef = useRef(refreshAll);
  const refreshPluginInventoryRef = useRef(refreshPluginInventory);
  const isModeRunningRef = useRef(isModeRunning);

  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  useEffect(() => {
    refreshPluginInventoryRef.current = refreshPluginInventory;
  }, [refreshPluginInventory]);

  useEffect(() => {
    isModeRunningRef.current = isModeRunning;
  }, [isModeRunning]);

  useEffect(() => {
    chatActiveConversationRef.current = chatActiveConversation;
  }, [chatActiveConversation]);

  const normalizedNetwork = useMemo(() => {
    return normalizeNetworkData(
      dashboardData.network.ok ? dashboardData.network.data : null,
      dashboardData.peers.ok ? dashboardData.peers.data : null,
    );
  }, [dashboardData.network, dashboardData.peers]);

  const discoveredChatModels = useMemo(() => {
    return collectPeerModels(normalizedNetwork.peers);
  }, [normalizedNetwork.peers]);

  const fetchPeerModelCatalog = useCallback(async (): Promise<string[]> => {
    const shouldScanNetwork = (
      Date.now() - peerModelScanAtRef.current >= PEER_MODEL_SCAN_COOLDOWN_MS
      || discoveredChatModels.length === 0
    );
    if (shouldScanNetwork && bridge?.scanNetwork) {
      try {
        // Force a fresh DHT metadata pull before selecting chat models.
        await bridge.scanNetwork(getDashboardPort());
      } catch {
        // Ignore scan failures and continue with latest available snapshot.
      } finally {
        peerModelScanAtRef.current = Date.now();
      }
    }

    try {
      const [networkResult, peersResult] = await Promise.all([
        getDashboardData('network'),
        getDashboardData('peers'),
      ]);
      const normalized = normalizeNetworkData(
        networkResult.ok ? networkResult.data : null,
        peersResult.ok ? peersResult.data : null,
      );
      const models = collectPeerModels(normalized.peers);
      if (models.length > 0) {
        return models;
      }
    } catch {
      // Ignore model catalog fetch failures and fall back to current snapshot.
    }
    return discoveredChatModels;
  }, [discoveredChatModels, getDashboardData, getDashboardPort]);

  const chatModelOptions = useMemo(() => {
    const byId = new Map<string, string>();
    if (discoveredChatModels.length > 0) {
      for (const model of discoveredChatModels) {
        if (!byId.has(model)) {
          byId.set(model, modelLabel(model));
        }
      }
    } else {
      for (const pinned of PINNED_MODELS) {
        byId.set(pinned.id, pinned.label);
      }
    }
    if (!byId.has(chatModel)) {
      byId.set(chatModel, modelLabel(chatModel));
    }
    return Array.from(byId.entries()).map(([id, label]) => ({ id, label }));
  }, [chatModel, discoveredChatModels]);

  useEffect(() => {
    if (discoveredChatModels.length === 0) return;
    const resolved = resolvePeerModelId(chatModel, discoveredChatModels);
    if (!resolved || resolved === chatModel) return;
    setChatModel(resolved);
    appendSystemLog(`Aligned chat model to peer-advertised ID "${resolved}".`);
  }, [appendSystemLog, chatModel, discoveredChatModels]);

  const filteredPeers = useMemo(() => {
    const lowerFilter = peerFilter.trim().toLowerCase();
    const source = normalizedNetwork.peers;
    if (!lowerFilter) {
      return source;
    }
    return source.filter((peer) => {
      const search = [
        peer.peerId,
        peer.displayName ?? '',
        peer.source,
        peer.providers.join(' '),
        peer.models.join(' '),
        peer.location ?? '',
        formatEndpoint(peer),
      ].join(' ').toLowerCase();
      return search.includes(lowerFilter);
    });
  }, [normalizedNetwork.peers, peerFilter]);

  const sortedPeers = useMemo(() => {
    return sortItems(filteredPeers as unknown as Record<string, unknown>[], peerSort.key, peerSort.dir) as unknown as NetworkPeer[];
  }, [filteredPeers, peerSort]);

  const statusPayload = useMemo(() => safeRecord(dashboardData.status.data), [dashboardData.status.data]);
  const earningsPayload = useMemo(() => safeRecord(dashboardData.earnings.data), [dashboardData.earnings.data]);
  const sessionsPayload = useMemo(() => safeRecord(dashboardData.sessions.data), [dashboardData.sessions.data]);
  const dataSourcesPayload = useMemo(() => safeRecord(dashboardData.dataSources.data), [dashboardData.dataSources.data]);

  const activeSessions = useMemo(() => {
    const daemonRoot = safeRecord(daemonState?.state);
    const daemonCount = safeNumber(daemonRoot.activeSessions, 0);
    const daemonDetailsCount = safeArray(daemonRoot.activeSessionDetails).length;
    const fromStatus = safeNumber(statusPayload.activeSessions, 0);
    const fromSessions = safeNumber(sessionsPayload.total, 0);
    return Math.max(fromStatus, fromSessions, daemonCount, daemonDetailsCount);
  }, [daemonState?.state, sessionsPayload.total, statusPayload.activeSessions]);

  const sessionsRows = useMemo(() => {
    const rows = safeArray<Record<string, unknown>>(sessionsPayload.sessions);
    if (rows.length > 0) {
      return sortItems(rows, sessionSort.key, sessionSort.dir);
    }

    if (activeSessions <= 0) {
      return [];
    }

    const now = Date.now();
    const daemonRoot = safeRecord(daemonState?.state);
    const daemonDetails = safeArray<Record<string, unknown>>(daemonRoot.activeSessionDetails)
      .map((entry, index) => ({
        sessionId: safeString(entry.sessionId, `live-${index + 1}`),
        provider: safeString(entry.provider, 'live'),
        startedAt: safeNumber(entry.startedAt, now),
        totalTokens: safeNumber(entry.totalTokens, 0),
        totalRequests: safeNumber(entry.totalRequests, 0),
        durationMs: Math.max(0, now - safeNumber(entry.startedAt, now)),
        avgLatencyMs: safeNumber(entry.avgLatencyMs, 0),
        peerSwitches: 0,
      }));
    if (daemonDetails.length > 0) {
      return sortItems(daemonDetails as unknown as Record<string, unknown>[], sessionSort.key, sessionSort.dir);
    }

    return Array.from({ length: activeSessions }, (_, index) => ({
      sessionId: `live-${index + 1}`,
      provider: 'live',
      startedAt: now,
      totalTokens: 0,
      totalRequests: 0,
      durationMs: 0,
      avgLatencyMs: 0,
      peerSwitches: 0,
    }));
  }, [activeSessions, daemonState?.state, sessionSort.dir, sessionSort.key, sessionsPayload.sessions]);

  const topPeers = useMemo(() => normalizedNetwork.peers.slice(0, 6), [normalizedNetwork.peers]);

  const dhtState = useMemo(() => networkHealth(normalizedNetwork.stats, normalizedNetwork.peers.length), [
    normalizedNetwork.peers.length,
    normalizedNetwork.stats,
  ]);

  const openConversation = useCallback(async (conversationId: string) => {
    if (!bridge?.chatAiGetConversation) return;
    try {
      const result = await bridge.chatAiGetConversation(conversationId);
      if (!result.ok || !result.data) {
        setChatError(result.error ?? 'Conversation not found');
        return;
      }
      const parsed = parseChatConversation(result.data);
      if (!parsed) {
        setChatError('Failed to parse conversation');
        return;
      }
      setChatActiveConversation(parsed.id);
      setChatMessages(parsed.messages);
      setChatModel(parsed.model || CHAT_DEFAULT_MODEL);
      setChatThreadTitle(parsed.title);
      const totalTokens = safeNumber(parsed.totalTokens, 0)
        || safeNumber(parsed.usage?.inputTokens, 0) + safeNumber(parsed.usage?.outputTokens, 0);
      setChatThreadMeta(
        `${formatRelativeTime(parsed.updatedAt)} · ${formatCompactNumber(totalTokens)} tok · ${shortModelName(parsed.model)}`,
      );
      setChatError(null);
    } catch (err) {
      setChatError(maybeError(err, 'Failed to open conversation'));
    }
  }, []);

  const refreshChatAfterMutation = useCallback(async (preferredConversationId?: string) => {
    await refreshChatConversations();
    const target = preferredConversationId
      || chatActiveConversation
      || (chatConversations[0]?.id ?? null);
    if (target) {
      await openConversation(target);
    }
  }, [chatActiveConversation, chatConversations, openConversation, refreshChatConversations]);

  const createNewConversation = useCallback(async () => {
    if (!bridge?.chatAiCreateConversation) return;
    try {
      setChatError(null);
      const requestedModel = chatModel || CHAT_DEFAULT_MODEL;
      const peerModels = await fetchPeerModelCatalog();
      const modelToUse = resolvePeerModelId(requestedModel, peerModels)
        ?? peerModels[0]
        ?? requestedModel;
      if (modelToUse !== chatModel) {
        setChatModel(modelToUse);
      }
      if (modelToUse !== requestedModel) {
        appendSystemLog(`Using peer-advertised model "${modelToUse}" instead of "${requestedModel}".`);
      }

      const result = await bridge.chatAiCreateConversation(modelToUse);
      if (!result.ok || !result.data) {
        setChatError(result.error ?? 'Failed to create conversation');
        return;
      }
      const parsed = parseChatConversation(result.data);
      const conversationId = parsed?.id ?? safeString(safeRecord(result.data).id, '');
      if (!conversationId) {
        setChatError('Failed to create conversation');
        return;
      }
      await refreshChatAfterMutation(conversationId);
    } catch (err) {
      setChatError(maybeError(err, 'Failed to create conversation'));
    }
  }, [appendSystemLog, chatModel, fetchPeerModelCatalog, refreshChatAfterMutation]);

  const deleteConversation = useCallback(async () => {
    if (!chatActiveConversation || !bridge?.chatAiDeleteConversation) return;
    try {
      await bridge.chatAiDeleteConversation(chatActiveConversation);
      setChatActiveConversation(null);
      setChatMessages([]);
      setChatThreadTitle('Conversation');
      setChatThreadMeta('No conversation selected');
      setChatError(null);
      await refreshChatConversations();
    } catch (err) {
      setChatError(maybeError(err, 'Failed to delete conversation'));
    }
  }, [chatActiveConversation, refreshChatConversations]);

  const sendChatMessage = useCallback(async (inputOverride?: string) => {
    if (!chatActiveConversation || !bridge) return;
    const trimmed = safeString(inputOverride, chatInput).trim();
    if (trimmed.length === 0) return;

    const requestedModel = chatModel || CHAT_DEFAULT_MODEL;
    const peerModels = await fetchPeerModelCatalog();
    const modelToUse = resolvePeerModelId(requestedModel, peerModels)
      ?? peerModels[0]
      ?? requestedModel;

    if (modelToUse !== chatModel) {
      setChatModel(modelToUse);
    }
    if (modelToUse !== requestedModel) {
      appendSystemLog(`Routing chat with peer-advertised model "${modelToUse}" (requested "${requestedModel}").`);
    }

    const optimistic: ChatMessage = {
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    setChatMessages((current) => [...current, optimistic]);
    setChatInput('');
    setChatSending(true);
    setChatError(null);
    const startedAt = Date.now();
    setChatStreamingStartedAt(startedAt);
    setChatStreamingNow(startedAt);
    setChatStreamingLabel('Myrmecochory routing request...');

    try {
      const usesStreamingBridge = Boolean(bridge.chatAiSendStream);
      if (bridge.chatAiSendStream) {
        const result = await bridge.chatAiSendStream(chatActiveConversation, trimmed, modelToUse);
        if (!result.ok) {
          throw new Error(result.error ?? 'Request failed');
        }
      } else if (bridge.chatAiSend) {
        const result = await bridge.chatAiSend(chatActiveConversation, trimmed, modelToUse);
        if (!result.ok) {
          throw new Error(result.error ?? 'Request failed');
        }
      } else {
        throw new Error('Chat bridge unavailable');
      }

      if (usesStreamingBridge) {
        await refreshChatConversations();
      } else {
        await refreshChatAfterMutation(chatActiveConversation);
      }
    } catch (err) {
      setChatError(maybeError(err, 'Chat send failed'));
    } finally {
      setChatStreamingStartedAt(0);
      setChatStreamingLabel('Generating response...');
      setChatSending(false);
    }
  }, [
    appendSystemLog,
    chatActiveConversation,
    chatInput,
    chatModel,
    fetchPeerModelCatalog,
    refreshChatConversations,
    refreshChatAfterMutation,
  ]);

  const sendChatPrompt = useCallback(async (prompt: string) => {
    await sendChatMessage(prompt);
  }, [sendChatMessage]);

  const abortChat = useCallback(async () => {
    if (!bridge?.chatAiAbort) return;
    await bridge.chatAiAbort();
    setChatSending(false);
    setChatStreamingStartedAt(0);
    setChatStreamingLabel('Generating response...');
  }, []);

  const saveConfig = useCallback(async () => {
    const payload = {
      buyer: {
        proxyPort: settings.proxyPort,
        preferredProviders: settings.preferredProviders
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        maxPricing: {
          defaults: {
            inputUsdPerMillion: settings.buyerMaxInputUsdPerMillion,
            outputUsdPerMillion: settings.buyerMaxOutputUsdPerMillion,
          },
        },
        minPeerReputation: settings.minRep,
      },
      payments: {
        preferredMethod: settings.paymentMethod,
      },
    };

    setConfigSaving(true);
    try {
      const current = await getDashboardData('config');
      if (!current.ok) {
        throw new Error('Failed to read current config');
      }
      const root = safeRecord(current.data);
      const currentConfig = safeRecord(root.config ?? root);
      const merged = { ...currentConfig, ...payload };
      const response = await fetch(`http://127.0.0.1:${getDashboardPort()}/api/config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(merged),
      });
      if (!response.ok) {
        throw new Error('Failed to save configuration');
      }
      setConfigMessage('Configuration saved successfully');
      appendSystemLog('Configuration saved.');
      setSettingsPopulated(false);
      await refreshDashboardBundle();
    } catch (err) {
      setConfigMessage(`Error saving: ${maybeError(err, 'unknown error')}`);
    } finally {
      setConfigSaving(false);
    }
  }, [appendSystemLog, getDashboardData, getDashboardPort, refreshDashboardBundle, settings]);

  const withRuntimeAction = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
      await refreshAll();
    } catch (err) {
      const message = maybeError(err, 'Action failed');
      if (isProxyPortOccupiedMessage(message)) {
        setConnectWarning('Buyer proxy port is already in use. Stop the conflicting process or change `buyer.proxyPort` in config.');
      }
      appendSystemLog(`Action failed: ${message}`);
    }
  }, [appendSystemLog, refreshAll]);

  const scanDht = useCallback(async () => {
    if (!bridge?.scanNetwork) return;
    const result = await bridge.scanNetwork(getDashboardPort());
    if (!result.ok) {
      throw new Error(result.error ?? 'DHT scan failed');
    }
    appendSystemLog('Triggered immediate DHT scan.');
  }, [appendSystemLog, getDashboardPort]);

  const runPluginInstall = useCallback(async (packageName: string) => {
    if (!bridge?.pluginsInstall) return;
    setPluginInstallBusy(true);
    try {
      const result = await bridge.pluginsInstall(packageName);
      if (!result.ok) {
        throw new Error(result.error ?? `Failed to install ${packageName}`);
      }
      const packages = safeArray(result.plugins)
        .map((entry) => safeString(safeRecord(entry).package, ''))
        .filter((entry) => entry.length > 0);
      setInstalledPlugins(new Set(packages));
      appendSystemLog(`Installed ${packageName}.`);
      setPluginHints({ router: null });
    } finally {
      setPluginInstallBusy(false);
    }
  }, [appendSystemLog]);

  const showWalletAction = useCallback((message: string, tone: 'success' | 'error') => {
    setWalletActionMessage(message);
    setWalletActionTone(tone);
    window.setTimeout(() => {
      setWalletActionMessage((current) => (current === message ? '' : current));
      setWalletActionTone('');
    }, 6000);
  }, []);

  const handleWalletDeposit = useCallback(async () => {
    if (!bridge?.walletDeposit) return;
    if (!walletAmount || Number(walletAmount) <= 0) {
      showWalletAction('Enter a valid amount', 'error');
      return;
    }
    const result = await bridge.walletDeposit(walletAmount);
    if (result.ok) {
      showWalletAction(result.message ?? 'Deposit initiated', 'success');
      await refreshWalletInfo();
      return;
    }
    showWalletAction(result.error ?? 'Deposit failed', 'error');
  }, [refreshWalletInfo, showWalletAction, walletAmount]);

  const handleWalletWithdraw = useCallback(async () => {
    if (!bridge?.walletWithdraw) return;
    if (!walletAmount || Number(walletAmount) <= 0) {
      showWalletAction('Enter a valid amount', 'error');
      return;
    }
    const result = await bridge.walletWithdraw(walletAmount);
    if (result.ok) {
      showWalletAction(result.message ?? 'Withdrawal initiated', 'success');
      await refreshWalletInfo();
      return;
    }
    showWalletAction(result.error ?? 'Withdrawal failed', 'error');
  }, [refreshWalletInfo, showWalletAction, walletAmount]);

  const handleWcConnect = useCallback(async () => {
    if (!bridge?.walletConnectConnect) return;
    const result = await bridge.walletConnectConnect();
    if (!result.ok) {
      showWalletAction(result.error ?? 'Failed to connect wallet', 'error');
      return;
    }
    await refreshWcState();
  }, [refreshWcState, showWalletAction]);

  const handleWcDisconnect = useCallback(async () => {
    if (!bridge?.walletConnectDisconnect) return;
    const result = await bridge.walletConnectDisconnect();
    if (!result.ok) {
      showWalletAction(result.error ?? 'Failed to disconnect wallet', 'error');
      return;
    }
    await refreshWcState();
  }, [refreshWcState, showWalletAction]);

  useEffect(() => {
    if (!bridge) {
      appendSystemLog('Desktop bridge unavailable: preload failed to inject API.');
      return;
    }

    const unsubscribeLogs = bridge.onLog?.((event) => {
      setLogs((current) => {
        const next = [...current, event];
        return next.length > 1200 ? next.slice(next.length - 1200) : next;
      });

      const missingMatch = /Plugin\s+"([^"]+)"\s+not found/i.exec(safeString(event.line, ''));
      if (missingMatch?.[1]) {
        const missing = missingMatch[1].trim();
        setPluginHints((current) => {
          if (event.mode === 'connect') {
            return { ...current, router: resolveRouterPackageName(missing) };
          }
          return current;
        });
      }

      if (event.mode === 'connect' && isProxyPortOccupiedMessage(event.line)) {
        setConnectWarning('Buyer proxy port is already in use. Stop the conflicting process or change `buyer.proxyPort` in config.');
      }
    });

    const unsubscribeState = bridge.onState?.((nextProcesses) => {
      setProcesses(safeArray(nextProcesses));
      if (safeArray<RuntimeProcessState>(nextProcesses).some((entry) => entry.mode === 'connect' && entry.running)) {
        setConnectWarning(null);
      }
    });

    const unsubscribeWc = bridge.onWalletConnectStateChanged?.((state) => {
      setWcState(state);
    });

    const unsubscribeChatStreamStart = bridge.onChatAiStreamStart?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      const startedAt = Date.now();
      setChatSending(true);
      setChatError(null);
      setChatStreamingStartedAt(startedAt);
      setChatStreamingNow(startedAt);
      setChatStreamingLabel('Myrmecochory routing request...');
    });

    const unsubscribeChatStreamBlockStart = bridge.onChatAiStreamBlockStart?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      const blockIndex = Math.max(0, safeNumber(event.index, 0));
      const blockType = safeString(event.blockType, 'text');
      setChatMessages((current) => patchStreamingAssistantDraft(
        current,
        event.conversationId,
        (blocks) => {
          ensureStreamDraftBlock(blocks, blockIndex, blockType, {
            toolId: safeString(event.toolId, ''),
            toolName: safeString(event.toolName, ''),
          });
        },
      ));
    });

    const unsubscribeChatStreamDelta = bridge.onChatAiStreamDelta?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      const blockIndex = Math.max(0, safeNumber(event.index, 0));
      const blockType = safeString(event.blockType, 'text');
      const delta = safeString(event.text, '');
      if (delta.length === 0) {
        return;
      }

      setChatMessages((current) => patchStreamingAssistantDraft(
        current,
        event.conversationId,
        (blocks) => {
          const base = ensureStreamDraftBlock(blocks, blockIndex, blockType);
          if (blockType === 'thinking') {
            blocks[blockIndex] = {
              ...base,
              type: 'thinking',
              thinking: safeString(base.thinking, '') + delta,
            };
            return;
          }
          if (blockType === 'tool_result') {
            blocks[blockIndex] = {
              ...base,
              type: 'tool_result',
              content: safeString(base.content, '') + delta,
            };
            return;
          }
          blocks[blockIndex] = {
            ...base,
            type: 'text',
            text: safeString(base.text, '') + delta,
          };
        },
      ));
    });

    const unsubscribeChatStreamBlockStop = bridge.onChatAiStreamBlockStop?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      const blockIndex = Math.max(0, safeNumber(event.index, 0));
      const blockType = safeString(event.blockType, 'text');
      setChatMessages((current) => patchStreamingAssistantDraft(
        current,
        event.conversationId,
        (blocks) => {
          const nextInput = safeRecord(event.input);
          const base = ensureStreamDraftBlock(blocks, blockIndex, blockType, {
            toolId: safeString(event.toolId, ''),
            toolName: safeString(event.toolName, ''),
            input: nextInput,
          });
          if (blockType === 'tool_use') {
            blocks[blockIndex] = {
              ...base,
              type: 'tool_use',
              id: safeString(event.toolId, safeString(base.id, '')),
              name: safeString(event.toolName, safeString(base.name, 'tool')),
              input: Object.keys(nextInput).length > 0 ? nextInput : safeRecord(base.input),
            };
          }
        },
      ));
    });

    const unsubscribeChatStreamDone = bridge.onChatAiStreamDone?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      setChatSending(false);
      setChatStreamingStartedAt(0);
      setChatStreamingLabel('Generating response...');
      setChatMessages((current) => current.map((message) => {
        const meta = safeRecord(message.meta);
        if (
          message.role === 'assistant'
          && meta.__streaming === true
          && safeString(meta.__conversationId, '') === event.conversationId
        ) {
          return {
            ...message,
            meta: {
              ...meta,
              __streaming: false,
            },
          };
        }
        return message;
      }));
    });

    const unsubscribeChatStreamError = bridge.onChatAiStreamError?.((event) => {
      if (safeString(event.conversationId, '') !== chatActiveConversationRef.current) {
        return;
      }
      setChatError(safeString(event.error, 'Chat stream failed'));
      setChatSending(false);
      setChatStreamingStartedAt(0);
      setChatStreamingLabel('Generating response...');
      setChatMessages((current) => current.map((message) => {
        const meta = safeRecord(message.meta);
        if (
          message.role === 'assistant'
          && meta.__streaming === true
          && safeString(meta.__conversationId, '') === event.conversationId
        ) {
          return {
            ...message,
            meta: {
              ...meta,
              __streaming: false,
            },
          };
        }
        return message;
      }));
    });

    if (!startupTaskStartedRef.current) {
      startupTaskStartedRef.current = true;
      void (async () => {
        if (bridge.start) {
          try {
            await bridge.start({
              mode: 'dashboard',
              dashboardPort: getDashboardPort(),
            });
          } catch (err) {
            const msg = maybeError(err, 'Dashboard service failed');
            if (isProxyPortOccupiedMessage(msg)) {
              appendSystemLog('Local data service port already in use; reusing the existing service.');
            } else {
              appendSystemLog(`Background data service start failed: ${msg}`);
            }
          }
        }

        await refreshAllRef.current();
        await refreshPluginInventoryRef.current();

        let reuseExternalProxy = false;
        if (bridge.chatAiGetProxyStatus) {
          try {
            const proxyStatus = await bridge.chatAiGetProxyStatus();
            if (proxyStatus.ok && proxyStatus.data.running) {
              reuseExternalProxy = true;
              setConnectWarning(null);
              appendSystemLog(`Buyer proxy already reachable on port ${proxyStatus.data.port}; reusing existing proxy.`);
            }
          } catch (err) {
            appendSystemLog(`Proxy status check failed: ${maybeError(err, 'unknown error')}`);
          }
        }

        if (!reuseExternalProxy && !isModeRunningRef.current('connect') && bridge.start) {
          try {
            await bridge.start({
              mode: 'connect',
              router: 'local',
            });
            setConnectWarning(null);
            appendSystemLog('Buyer runtime auto-started for local proxy chat.');
            await refreshAllRef.current();
          } catch (err) {
            const msg = maybeError(err, 'Buyer auto-start failed');
            if (!msg.toLowerCase().includes('already running')) {
              if (isProxyPortOccupiedMessage(msg)) {
                setConnectWarning('Buyer proxy port is already in use. Stop the conflicting process or change `buyer.proxyPort` in config.');
              }
              appendSystemLog(`Buyer auto-start failed: ${msg}`);
            }
          }
        }
      })().catch((err) => {
        appendSystemLog(maybeError(err, 'Initialization failed'));
      });
    }

    refreshTimerRef.current = window.setInterval(() => {
      void refreshAllRef.current();
    }, POLL_INTERVAL_MS);

    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
      }
      unsubscribeLogs?.();
      unsubscribeState?.();
      unsubscribeWc?.();
      unsubscribeChatStreamStart?.();
      unsubscribeChatStreamBlockStart?.();
      unsubscribeChatStreamDelta?.();
      unsubscribeChatStreamBlockStop?.();
      unsubscribeChatStreamDone?.();
      unsubscribeChatStreamError?.();
    };
  }, [appendSystemLog, getDashboardPort]);

  useEffect(() => {
    if (chatActiveConversation) {
      void openConversation(chatActiveConversation);
    }
  }, [chatActiveConversation, openConversation]);

  useEffect(() => {
    void refreshDashboardBundle();
  }, [refreshDashboardBundle, shellState.earningsPeriod]);

  useEffect(() => {
    if (!chatSending || chatStreamingStartedAt <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setChatStreamingNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [chatSending, chatStreamingStartedAt]);

  const buyerRunning = isModeRunning('connect') || chatProxy.running;
  const connectProcess = processByMode('connect');
  const expectedRouterPlugin = pluginHints.router || resolveRouterPackageName('local');
  const routerInstalled = installedPlugins.has(expectedRouterPlugin);
  const modelSelectOptions = chatModelOptions.map((entry) => (
    <option key={entry.id} value={entry.id}>{entry.label}</option>
  ));
  const peerRows = sortedPeers.map((peer) => {
    const models = peer.models.filter((entry) => entry.trim().length > 0);
    return (
      <tr key={peer.peerId}>
        <td title={`${resolvePeerDisplayName(peer)}\n${peer.peerId}`}>
          <div className="peer-display-name">{resolvePeerDisplayName(peer)}</div>
          <div className="peer-display-id">{formatShortId(peer.peerId)}</div>
        </td>
        <td>{peer.source.toUpperCase()}</td>
        <td>
          {peer.providers.length > 0 ? peer.providers.join(', ') : 'n/a'}
          {models.length > 0 && <div className="peer-models-line">{`models: ${models.join(', ')}`}</div>}
        </td>
        <td>{formatPrice(peer.inputUsdPerMillion)}</td>
        <td>{formatPrice(peer.outputUsdPerMillion)}</td>
        <td>{peer.capacityMsgPerHour > 0 ? `${formatInt(peer.capacityMsgPerHour)}/h` : 'n/a'}</td>
        <td>{formatInt(peer.reputation)}</td>
        <td>{peer.location && peer.location.trim().length > 0 ? peer.location : '-'}</td>
        <td>{formatEndpoint(peer)}</td>
      </tr>
    );
  });

  const sessionRows = sessionsRows.map((session) => (
    <tr key={safeString(session.sessionId, `${safeString(session.provider, 'session')}-${safeNumber(session.startedAt, 0)}`)}>
      <td title={safeString(session.sessionId, '')}>{formatShortId(session.sessionId, 10, 6)}</td>
      <td>{safeString(session.provider, 'n/a')}</td>
      <td>{formatTimestamp(session.startedAt)}</td>
      <td>{formatInt(session.totalTokens)}</td>
      <td>{formatInt(session.totalRequests)}</td>
      <td>{formatDuration(session.durationMs)}</td>
      <td>{formatLatency(session.avgLatencyMs)}</td>
      <td>{formatInt(session.peerSwitches)}</td>
    </tr>
  ));

  const chatConversationRows = chatConversations.map((conversation) => {
    const active = conversation.id === chatActiveConversation;
    return (
      <button
        key={conversation.id}
        type="button"
        className={`chat-conv-item${active ? ' active' : ''}`}
        onClick={() => {
          setChatActiveConversation(conversation.id);
          void openConversation(conversation.id);
        }}
      >
        <div className="chat-conv-title">{conversation.title}</div>
        <div className="chat-conv-meta">
          {`${formatRelativeTime(conversation.updatedAt)} · ${shortModelName(conversation.model)}`}
        </div>
      </button>
    );
  });

  const chatRenderableMessages = useMemo<ChatRenderableMessage[]>(() => {
    return chatMessages
      .filter((message) => !isToolResultOnlyUserMessage(message))
      .map((message, index) => {
        const metaParts: string[] = [];
        if (message.createdAt) {
          metaParts.push(new Date(message.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }));
        }
        const meta = safeRecord(message.meta);
        if (safeString(meta.peerId, '')) metaParts.push(`peer ${formatShortId(meta.peerId, 8, 0)}`);
        if (safeString(meta.provider, '')) metaParts.push(safeString(meta.provider, ''));
        if (safeString(meta.model, '')) metaParts.push(shortModelName(meta.model));
        if (safeNumber(meta.totalTokens, 0) > 0) metaParts.push(`${formatCompactNumber(meta.totalTokens)} tok`);

        const stableMetaId = safeString(meta.messageId, '')
          || safeString(meta.id, '')
          || safeString(message.createdAt, '');
        return {
          id: `${message.role}-${stableMetaId}-${index}`,
          role: message.role,
          content: message.content,
          metaParts,
        };
      });
  }, [chatMessages]);

  const connectionStatusPayload = useMemo(() => {
    const payload = {
      buyerRuntime: buyerRunning ? 'connected' : 'offline',
      proxyPort: safeNumber(statusPayload.proxyPort, 0) || null,
      activeSessions,
      peerCount: normalizedNetwork.peers.length,
      dht: {
        health: dhtState.label,
        healthy: normalizedNetwork.stats.dhtHealthy,
        nodeCount: normalizedNetwork.stats.dhtNodeCount,
        lastScanAt: normalizedNetwork.stats.lastScanAt,
        lookupSuccessRate: normalizedNetwork.stats.lookupSuccessRate,
        averageLookupLatencyMs: normalizedNetwork.stats.averageLookupLatencyMs,
      },
    };
    return JSON.stringify(payload, null, 2);
  }, [
    activeSessions,
    buyerRunning,
    dhtState.label,
    normalizedNetwork.peers.length,
    normalizedNetwork.stats.averageLookupLatencyMs,
    normalizedNetwork.stats.dhtHealthy,
    normalizedNetwork.stats.dhtNodeCount,
    normalizedNetwork.stats.lastScanAt,
    normalizedNetwork.stats.lookupSuccessRate,
    statusPayload.proxyPort,
  ]);

  const connectionNotes = useMemo(() => {
    const lines = [
      `Buyer runtime: ${buyerRunning ? 'connected' : 'offline'}`,
      `Proxy port: ${safeNumber(statusPayload.proxyPort, 0) || 'not available'}`,
      `Active sessions: ${formatInt(activeSessions)}`,
      `DHT health: ${dhtState.label}`,
      `DHT nodes: ${formatInt(normalizedNetwork.stats.dhtNodeCount)}`,
      `Lookup success: ${Math.round(safeNumber(normalizedNetwork.stats.lookupSuccessRate, 0) * 100)}%`,
      `Avg lookup latency: ${formatLatency(normalizedNetwork.stats.averageLookupLatencyMs)}`,
      `Last scan: ${formatRelativeTime(normalizedNetwork.stats.lastScanAt)}`,
    ];
    if (safeString(normalizedNetwork.stats.healthReason, '').length > 0) {
      lines.push(`DHT reason: ${safeString(normalizedNetwork.stats.healthReason, '')}`);
    }
    const degraded = safeArray<string>(dataSourcesPayload.degradedReasons).filter((entry) => entry.trim().length > 0);
    if (degraded.length > 0) {
      lines.push(`Data source degraded: ${degraded.join(' | ')}`);
    }
    return lines.join('\n');
  }, [
    activeSessions,
    buyerRunning,
    dataSourcesPayload.degradedReasons,
    dhtState.label,
    normalizedNetwork.stats.averageLookupLatencyMs,
    normalizedNetwork.stats.dhtNodeCount,
    normalizedNetwork.stats.healthReason,
    normalizedNetwork.stats.lastScanAt,
    normalizedNetwork.stats.lookupSuccessRate,
    statusPayload.proxyPort,
  ]);

  const streamingElapsed = chatStreamingStartedAt > 0
    ? formatDuration(chatStreamingNow - chatStreamingStartedAt)
    : '';

  const walletAddress = safeString(walletInfo?.address, '');
  const walletEscrow = safeRecord(walletInfo?.escrow);
  const walletMetaTone: Tone = walletAddress ? 'active' : 'idle';
  const walletMetaLabel = walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : 'Not connected';
  const vm = {
    bridge,
    shellState,
    setActiveView,
    setEarningsPeriod,
    runtimeSummary,
    connectWarning,
    setConnectWarning,
    buyerRunning,
    connectProcess,
    withRuntimeAction,
    scanDht,
    refreshAll,
    setLogs,
    safeNumber,
    safeString,
    safeArray,
    safeRecord,
    formatDuration,
    formatInt,
    formatMoney,
    formatShortId,
    formatRelativeTime,
    toneClass,
    viewClass,
    refreshPluginInventory,
    pluginInstallBusy,
    routerInstalled,
    expectedRouterPlugin,
    runPluginInstall,
    normalizedNetwork,
    dhtState,
    statusPayload,
    activeSessions,
    topPeers,
    resolvePeerDisplayName,
    dashboardData,
    earningsPayload,
    peerFilter,
    setPeerFilter,
    peerSort,
    setPeerSort,
    peerRows,
    sessionsPayload,
    sessionSort,
    setSessionSort,
    sessionRows,
    walletMetaTone,
    walletMetaLabel,
    walletMessage,
    walletMode,
    setWalletModeState,
    refreshWcState,
    walletAddress,
    walletInfo,
    wcState,
    handleWcConnect,
    handleWcDisconnect,
    walletEscrow,
    walletAmount,
    setWalletAmount,
    handleWalletDeposit,
    handleWalletWithdraw,
    walletActionTone,
    walletActionMessage,
    chatModel,
    setChatModel,
    modelSelectOptions,
    chatProxy,
    createNewConversation,
    chatConversationRows,
    chatThreadTitle,
    chatThreadMeta,
    chatActiveConversation,
    deleteConversation,
    chatRenderableMessages,
    chatSending,
    chatStreamingStartedAt,
    chatStreamingLabel,
    streamingElapsed,
    chatInput,
    setChatInput,
    sendChatMessage,
    sendChatPrompt,
    abortChat,
    chatError,
    connectionStatusPayload,
    dataSourcesPayload,
    connectionNotes,
    saveConfig,
    configSaving,
    configMessage,
    settings,
    setSettings,
    daemonState,
    logs,
  };

  return vm;
}

export type DesktopViewModel = ReturnType<typeof useDesktopViewModel>;
