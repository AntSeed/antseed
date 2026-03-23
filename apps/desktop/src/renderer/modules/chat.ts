import type { RendererUiState } from '../core/state';
import type { BadgeTone } from '../core/state';
import { notifyUiStateChanged, notifyUiStateChangedSync } from '../core/store';
import type { DesktopBridge } from '../types/bridge';
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
};

export type ChatModuleApi = {
  refreshChatServiceOptions: () => Promise<void>;
  refreshChatProxyStatus: () => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, imageBase64?: string, imageMimeType?: string) => void;
  abortChat: () => Promise<void>;
  handleServiceChange: (value: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
};

export function initChatModule({
  bridge,
  uiState,
  appendSystemLog,
}: ChatModuleOptions): ChatModuleApi {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const fallbackChatServices: NormalizedChatServiceEntry[] = [];

  type NormalizedChatServiceEntry = Required<
    Pick<ChatServiceCatalogEntry, 'id' | 'label' | 'provider' | 'protocol' | 'count'>
  > & { peerId: string; peerLabel: string };
  type ChatServiceSelection = { id: string; provider: string | null };
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
  let activeStreamTurn: number | null = null;
  let activeStreamStartedAt = 0;
  let streamingIndicatorTimer: number | null = null;
  let proxyState: 'unknown' | 'online' | 'offline' = 'unknown';
  let proxyPort = 0;
  let lastServiceOptionsSignature = '';
  let pendingServiceOptions: NormalizedChatServiceEntry[] | null = null;
  let lastServiceRefreshAt = 0;
  let serviceRefreshToken = 0;
  let serviceRefreshInProgress = false;
  let serviceSelectFocused = false;
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
          reputation: result.data.onChainReputation ?? result.data.reputation ?? 0,
          sessionCount: result.data.onChainSessionCount ?? null,
          disputeCount: result.data.onChainDisputeCount ?? null,
          networkAgeDays: ageDays > 0 ? ageDays : null,
          evmAddress: result.data.evmAddress ?? null,
        };
        notifyUiStateChanged();
      }
    } catch {
      // Silently fail — card shows without peer info
    }
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

  function normalizeChatServiceEntry(raw: unknown): NormalizedChatServiceEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as ChatServiceCatalogEntry & { peerId?: string; peerLabel?: string };
    const id = normalizeChatServiceId(entry.id);
    if (!id) return null;
    const provider = String(entry.provider ?? '').trim().toLowerCase() || 'unknown';
    const protocol = String(entry.protocol ?? '').trim().toLowerCase() || 'unknown';
    const count = Math.max(0, Math.floor(Number(entry.count) || 0));
    const peerId = String(entry.peerId ?? '').trim();
    const peerLabel = String(entry.peerLabel ?? '').trim() || (peerId ? peerId.slice(0, 12) + '...' : '');
    const label = String(entry.label ?? '').trim() || `${id} · ${provider}`;
    return { id, label, provider, protocol, count, peerId, peerLabel };
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
    const separatorIndex = raw.indexOf(CHAT_SERVICE_SELECTION_SEPARATOR);
    if (separatorIndex === -1) return { id: normalizeChatServiceId(raw), provider: null };
    const provider = normalizeProviderId(raw.slice(0, separatorIndex));
    const id = normalizeChatServiceId(
      raw.slice(separatorIndex + CHAT_SERVICE_SELECTION_SEPARATOR.length),
    );
    return { id, provider };
  }

  function findMatchingChatServiceOptionValue(
    options: ChatServiceOption[],
    targetServiceId: unknown,
    targetProvider?: unknown,
  ): string | null {
    const serviceId = normalizeChatServiceId(targetServiceId);
    if (!serviceId) return null;
    const provider = normalizeProviderId(targetProvider);
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
          `${e.id}|${e.label}|${e.provider}|${e.protocol}|${String(e.count)}`,
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
    const elapsedMs =
      activeStreamStartedAt > 0 ? Date.now() - activeStreamStartedAt : 0;
    const elapsedText = elapsedMs > 0 ? ` · ${formatElapsedMs(elapsedMs)}` : '';

    if (activeStreamTurn !== null && uiState.chatSending) {
      const label = getMyrmecochoryLabel(activeStreamTurn);
      uiState.chatStreamingIndicatorText = `Turn ${activeStreamTurn} · ${label}${elapsedText} · ${genericStatus}`;
    } else if (uiState.chatSending) {
      uiState.chatStreamingIndicatorText = `Generating response...${elapsedText} · ${genericStatus}`;
    } else {
      uiState.chatStreamingIndicatorText = genericStatus;
    }

    uiState.chatStreamingActive = uiState.chatSending;
    uiState.chatThinkingElapsedMs = uiState.chatSending ? elapsedMs : 0;
    notifyUiStateChanged();
  }

  function updateThreadMeta(conv: ChatConversation | null): void {
    if (!conv) {
      uiState.chatThreadMeta = 'No conversation selected';
      uiState.chatRoutedPeer = '';
      return;
    }

    const messages = visibleMessages(conv.messages || []);
    let toolCalls = 0;
    let reasoningBlocks = 0;
    let totalEstimatedCostUsd = 0;
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
      }
    }

    const parts = [
      `session ${String(conv.id || '').slice(0, 8) || 'n/a'}`,
      shortServiceName(conv.service),
      `${messages.length} msg${messages.length === 1 ? '' : 's'}`,
    ];
    if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
    if (reasoningBlocks > 0) parts.push(`${reasoningBlocks} reasoning`);

    const tokenCounts = getConversationTokenCounts(conv);
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
      if (!uiState.chatSending) {
        clearStreamingIndicatorTimer();
        return;
      }
      updateStreamingIndicator();
    }, 1000);
  }

  function setChatSending(sending: boolean): void {
    uiState.chatSending = sending;
    uiState.chatSendingConversationId = sending ? (uiState.chatActiveConversation ?? null) : null;
    uiState.chatInputDisabled = sending;
    uiState.chatSendDisabled = sending;
    uiState.chatAbortVisible = sending;
    if (sending) uiState.chatWaitingForStream = true;
    if (!sending) uiState.chatWaitingForStream = false;

    if (sending) {
      if (activeStreamStartedAt <= 0) activeStreamStartedAt = Date.now();
      ensureStreamingIndicatorTimer();
    } else {
      clearStreamingIndicatorTimer();
      activeStreamTurn = null;
      activeStreamStartedAt = 0;
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
        .map((entry) => {
          const selection = decodeChatServiceSelection(entry.value);
          if (!selection.id) return null;
          return {
            id: selection.id,
            label: entry.label,
            provider: selection.provider,
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
      label: entry.label,
      value: encodeChatServiceSelection(entry.id, entry.provider, entry.peerId),
    }));

    const preferred =
      findMatchingChatServiceOptionValue(
        optionCandidates,
        currentSelection.id,
        currentSelection.provider,
      ) ??
      findMatchingChatServiceOptionValue(
        optionCandidates,
        activeConversationModel,
        activeConversationProvider,
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
    if (!bridge?.chatAiListServices) {
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

      const result = await Promise.race([bridge.chatAiListServices(), timeoutPromise]);

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

    if (!bridge?.chatAiListServices) {
      updateChatServiceOptions(fallback);
      setServiceCatalogStatus('warn', 'Services unavailable');
      setRuntimeActivity('warn', 'Service catalog unavailable (bridge missing).');
      serviceRefreshInProgress = false;
      return;
    }

    setServiceCatalogStatus('warn', 'Loading services...');
    setRuntimeActivity('warn', 'Loading service catalog from peers...');
    setServiceSelectLoading(true);
    console.log('[chat] refreshChatServiceOptions: fetching...');

    try {
      const result = await listChatServicesWithTimeout(refreshToken);
      console.log(`[chat] refreshChatServiceOptions: ok=${result.ok} entries=${Array.isArray(result.data) ? result.data.length : 0} error=${result.error ?? 'none'}`);
      if (refreshToken !== serviceRefreshToken) return;

      if (!result.ok || !Array.isArray(result.data)) {
        updateChatServiceOptions(fallback);
        setServiceCatalogStatus('warn', result.error || 'Services unavailable');
        setRuntimeActivity('warn', result.error || 'Service catalog unavailable.');
        return;
      }

      const parsed = result.data
        .map((entry) => normalizeChatServiceEntry(entry))
        .filter((entry): entry is NormalizedChatServiceEntry => entry !== null);
      const optionsToRender = parsed.length > 0 ? parsed : fallback;
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

  async function openConversation(convId: string): Promise<void> {
    if (!bridge || !bridge.chatAiGetConversation) return;

    uiState.chatActiveConversation = convId;

    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (result.ok && result.data) {
        const conv = result.data as ChatConversation;
        const serverMessages = Array.isArray(conv.messages) ? conv.messages : [];
        const shouldPreferLocalMessages =
          hasConversationStreamingMessage(convId) || uiState.chatSendingConversationId === convId;
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
        uiState.chatInputDisabled = false;
        uiState.chatSendDisabled = false;

        const optionCandidates = getAvailableChatServiceOptions();
        const preferredValue = findMatchingChatServiceOptionValue(
          optionCandidates,
          conv.service,
          conv.provider,
        );
        if (preferredValue) {
          uiState.chatSelectedServiceValue = preferredValue;
        }

        setLocalConversationMessages(convId, uiState.chatMessages as ChatMessage[]);
        updateThreadMeta(activeConversation);
        uiState.chatError = null;
        notifyUiStateChanged();
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
        if (typeof block.id === 'string' && /^(text|thinking)-\d+$/.test(block.id)) {
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

    if (uiState.chatSending) {
      showChatError('Another chat request is already in progress.');
      return;
    }

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
    setChatSending(true);

    const selection = getSelectedChatServiceSelection();

    if (bridge.chatAiSendStream) {
      const sendStreamRequest = async () =>
        await bridge.chatAiSendStream!(convId, content || ' ', selection.id || undefined, undefined, imageBase64, imageMimeType);

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
            await bridge.chatAiAbort().catch(() => undefined);
            result = await sendStreamRequest();
          }

          if (!result.ok) {
            reportChatError(result.error, 'Request failed');
            setChatSending(false);
          } else if (uiState.chatSending) {
            // Fallback timeout in case stream completion event is missed
            setTimeout(() => {
              if (!uiState.chatSending) return;
              setChatSending(false);
              clearChatError();
              void refreshChatConversations();
              if (uiState.chatActiveConversation) {
                void openConversation(uiState.chatActiveConversation);
              }
            }, 120_000);
          }
        } catch (err) {
          reportChatError(err, 'Chat send failed');
          setChatSending(false);
        }
      })();
    } else if (bridge.chatAiSend) {
      void (async () => {
        try {
          const sendRequest = async () =>
            await bridge.chatAiSend!(convId, content || ' ', selection.id || undefined, undefined, imageBase64, imageMimeType);

          let result = await sendRequest();
          if (
            !result.ok &&
            isInProgressErrorMessage(result.error) &&
            bridge.chatAiAbort
          ) {
            appendSystemLog(
              'Detected stuck in-flight chat request. Aborting and retrying once...',
            );
            await bridge.chatAiAbort().catch(() => undefined);
            result = await sendRequest();
          }

          if (!result.ok) {
            reportChatError(result.error, 'Request failed');
          }
          setChatSending(false);
        } catch (err) {
          reportChatError(err, 'Chat send failed');
          setChatSending(false);
        }
      })();
    }
  }

  async function abortChat(): Promise<void> {
    if (bridge && bridge.chatAiAbort) {
      await bridge.chatAiAbort();
    }
    setChatSending(false);
  }

  // ---------------------------------------------------------------------------
  // Service select handlers (called by ChatView)
  // ---------------------------------------------------------------------------

  function handleServiceChange(value: string): void {
    uiState.chatSelectedServiceValue = value;
    pendingServiceOptions = null;

    // Extract peerId from the selected option and trigger eager connection
    const selectedOption = uiState.chatServiceOptions.find((o) => o.value === value);
    const peerId = selectedOption?.peerId || '';
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
            setChatSending(false);
            notifyUiStateChanged();
        }
        void refreshChatConversations();
      });
    }

    if (bridge.onChatAiError) {
      bridge.onChatAiError((data) => {
        if (data.conversationId === uiState.chatActiveConversation) {
          setChatSending(false);
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

        if (data.conversationId === uiState.chatSendingConversationId) {
          activeStreamTurn = Number(data.turn) + 1;
          activeStreamStartedAt = Date.now();
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
          const thinkingLabel = getMyrmecochoryLabel(
            (activeStreamTurn || 0) + Number(data.index || 0),
          );
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
            if (textBlock) textBlock.streaming = false;
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
            const toolBlock = blocks.find(
              (block) => block.type === 'tool_use' && block.id === data.toolId,
            );
            if (toolBlock) {
              toolBlock.input = data.input;
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
          const toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
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
          const toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
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
          const toolBlock = blocks.find(
            (block) => block.type === 'tool_use' && block.id === data.toolUseId,
          );
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

    if (bridge.onChatAiStreamDone) {
      bridge.onChatAiStreamDone((data) => {
        const shouldClearSending = data.conversationId === uiState.chatSendingConversationId;
        const elapsedMs =
          activeStreamStartedAt > 0 && shouldClearSending
            ? Date.now() - activeStreamStartedAt
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
            setChatSending(false);
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
            setChatSending(false);
            notifyUiStateChanged();
          }
        }

        if (elapsedMs > 0) {
          appendSystemLog(
            `AI stream completed in ${(elapsedMs / 1000).toFixed(1)}s.`,
          );
        }

        void refreshChatConversations();
      });
    }

    if (bridge.onChatAiStreamError) {
      bridge.onChatAiStreamError((data) => {
        const shouldClearSending = data.conversationId === uiState.chatSendingConversationId;
        setConversationStreamingMessage(data.conversationId, null);

        if (data.conversationId === uiState.chatActiveConversation) {
          // Ensure the waiting-for-stream flag is cleared even if the error fires
          // before chat:ai-stream-start is received (which is the only other place
          // this flag gets cleared), preventing a permanent UI spinner lock.
          uiState.chatWaitingForStream = false;
          notifyUiStateChanged();
          if (shouldClearSending) {
            setChatSending(false);
          }

          if (data.error !== 'Request aborted') {
            showChatError(data.error);
            appendSystemLog(`AI Chat error: ${data.error}`);
          }
        } else if (shouldClearSending) {
          setChatSending(false);
          notifyUiStateChanged();
        }
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

  return {
    refreshChatServiceOptions,
    refreshChatProxyStatus,
    refreshChatConversations,
    createNewConversation,
    startNewChat,
    deleteConversation,
    renameConversation,
    openConversation,
    sendMessage,
    abortChat,
    handleServiceChange,
    handleServiceFocus,
    handleServiceBlur,
    clearPinnedPeer,
  };
}
