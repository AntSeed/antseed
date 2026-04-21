import type { DiscoverRow, RendererUiState } from '../core/state';
import type { BadgeTone } from '../core/state';
import { notifyUiStateChanged, notifyUiStateChangedSync } from '../core/store';
import { normalizeDiscoverRow, projectRowsToChatServiceOptions } from './discover-rows.js';
import type {
  ChatWorkspaceGitStatus,
  DesktopBridge,
} from '../types/bridge';
import type {
  ChatMessage,
  ContentBlock,
} from '../ui/components/chat/chat-shared';
import {
  cloneContentBlock,
  countBlocks,
  formatCompactNumber,
  formatUsd,
  getMyrmecochoryLabel,
  normalizeAssistantMeta,
  paymentLogToThinkingPhase,
  shortServiceName,
} from '../ui/components/chat/chat-shared';

type ChatConversationUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type ChatConversationSummary = {
  id: string;
  title?: string;
  service?: string;
  provider?: string;
  peerId?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  usage?: ChatConversationUsage;
  totalTokens?: number;
  totalEstimatedCostUsd?: number;
  [key: string]: unknown;
};

type ChatConversation = ChatConversationSummary & {
  messages?: ChatMessage[];
};

type ChatServiceCatalogEntry = {
  id?: string;
  label?: string;
  provider?: string;
  protocol?: string;
  count?: number;
  [key: string]: unknown;
};

type ChatModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  appendSystemLog: (message: string) => void;
  onPaymentCardShown?: () => void;
};

export type ChatModuleApi = {
  refreshChatServiceOptions: () => Promise<void>;
  refreshChatProxyStatus: () => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  refreshWorkspaceGitStatus: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, imageBase64?: string, imageMimeType?: string) => void;
  retryAfterPayment: () => void;
  abortChat: () => Promise<void>;
  handleServiceChange: (value: string, explicitPeerId?: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  handleLogLineForThinkingPhase: (line: string) => void;
};

export function initChatModule({
  bridge,
  uiState,
  appendSystemLog,
  onPaymentCardShown,
}: ChatModuleOptions): ChatModuleApi {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const UNAVAILABLE_GIT_STATUS: ChatWorkspaceGitStatus = {
    available: false,
    rootPath: null,
    branch: null,
    isDetached: false,
    ahead: 0,
    behind: 0,
    stagedFiles: 0,
    modifiedFiles: 0,
    untrackedFiles: 0,
    error: null,
  };

  const fallbackChatServices: NormalizedChatServiceEntry[] = [];

  type NormalizedChatServiceEntry = Required<
    Pick<ChatServiceCatalogEntry, 'id' | 'label' | 'provider' | 'protocol' | 'count'>
  > & {
    peerId: string;
    peerLabel: string;
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    categories: string[];
    description: string;
  };
  type ChatServiceSelection = { id: string; provider: string | null; peerId?: string };
  type ChatServiceOption = ChatServiceSelection & { label: string; value: string };

  const CHAT_SERVICE_SELECTION_SEPARATOR = '\u0001';
  const CHAT_SERVICE_REFRESH_INTERVAL_MS = 60_000;
  // Faster retry during first-run setup while no services have been found yet.
  const CHAT_SERVICE_SETUP_REFRESH_INTERVAL_MS = 2_000;
  const CHAT_SERVICE_LIST_TIMEOUT_MS = 12_000;

  // ---------------------------------------------------------------------------
  // Module-local state
  // ---------------------------------------------------------------------------

  let activeConversation: ChatConversation | null = null;
  let streamingIndicatorTimer: number | null = null;
  let proxyState: 'unknown' | 'online' | 'offline' = 'unknown';
  let proxyPort = 0;
  let lastServiceOptionsSignature = '';
  let pendingServiceOptions: NormalizedChatServiceEntry[] | null = null;
  let lastServiceRefreshAt = 0;
  let serviceRefreshToken = 0;
  let serviceRefreshInProgress = false;
  let serviceSelectFocused = false;
  const sendingConversationIds = new Set<string>();
  const streamTurnsByConversation = new Map<string, number>();
  const streamStartedAtByConversation = new Map<string, number>();
  const localConversationMessages = new Map<string, ChatMessage[]>();
  const streamingMessagesByConversation = new Map<string, ChatMessage>();

  // ---------------------------------------------------------------------------
  // Payment approval helpers
  // ---------------------------------------------------------------------------

  async function fetchPeerInfo(peerId: string): Promise<void> {
    if (!bridge?.paymentsGetPeerInfo) return;
    try {
      const result = await bridge.paymentsGetPeerInfo(peerId);
      if (result.ok && result.data) {
        const now = Date.now() / 1000;
        const timestamp = result.data.timestamp || now;
        const ageDays = Math.floor((now - timestamp) / 86400);

        uiState.chatPaymentApprovalPeerInfo = {
          reputation: result.data.onChainChannelCount ?? result.data.reputation ?? 0,
          channelCount: result.data.onChainChannelCount ?? null,
          disputeCount: result.data.onChainGhostCount ?? null,
          networkAgeDays: ageDays > 0 ? ageDays : null,
          evmAddress: result.data.evmAddress ?? null,
        };
        notifyUiStateChanged();
      }
    } catch {
      // Silently fail — card shows without peer info
    }
  }

  function primePaymentApprovalState(amountBaseUnits: string): { peerId: string | null } {
    const selectedService = uiState.chatServiceOptions.find(
      (opt) => opt.value === uiState.chatSelectedServiceValue,
    );
    uiState.chatPaymentApprovalAmount = (Number(amountBaseUnits) / 1_000_000).toFixed(2);
    uiState.chatPaymentApprovalPeerId = selectedService?.peerId ?? null;
    uiState.chatPaymentApprovalPeerName = selectedService?.peerLabel ?? selectedService?.label ?? null;
    uiState.chatPaymentApprovalPeerInfo = null;
    uiState.chatPaymentApprovalError = null;
    return { peerId: selectedService?.peerId ?? null };
  }

  /**
   * Show the payment approval card with peer context from the currently
   * selected service, and kick off a fetchPeerInfo call for reputation data.
   */
  function showPaymentApprovalCard(amountBaseUnits: string): void {
    const { peerId } = primePaymentApprovalState(amountBaseUnits);
    uiState.chatPaymentApprovalVisible = true;
    notifyUiStateChanged();
    onPaymentCardShown?.();
    if (peerId) {
      void fetchPeerInfo(peerId);
    }
  }

  async function refreshAvailableCreditsUsdc(): Promise<number> {
    if (!bridge?.creditsGetInfo) {
      return parseFloat(uiState.creditsAvailableUsdc || '0');
    }

    try {
      const result = await bridge.creditsGetInfo();
      if (!result.ok || !result.data) {
        return parseFloat(uiState.creditsAvailableUsdc || '0');
      }

      uiState.creditsAvailableUsdc = result.data.availableUsdc;
      uiState.creditsReservedUsdc = result.data.reservedUsdc;
      uiState.creditsTotalUsdc = result.data.balanceUsdc;
      uiState.creditsCreditLimitUsdc = result.data.creditLimitUsdc;
      uiState.creditsEvmAddress = result.data.evmAddress;
      uiState.creditsOperatorAddress = result.data.operatorAddress ?? null;
      uiState.creditsLastRefreshedAt = Date.now();

      return parseFloat(result.data.availableUsdc || '0');
    } catch {
      return parseFloat(uiState.creditsAvailableUsdc || '0');
    }
  }

  async function handlePaymentRequired(amountBaseUnits: string): Promise<void> {
    const required = Number(amountBaseUnits) / 1_000_000;
    const available = await refreshAvailableCreditsUsdc();

    if (
      Number.isFinite(required)
      && required > 0
      && available >= required
    ) {
      uiState.chatPaymentApprovalVisible = false;
      uiState.chatPaymentApprovalPeerId = null;
      uiState.chatPaymentApprovalPeerName = null;
      uiState.chatPaymentApprovalPeerInfo = null;
      uiState.chatPaymentApprovalError = null;
      showChatError('Payment setup failed. Retry the request.');
      notifyUiStateChanged();
      return;
    }

    showPaymentApprovalCard(amountBaseUnits);
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  function normalizeProviderId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  function normalizeChatServiceId(service: unknown): string {
    return String(service ?? '').trim();
  }

  function encodeChatServiceSelection(serviceId: string, provider: string | null, peerId?: string): string {
    const normalizedServiceId = normalizeChatServiceId(serviceId);
    if (!normalizedServiceId) return '';
    const normalizedProvider = normalizeProviderId(provider);
    const base = normalizedProvider
      ? `${normalizedProvider}${CHAT_SERVICE_SELECTION_SEPARATOR}${normalizedServiceId}`
      : normalizedServiceId;
    const normalizedPeerId = peerId?.trim();
    return normalizedPeerId
      ? `${base}${CHAT_SERVICE_SELECTION_SEPARATOR}${normalizedPeerId}`
      : base;
  }

  function decodeChatServiceSelection(value: unknown): ChatServiceSelection {
    const raw = String(value ?? '');
    if (!raw) return { id: '', provider: null };
    const parts = raw.split(CHAT_SERVICE_SELECTION_SEPARATOR);
    if (parts.length === 1) return { id: normalizeChatServiceId(raw), provider: null };
    // Format: "provider\x01service" or "provider\x01service\x01peerId"
    const provider = normalizeProviderId(parts[0]);
    const id = normalizeChatServiceId(parts[1]);
    const peerId = parts[2]?.trim() || undefined;
    return { id, provider, peerId };
  }

  function findMatchingChatServiceOptionValue(
    options: ChatServiceOption[],
    targetServiceId: unknown,
    targetProvider?: unknown,
    targetPeerId?: unknown,
  ): string | null {
    const serviceId = normalizeChatServiceId(targetServiceId);
    if (!serviceId) return null;
    const provider = normalizeProviderId(targetProvider);
    const peerId = typeof targetPeerId === 'string' ? targetPeerId.trim() : '';
    if (peerId && provider) {
      const exactPeer = options.find(
        (o) => o.id === serviceId && o.provider === provider && o.peerId === peerId,
      );
      if (exactPeer) return exactPeer.value;
    }
    if (peerId) {
      const peerMatch = options.find((o) => o.id === serviceId && o.peerId === peerId);
      if (peerMatch) return peerMatch.value;
    }
    if (provider) {
      const exact = options.find((o) => o.id === serviceId && o.provider === provider);
      if (exact) return exact.value;
    }
    const fallback = options.find((o) => o.id === serviceId);
    return fallback?.value ?? null;
  }

  function computeServiceOptionsSignature(options: NormalizedChatServiceEntry[]): string {
    return options
      .map(
        (e) =>
          `${e.id}|${e.label}|${e.provider}|${e.protocol}|${String(e.count)}|${String(e.inputUsdPerMillion)}|${String(e.outputUsdPerMillion)}|${e.categories.join(',')}`,
      )
      .join('\n');
  }

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  function getConversationSummaries(): ChatConversationSummary[] {
    return Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[])
      : [];
  }

  function getActiveConversationId(): string | null {
    return typeof uiState.chatActiveConversation === 'string'
      ? uiState.chatActiveConversation
      : null;
  }

  function getConversationId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const id = (payload as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  function getConversationTokenCounts(conv: ChatConversationSummary) {
    const usage = (conv as Record<string, unknown>)?.usage as
      | ChatConversationUsage
      | undefined;
    const inputTokens = Math.max(0, Math.floor(Number(usage?.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(usage?.outputTokens) || 0));
    const totalFromUsage = inputTokens + outputTokens;
    const totalFromSummary = Math.max(0, Math.floor(Number(conv?.totalTokens) || 0));
    return {
      inputTokens,
      outputTokens,
      totalTokens: totalFromSummary > 0 ? totalFromSummary : totalFromUsage,
    };
  }

  function formatChatDateTime(timestamp: unknown): string {
    if (!timestamp || Number(timestamp) <= 0) return 'n/a';
    const d = new Date(Number(timestamp));
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatElapsedMs(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function toErrorMessage(err: unknown, fallback = 'Unexpected error'): string {
    if (typeof err === 'string' && err.trim().length > 0) return err;
    if (
      err &&
      typeof err === 'object' &&
      'message' in err &&
      typeof err.message === 'string' &&
      err.message.trim().length > 0
    ) {
      return err.message;
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Message helpers
  // ---------------------------------------------------------------------------

  function isToolResultOnlyMessage(msg: ChatMessage): boolean {
    return (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      (msg.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')
    );
  }

  function visibleMessages(messages: unknown[]): ChatMessage[] {
    if (!Array.isArray(messages)) return [];
    return (messages as ChatMessage[]).filter((msg) => !isToolResultOnlyMessage(msg));
  }

  function isConnectRunning(): boolean {
    const processes = Array.isArray(uiState.processes) ? uiState.processes : [];
    return processes.some(
      (proc) => proc && proc.mode === 'connect' && Boolean(proc.running),
    );
  }

  function normalizeRouterLabel(routerRaw: unknown): string {
    const raw = String(routerRaw || '').trim().toLowerCase();
    if (!raw) return 'local';
    if (
      raw === 'claude-code' ||
      raw === '@antseed/router-local' ||
      raw === 'antseed-router-local' ||
      raw === 'router-local'
    ) {
      return 'local';
    }
    return raw;
  }

  // ---------------------------------------------------------------------------
  // Display state updates (no DOM — writes to uiState + notifies React)
  // ---------------------------------------------------------------------------

  function setServiceCatalogStatus(tone: BadgeTone, label: string): void {
    uiState.chatServiceStatus = { tone, label };
    notifyUiStateChanged();
  }

  function setServiceSelectLoading(loading: boolean): void {
    uiState.chatServiceSelectDisabled = loading;
    notifyUiStateChanged();
  }

  function setRuntimeActivity(tone: BadgeTone, message: string): void {
    uiState.runtimeActivity = { tone, message };
    notifyUiStateChanged();
  }

  function showChatError(message: unknown): void {
    uiState.chatError = toErrorMessage(message, 'Unexpected chat error');
    notifyUiStateChanged();
  }

  function clearChatError(): void {
    uiState.chatError = null;
    notifyUiStateChanged();
  }

  function reportChatError(err: unknown, fallback: string): string {
    const message = toErrorMessage(err, fallback);
    showChatError(message);
    appendSystemLog(`Chat error: ${message}`);
    return message;
  }

  function formatGenericChatStatus(): string {
    const buyerConnected = isConnectRunning();
    const router = normalizeRouterLabel(uiState.connectRouterValue);
    const peerCount = Array.isArray(uiState.lastPeers) ? uiState.lastPeers.length : 0;
    const peerText = `${peerCount} peer${peerCount === 1 ? '' : 's'}`;
    const proxyText =
      proxyState === 'online'
        ? `Proxy ${proxyPort > 0 ? `:${proxyPort}` : 'online'}`
        : proxyState === 'offline'
          ? 'Proxy offline'
          : 'Proxy n/a';
    return `Buyer ${buyerConnected ? 'connected' : 'offline'} · Router ${router} · ${peerText} · ${proxyText}`;
  }

  function updateStreamingIndicator(): void {
    const genericStatus = formatGenericChatStatus();
    const activeConvId = uiState.chatActiveConversation;
    const activeSending = activeConvId ? sendingConversationIds.has(activeConvId) : uiState.chatSending;
    const activeStreamTurn = activeConvId ? streamTurnsByConversation.get(activeConvId) ?? null : null;
    const activeStreamStartedAt = activeConvId ? streamStartedAtByConversation.get(activeConvId) ?? 0 : 0;
    const elapsedMs =
      activeStreamStartedAt > 0 ? Date.now() - activeStreamStartedAt : 0;
    const elapsedText = elapsedMs > 0 ? ` · ${formatElapsedMs(elapsedMs)}` : '';

    if (activeStreamTurn !== null && activeSending) {
      const label = getMyrmecochoryLabel(activeStreamTurn);
      uiState.chatStreamingIndicatorText = `Turn ${activeStreamTurn} · ${label}${elapsedText} · ${genericStatus}`;
    } else if (activeSending) {
      uiState.chatStreamingIndicatorText = `Generating response...${elapsedText} · ${genericStatus}`;
    } else {
      uiState.chatStreamingIndicatorText = genericStatus;
    }

    uiState.chatStreamingActive = activeSending;
    uiState.chatThinkingElapsedMs = activeSending ? elapsedMs : 0;
    notifyUiStateChanged();
  }

  function updateThreadMeta(conv: ChatConversation | null): void {
    if (!conv) {
      uiState.chatThreadMeta = 'No conversation selected';
      uiState.chatRoutedPeer = '';
      uiState.chatRoutedPeerId = '';
      uiState.chatSessionStarted = '';
      uiState.chatSessionReservedUsdc = '';
      uiState.chatSessionAccumulatedCostUsd = '';
      uiState.chatSessionTotalTokens = '';
      uiState.chatLifetimeSpentUsdc = '';
      uiState.chatLifetimeTotalTokens = '';
      uiState.chatLifetimeSessions = '';
      return;
    }

    const messages = visibleMessages(conv.messages || []);
    let toolCalls = 0;
    let reasoningBlocks = 0;
    let totalEstimatedCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const servingPeers = new Set<string>();
    let lastServingPeerId = '';

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const counts = countBlocks(msg.content as ContentBlock[]);
        toolCalls += counts.toolUse;
        reasoningBlocks += counts.thinking;
      }
      const meta = normalizeAssistantMeta(msg);
      if (meta) {
        if (meta.peerId) {
          servingPeers.add(meta.peerId);
          lastServingPeerId = meta.peerId;
        }
        if (meta.costUsd > 0) totalEstimatedCostUsd += meta.costUsd;
        totalInputTokens += meta.inputTokens;
        totalOutputTokens += meta.outputTokens;
      }
    }

    const parts = [
      `session ${String(conv.id || '').slice(0, 8) || 'n/a'}`,
      shortServiceName(conv.service),
      `${messages.length} msg${messages.length === 1 ? '' : 's'}`,
    ];
    if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
    if (reasoningBlocks > 0) parts.push(`${reasoningBlocks} reasoning`);

    // Prefer message-derived token counts (always up-to-date) over stale conv.usage
    const msgTotalTokens = totalInputTokens + totalOutputTokens;
    const tokenCounts = msgTotalTokens > 0
      ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: msgTotalTokens }
      : getConversationTokenCounts(conv);
    parts.push(
      `tokens ${formatCompactNumber(tokenCounts.totalTokens)} (${formatCompactNumber(tokenCounts.inputTokens)} in / ${formatCompactNumber(tokenCounts.outputTokens)} out)`,
    );
    if (totalEstimatedCostUsd > 0) {
      parts.push(`cost $${formatUsd(totalEstimatedCostUsd)}`);
    } else if (tokenCounts.totalTokens > 0) {
      parts.push('cost n/a');
    }
    if (servingPeers.size > 0) {
      parts.push(
        `${servingPeers.size} serving peer${servingPeers.size === 1 ? '' : 's'}`,
      );
    }
    if (conv.createdAt) parts.push(`started ${formatChatDateTime(conv.createdAt)}`);
    parts.push(`updated ${formatChatDateTime(conv.updatedAt)}`);

    uiState.chatThreadMeta = parts.join(' · ');
    // When a peer is pinned, always show it — don't switch based on response metadata.
    if (uiState.chatSelectedPeerId) {
      const pinnedOption = uiState.chatServiceOptions.find((o) => o.peerId === uiState.chatSelectedPeerId);
      uiState.chatRoutedPeer = pinnedOption?.peerLabel || uiState.chatSelectedPeerId.slice(0, 8);
    } else if (lastServingPeerId) {
      const knownPeer = Array.isArray(uiState.lastPeers)
        ? uiState.lastPeers.find((p) => p.peerId === lastServingPeerId)
        : undefined;
      const shortId = lastServingPeerId.slice(0, 8);
      uiState.chatRoutedPeer = knownPeer?.displayName
        ? `${knownPeer.displayName} (${shortId})`
        : shortId;
    } else {
      uiState.chatRoutedPeer = '';
    }

    const resolvedPeerId = resolveConversationPeerId(conv) || lastServingPeerId;
    uiState.chatRoutedPeerId = resolvedPeerId;
    // Only set fallback values for fields the metering endpoint hasn't populated yet.
    // This prevents flicker: updateThreadMeta runs first with message-derived data,
    // then fetchAndApplyMeteringStats overwrites with authoritative data.
    if (!uiState.chatSessionStarted) {
      uiState.chatSessionStarted = conv.createdAt ? formatChatDateTime(conv.createdAt) : '';
    }
    if (!uiState.chatSessionTotalTokens && tokenCounts.totalTokens > 0) {
      uiState.chatSessionTotalTokens = formatCompactNumber(tokenCounts.totalTokens);
    }
  }

  // ---------------------------------------------------------------------------
  // Metering stats from buyer proxy endpoint (source of truth)
  // ---------------------------------------------------------------------------

  function resolveConversationPeerId(conv: ChatConversation | null): string {
    if (!conv) return '';
    if (uiState.chatSelectedPeerId) return uiState.chatSelectedPeerId;
    const convPeerId = conv.peerId?.trim() ?? '';
    if (convPeerId) return convPeerId;
    // Fallback: resolve from service options (the service maps to a peer)
    const serviceOption = uiState.chatServiceOptions.find(
      (o) => o.value === uiState.chatSelectedServiceValue || o.id === conv.service,
    );
    if (serviceOption?.peerId) return serviceOption.peerId;
    // Last resort: extract peerId from the encoded service value (format: "provider\x01service\x01peerId")
    const parts = uiState.chatSelectedServiceValue.split(CHAT_SERVICE_SELECTION_SEPARATOR);
    return parts.length >= 3 ? parts[2]!.trim() : '';
  }

  type MeteringPeerStats = {
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reservedUsdc: string | null;
    consumedUsdc: string | null;
    channelStatus: string | null;
    reservedAt: number | null;
    lifetimeSessions: number;
    lifetimeRequests: number;
    lifetimeInputTokens: number;
    lifetimeOutputTokens: number;
    lifetimeTotalTokens: number;
    lifetimeAuthorizedUsdc: string;
    lifetimeFirstSessionAt: number | null;
  };

  async function fetchAndApplyMeteringStats(sellerPeerId: string): Promise<void> {
    const port = uiState.chatProxyPort;
    if (!port) return;
    try {
      const prev = {
        tokens: uiState.chatSessionTotalTokens,
        cost: uiState.chatSessionAccumulatedCostUsd,
        reserved: uiState.chatSessionReservedUsdc,
        started: uiState.chatSessionStarted,
        ltSpent: uiState.chatLifetimeSpentUsdc,
        ltTokens: uiState.chatLifetimeTotalTokens,
        ltSessions: uiState.chatLifetimeSessions,
      };
      const url = `http://127.0.0.1:${port}/_antseed/metering/${encodeURIComponent(sellerPeerId)}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const stats = (await resp.json()) as MeteringPeerStats;
      if (stats.totalTokens > 0) {
        uiState.chatSessionTotalTokens = formatCompactNumber(stats.totalTokens);
      }
      // reservedUsdc and consumedUsdc are USDC amounts stored as 6-decimal bigint strings
      if (stats.reservedUsdc) {
        const reservedNum = Number(stats.reservedUsdc) / 1_000_000;
        if (reservedNum > 0) uiState.chatSessionReservedUsdc = formatUsd(reservedNum);
      }
      if (stats.consumedUsdc) {
        const consumedNum = Number(stats.consumedUsdc) / 1_000_000;
        if (consumedNum > 0) uiState.chatSessionAccumulatedCostUsd = formatUsd(consumedNum);
      }
      if (stats.reservedAt) {
        uiState.chatSessionStarted = formatChatDateTime(stats.reservedAt);
      }
      // Lifetime totals across all sessions with this peer
      const lifetimeSpent = Number(stats.lifetimeAuthorizedUsdc || '0') / 1_000_000;
      if (lifetimeSpent > 0) uiState.chatLifetimeSpentUsdc = formatUsd(lifetimeSpent);
      if (stats.lifetimeTotalTokens > 0) uiState.chatLifetimeTotalTokens = formatCompactNumber(stats.lifetimeTotalTokens);
      if (stats.lifetimeSessions > 1) uiState.chatLifetimeSessions = String(stats.lifetimeSessions);

      if (uiState.chatSessionTotalTokens !== prev.tokens ||
          uiState.chatSessionAccumulatedCostUsd !== prev.cost ||
          uiState.chatSessionReservedUsdc !== prev.reserved ||
          uiState.chatSessionStarted !== prev.started ||
          uiState.chatLifetimeSpentUsdc !== prev.ltSpent ||
          uiState.chatLifetimeTotalTokens !== prev.ltTokens ||
          uiState.chatLifetimeSessions !== prev.ltSessions) {
        notifyUiStateChanged();
      }
    } catch {
      // Buyer proxy unavailable — keep message-derived values
    }
  }

  let _meteringDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedFetchMeteringStats(peerId: string): void {
    if (_meteringDebounceTimer) clearTimeout(_meteringDebounceTimer);
    _meteringDebounceTimer = setTimeout(() => {
      _meteringDebounceTimer = null;
      void fetchAndApplyMeteringStats(peerId);
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Streaming indicator timer
  // ---------------------------------------------------------------------------

  function clearStreamingIndicatorTimer(): void {
    if (streamingIndicatorTimer !== null) {
      clearInterval(streamingIndicatorTimer);
      streamingIndicatorTimer = null;
    }
  }

  function ensureStreamingIndicatorTimer(): void {
    if (streamingIndicatorTimer !== null) return;
    streamingIndicatorTimer = window.setInterval(() => {
      if (sendingConversationIds.size === 0 && !uiState.chatSending) {
        clearStreamingIndicatorTimer();
        return;
      }
      updateStreamingIndicator();
    }, 1000);
  }

  function isConversationSending(convId: string | null | undefined): boolean {
    return Boolean(convId && sendingConversationIds.has(convId));
  }

  function publishSendingConversationIds(): void {
    // Snapshot the set into the uiState so the Sidebar can show a running
    // indicator for every in-flight conversation (not just the active one).
    uiState.chatSendingConversationIds =
      sendingConversationIds.size === 0 ? [] : Array.from(sendingConversationIds);
  }

  function syncActiveConversationSendingState(): void {
    const activeConvId = uiState.chatActiveConversation;
    const sending = isConversationSending(activeConvId);
    publishSendingConversationIds();
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = sending ? activeConvId : null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    uiState.chatThinkingPhase = null;
    clearThinkingPhaseExpiry();

    if (sendingConversationIds.size > 0 || sending) {
      ensureStreamingIndicatorTimer();
    } else {
      clearStreamingIndicatorTimer();
    }

    updateStreamingIndicator();
  }

  function setConversationSending(convId: string, sending: boolean): void {
    if (sending) {
      sendingConversationIds.add(convId);
      if (!streamStartedAtByConversation.has(convId)) {
        streamStartedAtByConversation.set(convId, Date.now());
      }
    } else {
      sendingConversationIds.delete(convId);
      streamTurnsByConversation.delete(convId);
      streamStartedAtByConversation.delete(convId);
    }
    syncActiveConversationSendingState();
  }

  function setChatSending(sending: boolean): void {
    const activeConvId = uiState.chatActiveConversation;
    if (activeConvId) {
      setConversationSending(activeConvId, sending);
      return;
    }
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    uiState.chatWaitingForStream = sending;
    if (!sending) {
      uiState.chatThinkingPhase = null;
      clearThinkingPhaseExpiry();
    }
    if (sending) {
      ensureStreamingIndicatorTimer();
    } else if (sendingConversationIds.size === 0) {
      clearStreamingIndicatorTimer();
    }
    updateStreamingIndicator();
  }

  // ---------------------------------------------------------------------------
  // Scroll helper
  // ---------------------------------------------------------------------------

  function scrollChatToBottom(): void {
    const container = document.querySelector<HTMLElement>('[data-chat-scroll]');
    if (!container) return;
    const threshold = 100;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < threshold) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function queueScrollChatToBottom(): void {
    requestAnimationFrame(() => {
      scrollChatToBottom();
    });
  }

  function cloneStreamingMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      meta: message.meta ? { ...message.meta } : undefined,
      content: Array.isArray(message.content)
        ? (message.content as ContentBlock[]).map(cloneContentBlock)
        : message.content,
    };
  }

  function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => cloneStreamingMessage(message));
  }

  function setLocalConversationMessages(convId: string, messages: ChatMessage[]): void {
    localConversationMessages.set(convId, cloneMessages(messages));
  }

  function getLocalConversationMessages(convId: string): ChatMessage[] | null {
    const cached = localConversationMessages.get(convId);
    return cached ? cloneMessages(cached) : null;
  }

  function setStreamingMessage(message: ChatMessage | null): void {
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
    notifyUiStateChangedSync();
    if (message) queueScrollChatToBottom();
  }

  function getConversationStreamingMessage(convId: string): ChatMessage | null {
    const message = streamingMessagesByConversation.get(convId);
    return message ? cloneStreamingMessage(message) : null;
  }

  function hasConversationStreamingMessage(convId: string): boolean {
    return streamingMessagesByConversation.has(convId);
  }

  function setConversationStreamingMessage(convId: string, message: ChatMessage | null): void {
    if (message) {
      streamingMessagesByConversation.set(convId, cloneStreamingMessage(message));
    } else {
      streamingMessagesByConversation.delete(convId);
    }

    if (uiState.chatActiveConversation === convId) {
      setStreamingMessage(message);
    }
  }

  function updateStreamingMessage(convId: string, mutator: (message: ChatMessage) => void): void {
    const current = streamingMessagesByConversation.get(convId);
    if (!current) return;
    const next = cloneStreamingMessage(current);
    mutator(next);
    setConversationStreamingMessage(convId, next);
  }

  // ---------------------------------------------------------------------------
  // Service management
  // ---------------------------------------------------------------------------

  function getAvailableChatServiceOptions(): ChatServiceOption[] {
    if (uiState.chatServiceOptions.length > 0) {
      return uiState.chatServiceOptions
        .map((entry): ChatServiceOption | null => {
          const selection = decodeChatServiceSelection(entry.value);
          if (!selection.id) return null;
          return {
            id: selection.id,
            label: entry.label,
            provider: selection.provider,
            peerId: selection.peerId ?? entry.peerId ?? undefined,
            value: entry.value,
          };
        })
        .filter((opt): opt is ChatServiceOption => opt !== null);
    }

    return fallbackChatServices.map((entry) => ({
      id: normalizeChatServiceId(entry.id),
      label: String(entry.label ?? entry.id),
      provider: normalizeProviderId(entry.provider),
      value: encodeChatServiceSelection(entry.id, entry.provider),
    }));
  }

  function getSelectedChatServiceSelection(): ChatServiceSelection {
    const selectedValue = decodeChatServiceSelection(uiState.chatSelectedServiceValue);
    if (selectedValue.id.length > 0) return selectedValue;

    const conversationModel = normalizeChatServiceId(activeConversation?.service);
    if (conversationModel.length > 0) {
      return {
        id: conversationModel,
        provider: normalizeProviderId(activeConversation?.provider),
      };
    }

    if (uiState.chatServiceOptions.length > 0) {
      const firstOption = decodeChatServiceSelection(uiState.chatServiceOptions[0].value);
      if (firstOption.id.length > 0) return firstOption;
    }

    return { id: '', provider: null };
  }

  function applyChatServiceOptions(entries: NormalizedChatServiceEntry[]): void {
    const currentSelection = decodeChatServiceSelection(uiState.chatSelectedServiceValue);
    const activeConversationModel = normalizeChatServiceId(activeConversation?.service);
    const activeConversationProvider = normalizeProviderId(activeConversation?.provider);

    const unique = new Map<string, NormalizedChatServiceEntry>();
    for (const entry of entries) {
      const key = `${entry.peerId || entry.provider}${CHAT_SERVICE_SELECTION_SEPARATOR}${entry.id}`;
      if (!entry.id || unique.has(key)) continue;
      unique.set(key, entry);
    }

    const options = Array.from(unique.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.id.localeCompare(b.id);
    });

    const optionCandidates: ChatServiceOption[] = options.map((entry) => ({
      id: entry.id,
      provider: normalizeProviderId(entry.provider),
      peerId: entry.peerId || undefined,
      label: entry.label,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
    }));

    const activeConversationPeerId = activeConversation?.peerId?.trim() ?? '';
    const preferred =
      findMatchingChatServiceOptionValue(
        optionCandidates,
        currentSelection.id,
        currentSelection.provider,
        currentSelection.peerId,
      ) ??
      findMatchingChatServiceOptionValue(
        optionCandidates,
        activeConversationModel,
        activeConversationProvider,
        activeConversationPeerId,
      ) ??
      optionCandidates[0]?.value ??
      '';

    const nextSignature = computeServiceOptionsSignature(options);
    if (
      nextSignature === lastServiceOptionsSignature &&
      uiState.chatSelectedServiceValue === preferred
    ) {
      return;
    }

    if (options.length === 0) {
      uiState.chatServiceOptions = [];
      uiState.chatSelectedServiceValue = '';
      lastServiceOptionsSignature = '';
      notifyUiStateChanged();
      return;
    }

    uiState.chatServiceOptions = options.map((entry) => ({
      id: entry.id,
      label: entry.label,
      provider: entry.provider,
      protocol: entry.protocol,
      count: entry.count,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
      peerId: entry.peerId,
      peerLabel: entry.peerLabel,
      inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion,
      categories: entry.categories,
      description: entry.description,
    }));

    uiState.chatSelectedServiceValue = preferred;
    lastServiceOptionsSignature = nextSignature;
    notifyUiStateChanged();
  }

  function updateChatServiceOptions(entries: NormalizedChatServiceEntry[]): void {
    if (serviceSelectFocused) {
      pendingServiceOptions = entries;
      return;
    }
    applyChatServiceOptions(entries);
  }

  async function listChatServicesWithTimeout(
    refreshToken: number,
  ): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    if (!bridge?.chatAiListDiscoverRows) {
      return { ok: false, data: [], error: 'Service catalog bridge unavailable' };
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<{
        ok: boolean;
        data?: unknown[];
        error?: string;
      }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            ok: false,
            data: [],
            error: `Service discovery timed out after ${String(CHAT_SERVICE_LIST_TIMEOUT_MS)}ms`,
          });
        }, CHAT_SERVICE_LIST_TIMEOUT_MS);
      });

      const result = await Promise.race([bridge.chatAiListDiscoverRows(), timeoutPromise]);

      if (refreshToken !== serviceRefreshToken) {
        return { ok: false, data: [], error: 'stale service refresh' };
      }
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async function refreshChatServiceOptions(): Promise<void> {
    // Skip if a fetch is already in-flight — the 12s timeout outlasts the 5s poll
    // cycle, so without this guard every result gets a stale token and is dropped.
    if (serviceRefreshInProgress) return;
    serviceRefreshInProgress = true;

    const refreshToken = ++serviceRefreshToken;
    const fallback = fallbackChatServices.map((entry) => ({ ...entry }));

    if (!bridge?.chatAiListDiscoverRows) {
      updateChatServiceOptions(fallback);
      setServiceCatalogStatus('warn', 'Services unavailable');
      setRuntimeActivity('warn', 'Service catalog unavailable (bridge missing).');
      serviceRefreshInProgress = false;
      return;
    }

    setServiceCatalogStatus('warn', 'Loading services...');
    setRuntimeActivity('warn', 'Loading service catalog from peers...');
    setServiceSelectLoading(true);
    try {
      const result = await listChatServicesWithTimeout(refreshToken);
      if (refreshToken !== serviceRefreshToken) return;

      if (!result.ok || !Array.isArray(result.data)) {
        updateChatServiceOptions(fallback);
        setServiceCatalogStatus('warn', result.error || 'Services unavailable');
        setRuntimeActivity('warn', result.error || 'Service catalog unavailable.');
        return;
      }

      const rawRows = Array.isArray(result.data) ? result.data : [];
      const rows = rawRows
        .map((raw) => normalizeDiscoverRow(raw))
        .filter((row): row is DiscoverRow => row !== null);
      uiState.discoverRows = rows;
      const optionsToRender = rows.length > 0 ? projectRowsToChatServiceOptions(rows) : fallback;
      updateChatServiceOptions(optionsToRender);
      setServiceCatalogStatus(
        optionsToRender.length > 0 ? 'active' : 'warn',
        optionsToRender.length > 0
          ? `Services ready (${String(optionsToRender.length)})`
          : 'No services available',
      );
      setRuntimeActivity(
        optionsToRender.length > 0 ? 'active' : 'warn',
        optionsToRender.length > 0
          ? `Service catalog ready (${String(optionsToRender.length)} services)`
          : 'Discovering services',
      );
    } catch (error) {
      if (refreshToken !== serviceRefreshToken) return;
      updateChatServiceOptions(fallback);
      const message = toErrorMessage(error, 'Failed to load services');
      setServiceCatalogStatus('warn', message);
      setRuntimeActivity('bad', message);
    } finally {
      serviceRefreshInProgress = false;
      if (refreshToken === serviceRefreshToken) {
        setServiceSelectLoading(false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy status
  // ---------------------------------------------------------------------------

  async function refreshChatProxyStatus(): Promise<void> {
    const previousProxyState = proxyState;
    if (!bridge || !bridge.chatAiGetProxyStatus) {
      proxyState = 'unknown';
      proxyPort = 0;
      setServiceCatalogStatus('idle', 'Services idle');
      updateStreamingIndicator();
      return;
    }

    try {
      const result = await bridge.chatAiGetProxyStatus();
      if (result.ok && result.data) {
        const { running, port } = result.data;
        if (running) {
          proxyState = 'online';
          proxyPort = Number(port) || 0;
          uiState.chatProxyPort = proxyPort;
          uiState.chatProxyStatus = { tone: 'active', label: `Proxy :${port}` };
          notifyUiStateChanged();
          // Proxy just became available — fetch metering stats for active conversation
          if (activeConversation) {
            const peerId = resolveConversationPeerId(activeConversation);
            if (peerId) debouncedFetchMeteringStats(peerId);
          }
          if (previousProxyState !== 'online') {
            setRuntimeActivity(
              'active',
              `Buyer proxy online on :${String(proxyPort || port)}.`,
            );
          }
        } else {
          proxyState = 'offline';
          proxyPort = 0;
          uiState.chatProxyPort = 0;
          uiState.chatProxyStatus = { tone: 'idle', label: 'Proxy offline' };
          notifyUiStateChanged();
          setServiceCatalogStatus('idle', 'Services unavailable (proxy offline)');
          if (previousProxyState !== 'offline') {
            setRuntimeActivity('warn', 'Waiting for runtime.');
          }
        }
      }
    } catch {
      proxyState = 'offline';
      proxyPort = 0;
      uiState.chatProxyPort = 0;
      uiState.chatProxyStatus = { tone: 'idle', label: 'Proxy offline' };
      notifyUiStateChanged();
      setServiceCatalogStatus('idle', 'Services unavailable (proxy offline)');
      if (previousProxyState !== 'offline') {
        setRuntimeActivity('warn', 'Buyer proxy unreachable; retrying.');
      }
    } finally {
      const now = Date.now();
      const setupMode = uiState.appSetupComplete && uiState.chatServiceOptions.length === 0;
      const refreshInterval = setupMode
        ? CHAT_SERVICE_SETUP_REFRESH_INTERVAL_MS
        : CHAT_SERVICE_REFRESH_INTERVAL_MS;
      const shouldRefreshModels =
        proxyState === 'online' &&
        (previousProxyState !== 'online' ||
          now - lastServiceRefreshAt >= refreshInterval);
      if (shouldRefreshModels) {
        lastServiceRefreshAt = now;
        void refreshChatServiceOptions();
      }
      updateStreamingIndicator();
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation management
  // ---------------------------------------------------------------------------

  function syncActiveConversationSummary(
    conversations: ChatConversationSummary[],
  ): void {
    const activeId = getActiveConversationId();
    if (!activeId) return;

    const activeSummary = conversations.find((c) => c.id === activeId);
    if (!activeSummary) return;

    activeConversation = {
      ...(activeConversation || {}),
      ...activeSummary,
      messages: activeConversation?.messages || [],
    };
    updateThreadMeta(activeConversation);
  }

  async function refreshChatConversations(): Promise<void> {
    if (!bridge || !bridge.chatAiListConversations) return;

    try {
      const result = await bridge.chatAiListConversations();
      if (result.ok) {
        const conversations = Array.isArray(result.data)
          ? (result.data as ChatConversationSummary[])
          : [];
        uiState.chatConversations = conversations;
        syncActiveConversationSummary(conversations);
        notifyUiStateChanged();
      }
    } catch {
      // Chat unavailable
    } finally {
      uiState.chatConversationsLoaded = true;
      updateStreamingIndicator();
    }
  }

  async function refreshWorkspace(): Promise<void> {
    if (!bridge?.chatAiGetWorkspace) return;

    try {
      const result = await bridge.chatAiGetWorkspace();
      if (result.ok && result.data) {
        uiState.chatWorkspacePath = result.data.current;
        uiState.chatWorkspaceDefaultPath = result.data.default;
        notifyUiStateChanged();
        await refreshWorkspaceGitStatus();
      }
    } catch {
      // Workspace selection unavailable
    }
  }

  async function refreshWorkspaceGitStatus(): Promise<void> {
    if (!bridge?.chatAiGetWorkspaceGitStatus) return;

    try {
      const result = await bridge.chatAiGetWorkspaceGitStatus();
      if (result.ok && result.data) {
        uiState.chatWorkspaceGitStatus = result.data as ChatWorkspaceGitStatus;
      } else {
        uiState.chatWorkspaceGitStatus = {
          ...UNAVAILABLE_GIT_STATUS,
          error: result.error || null,
        };
      }
      notifyUiStateChanged();
    } catch (error) {
      uiState.chatWorkspaceGitStatus = {
        ...UNAVAILABLE_GIT_STATUS,
        error: error instanceof Error ? error.message : String(error),
      };
      notifyUiStateChanged();
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (!bridge?.pickDirectory || !bridge.chatAiSetWorkspace) return;

    try {
      const picked = await bridge.pickDirectory();
      if (!picked.ok || !picked.path) {
        return;
      }

      const result = await bridge.chatAiSetWorkspace(picked.path);
      if (!result.ok || !result.data) {
        showChatError(result.error || 'Failed to set workspace');
        return;
      }

      uiState.chatWorkspacePath = result.data.current;
      uiState.chatWorkspaceDefaultPath = result.data.default;
      uiState.chatError = null;
      startNewChat();
      await refreshChatConversations();
      await refreshWorkspaceGitStatus();
      notifyUiStateChanged();
    } catch (err) {
      reportChatError(err, 'Failed to set workspace');
    }
  }

  async function openConversation(convId: string): Promise<void> {
    if (!bridge || !bridge.chatAiGetConversation) return;

    uiState.chatActiveConversation = convId;
    uiState.chatRoutedPeerId = '';
    uiState.chatSelectedPeerId = '';
    uiState.chatSessionStarted = '';
    uiState.chatSessionReservedUsdc = '';
    uiState.chatSessionAccumulatedCostUsd = '';
    uiState.chatSessionTotalTokens = '';
    uiState.chatLifetimeSpentUsdc = '';
    uiState.chatLifetimeTotalTokens = '';
    uiState.chatLifetimeSessions = '';

    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (result.ok && result.data) {
        const conv = result.data as ChatConversation;
        const serverMessages = Array.isArray(conv.messages) ? conv.messages : [];
        const shouldPreferLocalMessages =
          hasConversationStreamingMessage(convId) || isConversationSending(convId);
        const nextMessages =
          shouldPreferLocalMessages
            ? (getLocalConversationMessages(convId) ?? serverMessages)
            : serverMessages;
        activeConversation = {
          ...conv,
          messages: nextMessages,
        };
        uiState.chatMessages = nextMessages;
        uiState.chatStreamingMessage = getConversationStreamingMessage(convId);
        uiState.chatConversationTitle = String(conv.title || 'Conversation');
        uiState.chatDeleteVisible = true;
        syncActiveConversationSendingState();

        const optionCandidates = getAvailableChatServiceOptions();
        const convPeerIdForMatch = conv.peerId?.trim() ?? '';
        const preferredValue = findMatchingChatServiceOptionValue(
          optionCandidates,
          conv.service,
          conv.provider,
          convPeerIdForMatch,
        );
        if (preferredValue) {
          uiState.chatSelectedServiceValue = preferredValue;
          const matchedOption = optionCandidates.find((o) => o.value === preferredValue);
          if (matchedOption?.peerId) {
            uiState.chatSelectedPeerId = matchedOption.peerId;
          }
        }
        if (!uiState.chatSelectedPeerId && convPeerIdForMatch) {
          uiState.chatSelectedPeerId = convPeerIdForMatch;
        }

        setLocalConversationMessages(convId, uiState.chatMessages as ChatMessage[]);
        updateThreadMeta(activeConversation);
        uiState.chatError = null;
        notifyUiStateChanged();

        const peerId = resolveConversationPeerId(activeConversation);
        if (peerId) debouncedFetchMeteringStats(peerId);
      } else {
        reportChatError(result.error, 'Failed to open conversation');
      }
    } catch (err) {
      reportChatError(err, 'Failed to open conversation');
    }
  }

  function startNewChat(): void {
    uiState.chatActiveConversation = null;
    uiState.chatMessages = [];
    setStreamingMessage(null);
    activeConversation = null;
    uiState.chatDeleteVisible = false;
    uiState.chatInputDisabled = false;
    uiState.chatSendDisabled = false;
    uiState.chatConversationTitle = 'New Chat';
    uiState.chatError = null;
    updateThreadMeta(null);
    notifyUiStateChanged();
  }

  function materializeStreamingMessage(message: ChatMessage | null): ChatMessage | null {
    const current = message;
    if (!current) return null;
    const cloned = cloneStreamingMessage(current);
    // Strip synthetic renderKeys and IDs (e.g. "stream-text-0", "text-0") so that
    // when multiple turns get merged by buildDisplayMessages, getBlockRenderKey
    // falls back to the array-position index and avoids duplicate-key warnings.
    if (Array.isArray(cloned.content)) {
      for (const block of cloned.content as ContentBlock[]) {
        delete block.renderKey;
        if (typeof block.id === 'string' && /^(text|thinking)-[\d-]+$/.test(block.id)) {
          delete block.id;
        }
      }
    }
    return cloned;
  }

  function commitAssistantMessage(message: ChatMessage): void {
    const assistantMessage = {
      ...message,
      createdAt: message?.createdAt || Date.now(),
    };
    uiState.chatMessages = [...uiState.chatMessages, assistantMessage];
    if (uiState.chatActiveConversation) {
      setLocalConversationMessages(
        uiState.chatActiveConversation,
        uiState.chatMessages as ChatMessage[],
      );
    }
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Number(assistantMessage.createdAt) || Date.now();
      updateThreadMeta(activeConversation);
      const peerId = resolveConversationPeerId(activeConversation);
      if (peerId) debouncedFetchMeteringStats(peerId);
    }
  }

  function appendAssistantMessageToConversation(convId: string, message: ChatMessage): void {
    const assistantMessage = {
      ...message,
      createdAt: message?.createdAt || Date.now(),
    };
    const existingMessages = getLocalConversationMessages(convId) ?? [];
    setLocalConversationMessages(convId, [...existingMessages, assistantMessage]);
  }

  async function createNewConversation(): Promise<void> {
    if (!bridge || !bridge.chatAiCreateConversation) return;

    const selection = getSelectedChatServiceSelection();
    if (selection.id.length === 0) {
      showChatError(
        'No service is currently available. Start Buyer runtime and refresh services.',
      );
      return;
    }

    try {
      const result = await bridge.chatAiCreateConversation(selection.id, undefined, uiState.chatSelectedPeerId || undefined);
      if (result.ok && result.data) {
        const conversationId = getConversationId(result.data);
        if (!conversationId) {
          throw new Error('Conversation created but ID is missing');
        }
        await refreshChatConversations();
        await openConversation(conversationId);
        clearChatError();
      } else {
        reportChatError(result.error, 'Failed to create conversation');
      }
    } catch (err) {
      reportChatError(err, 'Failed to create conversation');
    }
  }

  async function deleteConversation(targetId?: string): Promise<void> {
    const convId = targetId || uiState.chatActiveConversation;
    if (!convId || !bridge || !bridge.chatAiDeleteConversation) return;

    try {
      await bridge.chatAiDeleteConversation(convId);
      localConversationMessages.delete(convId);
      streamingMessagesByConversation.delete(convId);
      sendingConversationIds.delete(convId);
      streamTurnsByConversation.delete(convId);
      streamStartedAtByConversation.delete(convId);
      // Publish the updated sending set (and resync active-conv UI) before we
      // potentially reset to new-chat state. This covers both the active and
      // non-active delete paths.
      syncActiveConversationSendingState();

      // If we deleted the active conversation, reset to new-chat state
      if (convId === uiState.chatActiveConversation) {
        startNewChat();
      }

      notifyUiStateChanged();
      await refreshChatConversations();
    } catch (err) {
      reportChatError(err, 'Failed to delete conversation');
    }
  }

  function renameConversation(convId: string, newTitle: string): void {
    const conversations = Array.isArray(uiState.chatConversations)
      ? (uiState.chatConversations as ChatConversationSummary[])
      : [];
    const conv = conversations.find((c) => c.id === convId);
    if (conv) {
      conv.title = newTitle;
      uiState.chatConversations = [...conversations];
    }
    if (convId === uiState.chatActiveConversation) {
      uiState.chatConversationTitle = newTitle;
    }
    notifyUiStateChanged();
    if (bridge?.chatAiRenameConversation) {
      void bridge.chatAiRenameConversation(convId, newTitle).catch((err: unknown) => {
        appendSystemLog(`Failed to persist conversation rename: ${String(err)}`);
      });
    }
  }

  function isInProgressErrorMessage(message: unknown): boolean {
    return String(message ?? '')
      .toLowerCase()
      .includes('already in progress');
  }

  function sendMessage(text: string, imageBase64?: string, imageMimeType?: string): void {
    if (!bridge) return;

    // Payment gate for paid services
    // Payment is handled by the node's 402-based flow — no pre-blocking here.
    // If the seller requires payment, the node returns a 402 with payment info.

    const content = text.trim();
    if (content.length === 0 && !imageBase64) return;

    // If no active conversation, create one first then send
    if (!uiState.chatActiveConversation) {
      setChatSending(true);
      void (async () => {
        await createNewConversation();
        if (uiState.chatActiveConversation) {
          setChatSending(false);
          sendMessage(text, imageBase64, imageMimeType);
        } else {
          setChatSending(false);
          showChatError('Failed to create a conversation. Please try again.');
        }
      })();
      return;
    }

    const convId = uiState.chatActiveConversation;
    if (isConversationSending(convId)) {
      showChatError('This conversation already has a request in progress.');
      return;
    }

    // Build message content — multipart if image attached, plain string otherwise
    const messageContent: unknown = imageBase64 && imageMimeType
      ? [
          { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
          { type: 'text', text: content || 'What is in this image?' },
        ]
      : content;

    uiState.chatMessages = [...uiState.chatMessages, { role: 'user', content: messageContent, createdAt: Date.now() }];
    setLocalConversationMessages(convId, uiState.chatMessages as ChatMessage[]);
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Date.now();
      updateThreadMeta(activeConversation);
    }
    notifyUiStateChanged();

    uiState.chatError = null;
    setConversationSending(convId, true);
    void refreshWorkspaceGitStatus();
    dispatchChatRequest(convId, content, imageBase64, imageMimeType);
  }

  /**
   * Shared send logic for both sendMessage and retryAfterPayment.
   * Dispatches via streaming or non-streaming bridge, handles stuck-request
   * recovery, payment-required errors, and fallback timeouts.
   */
  function dispatchChatRequest(
    convId: string,
    content: string,
    imageBase64?: string,
    imageMimeType?: string,
  ): void {
    if (!bridge) return;

    const selection = getSelectedChatServiceSelection();

    if (bridge.chatAiSendStream) {
      const sendStreamRequest = async () =>
        await bridge.chatAiSendStream!(
          convId,
          content || ' ',
          selection.id || undefined,
          undefined,
          imageBase64,
          imageMimeType,
        );

      void (async () => {
        try {
          let result = await sendStreamRequest();
          if (
            !result.ok &&
            isInProgressErrorMessage(result.error) &&
            bridge.chatAiAbort
          ) {
            appendSystemLog(
              'Detected stuck in-flight chat request. Aborting and retrying once...',
            );
            await bridge.chatAiAbort(convId).catch(() => undefined);
            result = await sendStreamRequest();
          }

          if (!result.ok) {
            const errorMsg = typeof result.error === 'string' ? result.error : '';
            const paymentMatch = /^payment_required:(\d+)$/i.exec(errorMsg);
            if (paymentMatch) {
              setConversationSending(convId, false);
              void handlePaymentRequired(paymentMatch[1]);
            } else {
              if (!uiState.chatError) {
                reportChatError(result.stopReason?.message ?? result.error, 'Request failed');
              }
              setConversationSending(convId, false);
            }
          }
        } catch (err) {
          reportChatError(err, 'Chat send failed');
          setConversationSending(convId, false);
        }
      })();
    } else if (bridge.chatAiSend) {
      void (async () => {
        try {
          const sendRequest = async () =>
            await bridge.chatAiSend!(
              convId,
              content || ' ',
              selection.id || undefined,
              undefined,
              imageBase64,
              imageMimeType,
            );

          let result = await sendRequest();
          if (
            !result.ok &&
            isInProgressErrorMessage(result.error) &&
            bridge.chatAiAbort
          ) {
            appendSystemLog(
              'Detected stuck in-flight chat request. Aborting and retrying once...',
            );
            await bridge.chatAiAbort(convId).catch(() => undefined);
            result = await sendRequest();
          }

          if (!result.ok) {
            reportChatError(result.error, 'Request failed');
          }
          setConversationSending(convId, false);
        } catch (err) {
          reportChatError(err, 'Chat send failed');
          setConversationSending(convId, false);
        }
      })();
    }
  }

  /**
   * Retry the last user message after a payment failure.  Dismisses the
   * payment-approval card and re-sends the most recent user message in the
   * active conversation.  Intended to be called when credits become
   * available after a 402 was returned.
   */
  function retryAfterPayment(): void {
    if (!bridge) return;

    // Dismiss payment card
    uiState.chatPaymentApprovalVisible = false;
    uiState.chatPaymentApprovalPeerId = null;
    uiState.chatPaymentApprovalPeerName = null;
    uiState.chatPaymentApprovalPeerInfo = null;
    uiState.chatPaymentApprovalLoading = false;
    uiState.chatPaymentApprovalError = null;
    uiState.chatError = null;
    notifyUiStateChanged();

    // Find the last user message to resend
    type MsgShape = { role?: string; content?: unknown };
    const lastUserMsg = ([...uiState.chatMessages] as MsgShape[]).reverse().find(m => m.role === 'user');
    if (!lastUserMsg || !uiState.chatActiveConversation) return;

    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : '';

    // Extract image from multipart content if present
    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    if (Array.isArray(lastUserMsg.content)) {
      const imgBlock = (lastUserMsg.content as Array<{ type: string; source?: { data?: string; media_type?: string } }>)
        .find(b => b.type === 'image');
      if (imgBlock?.source?.data) {
        imageBase64 = imgBlock.source.data;
        imageMimeType = imgBlock.source.media_type;
      }
    }

    const convId = uiState.chatActiveConversation;
    setConversationSending(convId, true);
    dispatchChatRequest(convId, content, imageBase64, imageMimeType);
  }

  async function abortChat(): Promise<void> {
    const convId = uiState.chatActiveConversation;
    if (bridge && bridge.chatAiAbort) {
      await bridge.chatAiAbort(convId ?? undefined);
    }
    if (convId) {
      setConversationSending(convId, false);
    } else {
      setChatSending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Service select handlers (called by ChatView)
  // ---------------------------------------------------------------------------

  function handleServiceChange(value: string, explicitPeerId?: string): void {
    uiState.chatSelectedServiceValue = value;
    pendingServiceOptions = null;

    // Prefer an explicit peerId (e.g. from a Discover card click) so we don't
    // depend on chatServiceOptions.value matching the encoded form exactly.
    // Fall back to looking up the option by value for the dropdown case.
    let peerId = explicitPeerId?.trim() ?? '';
    if (!peerId) {
      const selectedOption = uiState.chatServiceOptions.find((o) => o.value === value);
      peerId = selectedOption?.peerId || '';
    }
    uiState.chatSelectedPeerId = peerId;
    if (peerId && bridge?.chatAiSelectPeer) {
      void bridge.chatAiSelectPeer(peerId).catch(() => undefined);
    }

    notifyUiStateChanged();
  }

  function handleServiceFocus(): void {
    serviceSelectFocused = true;
  }

  function handleServiceBlur(): void {
    serviceSelectFocused = false;
    if (pendingServiceOptions) {
      const pending = pendingServiceOptions;
      pendingServiceOptions = null;
      applyChatServiceOptions(pending);
    }
  }

  function clearPinnedPeer(): void {
    uiState.chatSelectedPeerId = '';
    uiState.chatRoutedPeer = '';
    if (bridge?.chatAiSelectPeer) {
      void bridge.chatAiSelectPeer(null).catch(() => undefined);
    }
    notifyUiStateChanged();
  }

  // ---------------------------------------------------------------------------
  // Bridge callbacks
  // ---------------------------------------------------------------------------

  if (bridge) {
    void refreshWorkspace();
    // --- Non-streaming callbacks ---

    if (bridge.onChatAiDone) {
      bridge.onChatAiDone((data) => {
        const incomingMessage = data.message as ChatMessage;
        const isStreamingCommit = hasConversationStreamingMessage(data.conversationId);
        if (isStreamingCommit) {
          updateStreamingMessage(data.conversationId, (message) => {
            message.meta = {
              ...(message.meta ?? {}),
              ...(incomingMessage.meta ?? {}),
            };
            if (!message.createdAt && incomingMessage.createdAt) {
              message.createdAt = incomingMessage.createdAt;
            }
          });
        } else if (data.conversationId === uiState.chatActiveConversation) {
            commitAssistantMessage(incomingMessage);
            uiState.chatError = null;
            setConversationSending(data.conversationId, false);
            notifyUiStateChanged();
        }
        void refreshChatConversations();
        void refreshWorkspaceGitStatus();
      });
    }

    if (bridge.onChatAiError) {
      bridge.onChatAiError((data) => {
        setConversationSending(data.conversationId, false);
        if (data.conversationId === uiState.chatActiveConversation) {
          if (data.error !== 'Request aborted') {
            showChatError(data.error);
            appendSystemLog(`AI Chat error: ${data.error}`);
          }
        }
      });
    }

    if (bridge.onChatAiUserPersisted) {
      bridge.onChatAiUserPersisted((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;
        const last = (uiState.chatMessages[uiState.chatMessages.length - 1] ||
          null) as ChatMessage | null;
        if (last && last.role === 'user' && !last.createdAt) {
          last.createdAt = data.message?.createdAt || Date.now();
          setLocalConversationMessages(
            data.conversationId,
            uiState.chatMessages as ChatMessage[],
          );
          notifyUiStateChanged();
        }
      });
    }

    // --- Streaming callbacks ---

    function getStreamingBlocks(message: ChatMessage | null = uiState.chatStreamingMessage): ContentBlock[] {
      return message && Array.isArray(message.content)
        ? (message.content as ContentBlock[])
        : [];
    }

    function getStreamingBlockId(blockType: string, index: number | string): string {
      return `${blockType}-${String(index)}`;
    }

    function createStreamingRenderKey(blockType: string, index: number | string): string {
      return `stream-${blockType}-${String(index)}`;
    }

    function findLastStreamingThinkingBlock(blocks: ContentBlock[], index: number | string): ContentBlock | undefined {
      const contentIndex = String(index);
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (
          block?.type === 'thinking' &&
          String(block.details?.streamContentIndex ?? '') === contentIndex &&
          block.streaming
        ) {
          return block;
        }
      }
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (
          block?.type === 'thinking' &&
          String(block.details?.streamContentIndex ?? '') === contentIndex
        ) {
          return block;
        }
      }
      return undefined;
    }

    function findLastStreamingBlockByType(blocks: ContentBlock[], type: string): ContentBlock | undefined {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.type === type) return block;
      }
      return undefined;
    }

    if (bridge.onChatAiStreamStart) {
      bridge.onChatAiStreamStart((data) => {
        if (data.conversationId === uiState.chatActiveConversation) {
          uiState.chatError = null;
          notifyUiStateChanged();
        }

        if (isConversationSending(data.conversationId)) {
          streamTurnsByConversation.set(data.conversationId, Number(data.turn) + 1);
          streamStartedAtByConversation.set(data.conversationId, Date.now());
          updateStreamingIndicator();
        }
        if (!hasConversationStreamingMessage(data.conversationId)) {
          setConversationStreamingMessage(data.conversationId, {
            role: 'assistant',
            content: [],
            createdAt: Date.now(),
            meta: {},
          });
        }
      });
    }

    if (bridge.onChatAiStreamBlockStart) {
      bridge.onChatAiStreamBlockStart((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;

        if (
          data.conversationId === uiState.chatActiveConversation &&
          uiState.chatWaitingForStream
        ) {
          uiState.chatWaitingForStream = false;
          uiState.chatThinkingPhase = null;
          clearThinkingPhaseExpiry();
          notifyUiStateChanged();
        }

        if (data.blockType === 'text') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'text',
              renderKey: createStreamingRenderKey('text', blocks.length),
              text: '',
              streaming: true,
            });
            message.content = blocks;
          });
        } else if (data.blockType === 'thinking') {
          const turn = streamTurnsByConversation.get(data.conversationId) ?? 0;
          const thinkingLabel = getMyrmecochoryLabel(turn + Number(data.index || 0));
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = getStreamingBlocks(message);
            const thinkingInstance = blocks.filter((block) => block?.type === 'thinking').length;
            blocks.push({
              type: 'thinking',
              renderKey: createStreamingRenderKey('thinking', `${data.index}-${thinkingInstance}`),
              id: getStreamingBlockId('thinking', `${data.index}-${thinkingInstance}`),
              name: thinkingLabel,
              thinking: '',
              details: { streamContentIndex: String(data.index) },
              streaming: true,
            });
            message.content = blocks;
          });
        } else if (data.blockType === 'tool_use') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'tool_use',
              renderKey: createStreamingRenderKey('tool', data.toolId || blocks.length),
              id: String(data.toolId || getStreamingBlockId('tool', data.index)),
              name: String(data.toolName || 'tool'),
              status: 'running',
            });
            message.content = blocks;
          });
        }
      });
    }

    if (bridge.onChatAiStreamDelta) {
      bridge.onChatAiStreamDelta((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;

        if (data.blockType === 'text') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const textBlock = findLastStreamingBlockByType(blocks, 'text');
            if (textBlock) {
              textBlock.text = `${String(textBlock.text || '')}${data.text}`;
              textBlock.streaming = true;
            }
          });
        } else if (data.blockType === 'thinking') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const thinkingBlock = findLastStreamingThinkingBlock(blocks, data.index);
            if (thinkingBlock && thinkingBlock.type === 'thinking') {
              thinkingBlock.thinking = `${String(thinkingBlock.thinking || '')}${data.text}`;
              thinkingBlock.streaming = true;
            }
          });
        }
      });
    }

    if (bridge.onChatAiStreamBlockStop) {
      bridge.onChatAiStreamBlockStop((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;

        if (data.blockType === 'text') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const textBlock = findLastStreamingBlockByType(blocks, 'text');
            if (textBlock) {
              textBlock.streaming = false;
              // Extract inline <think>...</think> tags (DeepSeek, Qwen, etc.)
              // into proper thinking blocks so the UI renders them correctly.
              const raw = String(textBlock.text || '');
              const thinkMatch = raw.match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (thinkMatch) {
                const thinkingText = thinkMatch[1]!.trim();
                textBlock.text = raw.slice(thinkMatch[0].length);
                if (thinkingText) {
                  const idx = blocks.indexOf(textBlock);
                  blocks.splice(idx, 0, {
                    type: 'thinking',
                    renderKey: createStreamingRenderKey('thinking', `inline-${idx}`),
                    thinking: thinkingText,
                    streaming: false,
                  });
                }
              }
            }
          });
        } else if (data.blockType === 'thinking') {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            const thinkingBlock = findLastStreamingThinkingBlock(blocks, data.index);
            if (thinkingBlock && thinkingBlock.type === 'thinking') {
              thinkingBlock.streaming = false;
            }
          });
        } else if (data.blockType === 'tool_use' && data.input) {
          updateStreamingMessage(data.conversationId, (message) => {
            const blocks = message.content as ContentBlock[];
            let toolBlock = blocks.find(
              (block) => block.type === 'tool_use' && block.id === data.toolId,
            );
            // Fallback: the block may have been created with a placeholder ID
            // (e.g. "tool-0") when the real ID wasn't available at toolcall_start.
            if (!toolBlock && data.toolId) {
              const fallbackId = getStreamingBlockId('tool', data.index);
              toolBlock = blocks.find(
                (block) => block.type === 'tool_use' && block.id === fallbackId,
              );
              if (toolBlock) {
                toolBlock.id = data.toolId;
                toolBlock.renderKey = createStreamingRenderKey('tool', data.toolId);
              }
            }
            if (toolBlock) {
              toolBlock.input = data.input;
              if (data.toolName) toolBlock.name = String(data.toolName);
            }
          });
        }
      });
    }

    if (bridge.onChatAiToolExecuting) {
      bridge.onChatAiToolExecuting((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          // Fallback: match by tool name against placeholder blocks
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id) &&
                (block.name === data.name || block.name === 'tool'),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.name = String(data.name || toolBlock.name || 'tool');
            toolBlock.input = data.input;
            toolBlock.status = 'running';
          }
        });
      });
    }

    if (bridge.onChatAiToolUpdate) {
      bridge.onChatAiToolUpdate((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id) &&
                (block.name === data.name || block.name === 'tool'),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.name = String(data.name || toolBlock.name || 'tool');
            toolBlock.input = data.input;
            toolBlock.content = data.output;
            if (data.details) {
              toolBlock.details = data.details;
            }
            toolBlock.status = 'running';
          } else {
            appendSystemLog(`[chat] tool-update: block not found for toolUseId=${data.toolUseId}`);
          }
        });
      });
    }

    if (bridge.onChatAiToolResult) {
      bridge.onChatAiToolResult((data) => {
        if (!hasConversationStreamingMessage(data.conversationId)) return;
        updateStreamingMessage(data.conversationId, (message) => {
          const blocks = message.content as ContentBlock[];
          let toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
          if (!toolBlock && data.toolUseId) {
            toolBlock = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                /^tool-\d+$/.test(block.id),
            );
            if (toolBlock) {
              toolBlock.id = data.toolUseId;
              toolBlock.renderKey = createStreamingRenderKey('tool', data.toolUseId);
            }
          }
          if (toolBlock) {
            toolBlock.status = data.isError ? 'error' : 'success';
            toolBlock.content = data.output;
            toolBlock.is_error = data.isError;
            if (data.details) {
              toolBlock.details = data.details;
            }
          }
        });
      });
    }

    if (bridge.onBrowserPreviewOpen) {
      bridge.onBrowserPreviewOpen((data) => {
        uiState.browserPreviewUrl = data.url;
        uiState.browserPreviewRequestId += 1;
        notifyUiStateChanged();
      });
    }

    // Expose API for triggering browser preview programmatically (dev/testing only)
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__antseedOpenPreview = (url: string) => {
        uiState.browserPreviewUrl = url;
        uiState.browserPreviewRequestId += 1;
        notifyUiStateChanged();
      };
    }


    if (bridge.onChatAiStreamDone) {
      bridge.onChatAiStreamDone((data) => {
        const shouldClearSending = isConversationSending(data.conversationId);
        const startedAt = streamStartedAtByConversation.get(data.conversationId) ?? 0;
        const elapsedMs =
          startedAt > 0 && shouldClearSending
            ? Date.now() - startedAt
            : 0;

        const finalizedStreamingMessage = materializeStreamingMessage(
          getConversationStreamingMessage(data.conversationId),
        );

        if (data.conversationId === uiState.chatActiveConversation) {
          if (finalizedStreamingMessage) {
            commitAssistantMessage(finalizedStreamingMessage);
          }
          setConversationStreamingMessage(data.conversationId, null);
          if (shouldClearSending) {
            setConversationSending(data.conversationId, false);
          }
          uiState.chatError = null;
          notifyUiStateChanged();
        } else {
          if (finalizedStreamingMessage) {
            appendAssistantMessageToConversation(
              data.conversationId,
              finalizedStreamingMessage,
            );
          }
          setConversationStreamingMessage(data.conversationId, null);
          if (shouldClearSending) {
            setConversationSending(data.conversationId, false);
            notifyUiStateChanged();
          }
        }

        if (elapsedMs > 0) {
          appendSystemLog(
            `AI stream completed in ${(elapsedMs / 1000).toFixed(1)}s.`,
          );
        }

        void refreshChatConversations();
        void refreshWorkspaceGitStatus();
      });
    }

    if (bridge.onChatAiStreamError) {
      bridge.onChatAiStreamError((data) => {
        const shouldClearSending = isConversationSending(data.conversationId);
        const stopReason = data.stopReason;
        const stopReasonSummary = stopReason
          ? [
              stopReason.kind,
              stopReason.statusCode ? `status=${String(stopReason.statusCode)}` : null,
              stopReason.errorCode ? `code=${stopReason.errorCode}` : null,
              stopReason.retryable ? 'retryable' : 'non-retryable',
            ].filter(Boolean).join(', ')
          : 'unknown';
        setConversationStreamingMessage(data.conversationId, null);

        if (data.conversationId === uiState.chatActiveConversation) {
          // Ensure the waiting-for-stream flag is cleared even if the error fires
          // before chat:ai-stream-start is received (which is the only other place
          // this flag gets cleared), preventing a permanent UI spinner lock.
          uiState.chatWaitingForStream = false;
          notifyUiStateChanged();
          if (shouldClearSending) {
            setConversationSending(data.conversationId, false);
          }

          if (data.error !== 'Request aborted') {
            const errStr = typeof data.error === 'string' ? data.error : '';
            const paymentMatch = /^payment_required:(\d+)$/i.exec(errStr);
            if (paymentMatch) {
              void handlePaymentRequired(paymentMatch[1]);
              if (bridge.chatAiAbort) void bridge.chatAiAbort(data.conversationId).catch(() => {});
            } else {
              showChatError(stopReason?.message ?? data.error);
            }
            appendSystemLog(`AI Chat error (${stopReasonSummary}): ${data.error}`);
          }
        } else if (shouldClearSending) {
          setConversationSending(data.conversationId, false);
          notifyUiStateChanged();
        }
        void refreshWorkspaceGitStatus();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  updateThreadMeta(null);
  updateStreamingIndicator();
  void refreshChatServiceOptions();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  let thinkingPhaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearThinkingPhaseExpiry(): void {
    if (thinkingPhaseExpiryTimer !== null) {
      clearTimeout(thinkingPhaseExpiryTimer);
      thinkingPhaseExpiryTimer = null;
    }
  }

  function handleLogLineForThinkingPhase(line: string): void {
    if (!uiState.chatSending) return;
    const phase = paymentLogToThinkingPhase(line);
    if (!phase) return;
    clearThinkingPhaseExpiry();
    thinkingPhaseExpiryTimer = setTimeout(() => {
      thinkingPhaseExpiryTimer = null;
      if (uiState.chatThinkingPhase !== null) {
        uiState.chatThinkingPhase = null;
        notifyUiStateChanged();
      }
    }, 3500);
    if (uiState.chatThinkingPhase === phase) return;
    uiState.chatThinkingPhase = phase;
    notifyUiStateChanged();
  }

  return {
    handleLogLineForThinkingPhase,
    refreshChatServiceOptions,
    refreshChatProxyStatus,
    refreshChatConversations,
    refreshWorkspace,
    refreshWorkspaceGitStatus,
    chooseWorkspace,
    createNewConversation,
    startNewChat,
    deleteConversation,
    renameConversation,
    openConversation,
    sendMessage,
    retryAfterPayment,
    abortChat,
    handleServiceChange,
    handleServiceFocus,
    handleServiceBlur,
    clearPinnedPeer,
  };
}
