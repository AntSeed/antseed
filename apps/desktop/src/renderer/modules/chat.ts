import type { RendererUiState } from '../core/state';
import type { BadgeTone } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
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
  renderMarkdownToHtml,
  shortModelName,
} from '../ui/components/chat/chat-shared';
import { applyStreamingText } from '../core/streaming-text';

type ChatConversationUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type ChatConversationSummary = {
  id: string;
  title?: string;
  model?: string;
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

type ChatModelCatalogEntry = {
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
  refreshChatProxyStatus: () => Promise<void>;
  refreshChatConversations: () => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string, imageBase64?: string, imageMimeType?: string) => void;
  abortChat: () => Promise<void>;
  handleModelChange: (value: string) => void;
  handleModelFocus: () => void;
  handleModelBlur: () => void;
};

export function initChatModule({
  bridge,
  uiState,
  appendSystemLog,
}: ChatModuleOptions): ChatModuleApi {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const fallbackChatModels: NormalizedChatModelEntry[] = [];

  const chatModelAliases: Record<string, string> = {
    'moonshotai/kimi-k2.5': 'kimi-k2.5',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
    'claude-opus-4-20250514': 'claude-opus-4-6',
    'claude-haiku-4-20250514': 'claude-haiku-4-6',
  };

  type NormalizedChatModelEntry = Required<
    Pick<ChatModelCatalogEntry, 'id' | 'label' | 'provider' | 'protocol' | 'count'>
  >;
  type ChatModelSelection = { id: string; provider: string | null };
  type ChatModelOption = ChatModelSelection & { label: string; value: string };

  const CHAT_MODEL_SELECTION_SEPARATOR = '\u0001';
  const CHAT_MODEL_REFRESH_INTERVAL_MS = 60_000;
  const CHAT_MODEL_LIST_TIMEOUT_MS = 12_000;

  // ---------------------------------------------------------------------------
  // Module-local state
  // ---------------------------------------------------------------------------

  let activeConversation: ChatConversation | null = null;
  let activeStreamTurn: number | null = null;
  let activeStreamStartedAt = 0;
  let streamingIndicatorTimer: number | null = null;
  let proxyState: 'unknown' | 'online' | 'offline' = 'unknown';
  let proxyPort = 0;
  let lastModelOptionsSignature = '';
  let pendingModelOptions: NormalizedChatModelEntry[] | null = null;
  let lastModelRefreshAt = 0;
  let modelRefreshToken = 0;
  let modelSelectFocused = false;

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  function normalizeProviderId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  function normalizeChatModelId(model: unknown): string {
    const raw = String(model ?? '').trim();
    if (!raw) return '';
    const alias = chatModelAliases[raw.toLowerCase()];
    return alias ?? raw;
  }

  function normalizeChatModelEntry(raw: unknown): NormalizedChatModelEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as ChatModelCatalogEntry;
    const id = normalizeChatModelId(entry.id);
    if (!id) return null;
    const provider = String(entry.provider ?? '').trim().toLowerCase() || 'unknown';
    const protocol = String(entry.protocol ?? '').trim().toLowerCase() || 'unknown';
    const count = Math.max(0, Math.floor(Number(entry.count) || 0));
    const label = String(entry.label ?? '').trim() || `${id} · ${provider}`;
    return { id, label, provider, protocol, count };
  }

  function encodeChatModelSelection(modelId: string, provider: string | null): string {
    const normalizedModelId = normalizeChatModelId(modelId);
    if (!normalizedModelId) return '';
    const normalizedProvider = normalizeProviderId(provider);
    return normalizedProvider
      ? `${normalizedProvider}${CHAT_MODEL_SELECTION_SEPARATOR}${normalizedModelId}`
      : normalizedModelId;
  }

  function decodeChatModelSelection(value: unknown): ChatModelSelection {
    const raw = String(value ?? '');
    if (!raw) return { id: '', provider: null };
    const separatorIndex = raw.indexOf(CHAT_MODEL_SELECTION_SEPARATOR);
    if (separatorIndex === -1) return { id: normalizeChatModelId(raw), provider: null };
    const provider = normalizeProviderId(raw.slice(0, separatorIndex));
    const id = normalizeChatModelId(
      raw.slice(separatorIndex + CHAT_MODEL_SELECTION_SEPARATOR.length),
    );
    return { id, provider };
  }

  function findMatchingChatModelOptionValue(
    options: ChatModelOption[],
    targetModelId: unknown,
    targetProvider?: unknown,
  ): string | null {
    const modelId = normalizeChatModelId(targetModelId);
    if (!modelId) return null;
    const provider = normalizeProviderId(targetProvider);
    if (provider) {
      const exact = options.find((o) => o.id === modelId && o.provider === provider);
      if (exact) return exact.value;
    }
    const fallback = options.find((o) => o.id === modelId);
    return fallback?.value ?? null;
  }

  function computeModelOptionsSignature(options: NormalizedChatModelEntry[]): string {
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

  function countBlocks(blocks: unknown[]) {
    const summary = { text: 0, toolUse: 0, toolResult: 0, thinking: 0 };
    if (!Array.isArray(blocks)) return summary;
    for (const block of blocks as Array<{ type: string }>) {
      if (block.type === 'text') summary.text += 1;
      if (block.type === 'tool_use') summary.toolUse += 1;
      if (block.type === 'tool_result') summary.toolResult += 1;
      if (block.type === 'thinking') summary.thinking += 1;
    }
    return summary;
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

  function setModelCatalogStatus(tone: BadgeTone, label: string): void {
    uiState.chatModelStatus = { tone, label };
    notifyUiStateChanged();
  }

  function setModelSelectLoading(loading: boolean): void {
    uiState.chatModelSelectDisabled = loading;
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

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const counts = countBlocks(msg.content);
        toolCalls += counts.toolUse;
        reasoningBlocks += counts.thinking;
      }
      const meta = normalizeAssistantMeta(msg);
      if (meta) {
        if (meta.peerId) servingPeers.add(meta.peerId);
        if (meta.costUsd > 0) totalEstimatedCostUsd += meta.costUsd;
      }
    }

    const parts = [
      `session ${String(conv.id || '').slice(0, 8) || 'n/a'}`,
      shortModelName(conv.model),
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
    const peerArr = [...servingPeers];
    uiState.chatRoutedPeer = peerArr.length > 0 ? peerArr[peerArr.length - 1].slice(0, 8) : '';
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
    uiState.chatInputDisabled = sending || !uiState.chatActiveConversation;
    uiState.chatSendDisabled = sending || !uiState.chatActiveConversation;
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

  function setStreamingMessage(message: ChatMessage | null): void {
    uiState.chatStreamingMessage = message ? cloneStreamingMessage(message) : null;
    notifyUiStateChanged();
    if (message) queueScrollChatToBottom();
  }

  function updateStreamingMessage(mutator: (message: ChatMessage) => void): void {
    const current = uiState.chatStreamingMessage;
    if (!current) return;
    const next = cloneStreamingMessage(current);
    mutator(next);
    uiState.chatStreamingMessage = next;
    notifyUiStateChanged();
    queueScrollChatToBottom();
  }

  // ---------------------------------------------------------------------------
  // Model management
  // ---------------------------------------------------------------------------

  function getAvailableChatModelOptions(): ChatModelOption[] {
    if (uiState.chatModelOptions.length > 0) {
      return uiState.chatModelOptions
        .map((entry) => {
          const selection = decodeChatModelSelection(entry.value);
          if (!selection.id) return null;
          return {
            id: selection.id,
            label: entry.label,
            provider: selection.provider,
            value: entry.value,
          };
        })
        .filter((opt): opt is ChatModelOption => opt !== null);
    }

    return fallbackChatModels.map((entry) => ({
      id: normalizeChatModelId(entry.id),
      label: String(entry.label ?? entry.id),
      provider: normalizeProviderId(entry.provider),
      value: encodeChatModelSelection(entry.id, entry.provider),
    }));
  }

  function getSelectedChatModelSelection(): ChatModelSelection {
    const selectedValue = decodeChatModelSelection(uiState.chatSelectedModelValue);
    if (selectedValue.id.length > 0) return selectedValue;

    const conversationModel = normalizeChatModelId(activeConversation?.model);
    if (conversationModel.length > 0) {
      return {
        id: conversationModel,
        provider: normalizeProviderId(activeConversation?.provider),
      };
    }

    if (uiState.chatModelOptions.length > 0) {
      const firstOption = decodeChatModelSelection(uiState.chatModelOptions[0].value);
      if (firstOption.id.length > 0) return firstOption;
    }

    return { id: '', provider: null };
  }

  function applyChatModelOptions(entries: NormalizedChatModelEntry[]): void {
    const currentSelection = decodeChatModelSelection(uiState.chatSelectedModelValue);
    const activeConversationModel = normalizeChatModelId(activeConversation?.model);
    const activeConversationProvider = normalizeProviderId(activeConversation?.provider);

    const unique = new Map<string, NormalizedChatModelEntry>();
    for (const entry of entries) {
      const key = `${entry.provider}${CHAT_MODEL_SELECTION_SEPARATOR}${entry.id}`;
      if (!entry.id || unique.has(key)) continue;
      unique.set(key, entry);
    }

    const options = Array.from(unique.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.id.localeCompare(b.id);
    });

    const optionCandidates: ChatModelOption[] = options.map((entry) => ({
      id: entry.id,
      provider: normalizeProviderId(entry.provider),
      label: entry.label,
      value: encodeChatModelSelection(entry.id, entry.provider),
    }));

    const preferred =
      findMatchingChatModelOptionValue(
        optionCandidates,
        currentSelection.id,
        currentSelection.provider,
      ) ??
      findMatchingChatModelOptionValue(
        optionCandidates,
        activeConversationModel,
        activeConversationProvider,
      ) ??
      optionCandidates[0]?.value ??
      '';

    const nextSignature = computeModelOptionsSignature(options);
    if (
      nextSignature === lastModelOptionsSignature &&
      uiState.chatSelectedModelValue === preferred
    ) {
      return;
    }

    if (options.length === 0) {
      uiState.chatModelOptions = [];
      uiState.chatSelectedModelValue = '';
      lastModelOptionsSignature = '';
      notifyUiStateChanged();
      return;
    }

    uiState.chatModelOptions = options.map((entry) => ({
      id: entry.id,
      label: entry.label,
      provider: entry.provider,
      protocol: entry.protocol,
      count: entry.count,
      value: encodeChatModelSelection(entry.id, entry.provider),
    }));

    uiState.chatSelectedModelValue = preferred;
    lastModelOptionsSignature = nextSignature;
    notifyUiStateChanged();
  }

  function updateChatModelOptions(entries: NormalizedChatModelEntry[]): void {
    if (modelSelectFocused) {
      pendingModelOptions = entries;
      return;
    }
    applyChatModelOptions(entries);
  }

  async function listChatModelsWithTimeout(
    refreshToken: number,
  ): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    if (!bridge?.chatAiListModels) {
      return { ok: false, data: [], error: 'Model catalog bridge unavailable' };
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
            error: `Model discovery timed out after ${String(CHAT_MODEL_LIST_TIMEOUT_MS)}ms`,
          });
        }, CHAT_MODEL_LIST_TIMEOUT_MS);
      });

      const result = await Promise.race([bridge.chatAiListModels(), timeoutPromise]);

      if (refreshToken !== modelRefreshToken) {
        return { ok: false, data: [], error: 'stale model refresh' };
      }
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async function refreshChatModelOptions(): Promise<void> {
    const refreshToken = ++modelRefreshToken;
    const fallback = fallbackChatModels.map((entry) => ({ ...entry }));

    if (!bridge?.chatAiListModels) {
      updateChatModelOptions(fallback);
      setModelCatalogStatus('warn', 'Models unavailable');
      setRuntimeActivity('warn', 'Model catalog unavailable (bridge missing).');
      return;
    }

    setModelCatalogStatus('warn', 'Loading models...');
    setRuntimeActivity('warn', 'Loading model catalog from peers...');
    setModelSelectLoading(true);

    try {
      const result = await listChatModelsWithTimeout(refreshToken);
      if (refreshToken !== modelRefreshToken) return;

      if (!result.ok || !Array.isArray(result.data)) {
        updateChatModelOptions(fallback);
        setModelCatalogStatus('warn', result.error || 'Models unavailable');
        setRuntimeActivity('warn', result.error || 'Model catalog unavailable.');
        return;
      }

      const parsed = result.data
        .map((entry) => normalizeChatModelEntry(entry))
        .filter((entry): entry is NormalizedChatModelEntry => entry !== null);
      const optionsToRender = parsed.length > 0 ? parsed : fallback;
      updateChatModelOptions(optionsToRender);
      setModelCatalogStatus(
        optionsToRender.length > 0 ? 'active' : 'warn',
        optionsToRender.length > 0
          ? `Models ready (${String(optionsToRender.length)})`
          : 'No models available',
      );
      setRuntimeActivity(
        optionsToRender.length > 0 ? 'active' : 'warn',
        optionsToRender.length > 0
          ? `Model catalog ready (${String(optionsToRender.length)} models).`
          : 'No models discovered from current peers.',
      );
    } catch (error) {
      if (refreshToken !== modelRefreshToken) return;
      updateChatModelOptions(fallback);
      const message = toErrorMessage(error, 'Failed to load models');
      setModelCatalogStatus('warn', message);
      setRuntimeActivity('bad', message);
    } finally {
      if (refreshToken === modelRefreshToken) {
        setModelSelectLoading(false);
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
      setModelCatalogStatus('idle', 'Models idle');
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
          uiState.chatProxyStatus = { tone: 'idle', label: 'Proxy offline' };
          notifyUiStateChanged();
          setModelCatalogStatus('idle', 'Models unavailable (proxy offline)');
          if (previousProxyState !== 'offline') {
            setRuntimeActivity('warn', 'Buyer proxy offline; waiting for runtime.');
          }
        }
      }
    } catch {
      proxyState = 'offline';
      proxyPort = 0;
      uiState.chatProxyStatus = { tone: 'idle', label: 'Proxy offline' };
      notifyUiStateChanged();
      setModelCatalogStatus('idle', 'Models unavailable (proxy offline)');
      if (previousProxyState !== 'offline') {
        setRuntimeActivity('warn', 'Buyer proxy unreachable; retrying.');
      }
    } finally {
      const now = Date.now();
      const shouldRefreshModels =
        proxyState === 'online' &&
        (previousProxyState !== 'online' ||
          now - lastModelRefreshAt >= CHAT_MODEL_REFRESH_INTERVAL_MS);
      if (shouldRefreshModels) {
        lastModelRefreshAt = now;
        void refreshChatModelOptions();
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
      updateStreamingIndicator();
    }
  }

  async function openConversation(convId: string): Promise<void> {
    if (!bridge || !bridge.chatAiGetConversation) return;

    uiState.chatActiveConversation = convId;
    setStreamingMessage(null);

    try {
      const result = await bridge.chatAiGetConversation(convId);
      if (result.ok && result.data) {
        const conv = result.data as ChatConversation;
        activeConversation = conv;
        uiState.chatMessages = Array.isArray(conv.messages) ? conv.messages : [];
        uiState.chatConversationTitle = String(conv.title || 'Conversation');
        uiState.chatDeleteVisible = true;
        uiState.chatInputDisabled = false;
        uiState.chatSendDisabled = false;

        const optionCandidates = getAvailableChatModelOptions();
        const preferredValue = findMatchingChatModelOptionValue(
          optionCandidates,
          conv.model,
          conv.provider,
        );
        if (preferredValue) {
          uiState.chatSelectedModelValue = preferredValue;
        }

        updateThreadMeta(conv);
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

  function materializeStreamingMessage(): ChatMessage | null {
    const current = uiState.chatStreamingMessage;
    return current ? cloneStreamingMessage(current) : null;
  }

  function commitAssistantMessage(message: ChatMessage): void {
    const assistantMessage = {
      ...message,
      createdAt: message?.createdAt || Date.now(),
    };
    uiState.chatMessages = [...uiState.chatMessages, assistantMessage];
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Number(assistantMessage.createdAt) || Date.now();
      updateThreadMeta(activeConversation);
    }
  }

  async function createNewConversation(): Promise<void> {
    if (!bridge || !bridge.chatAiCreateConversation) return;

    const selection = getSelectedChatModelSelection();
    if (selection.id.length === 0) {
      showChatError(
        'No model is currently available. Start Buyer runtime and refresh models.',
      );
      return;
    }

    try {
      const result = await bridge.chatAiCreateConversation(selection.id);
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
  }

  function isInProgressErrorMessage(message: unknown): boolean {
    return String(message ?? '')
      .toLowerCase()
      .includes('already in progress');
  }

  function sendMessage(text: string, imageBase64?: string, imageMimeType?: string): void {
    if (!bridge) return;

    if (uiState.chatSending) {
      showChatError('Another chat request is already in progress.');
      return;
    }

    const content = text.trim();
    if (content.length === 0 && !imageBase64) return;

    // If no active conversation, create one first then send
    if (!uiState.chatActiveConversation) {
      void (async () => {
        await createNewConversation();
        if (uiState.chatActiveConversation) {
          sendMessage(text, imageBase64, imageMimeType);
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
    if (activeConversation) {
      activeConversation.messages = uiState.chatMessages as ChatMessage[];
      activeConversation.updatedAt = Date.now();
      updateThreadMeta(activeConversation);
    }
    notifyUiStateChanged();

    uiState.chatError = null;
    setChatSending(true);

    const selection = getSelectedChatModelSelection();

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
  // Model select handlers (called by ChatView)
  // ---------------------------------------------------------------------------

  function handleModelChange(value: string): void {
    uiState.chatSelectedModelValue = value;
    pendingModelOptions = null;
    notifyUiStateChanged();
  }

  function handleModelFocus(): void {
    modelSelectFocused = true;
  }

  function handleModelBlur(): void {
    modelSelectFocused = false;
    if (pendingModelOptions) {
      const pending = pendingModelOptions;
      pendingModelOptions = null;
      applyChatModelOptions(pending);
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge callbacks
  // ---------------------------------------------------------------------------

  if (bridge) {
    // --- Non-streaming callbacks ---

    if (bridge.onChatAiDone) {
      bridge.onChatAiDone((data) => {
        if (data.conversationId === uiState.chatActiveConversation) {
          const isStreamingCommit = Boolean(uiState.chatStreamingMessage);
          if (isStreamingCommit) {
            cancelThinkingRaf();
            flushStreamingText();
            setStreamingMessage(null);
            streamingTextTarget = '';
            streamingTextVisible = '';
            streamingThinkingBuffer = '';
          }
          commitAssistantMessage(data.message as ChatMessage);
          uiState.chatError = null;
          if (!isStreamingCommit) {
            setChatSending(false);
          }
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
          notifyUiStateChanged();
        }
      });
    }

    // --- Streaming callbacks ---

    let streamingTextTarget = '';
    let streamingTextVisible = '';
    let streamingThinkingBuffer = '';
    let streamThinkingRafPending = false;
    let streamThinkingRafId: number | null = null;
    let streamThinkingDirtyIndex: number | null = null;
    let streamTextRafId: number | null = null;
    let streamTextLastFrameAt = 0;
    let streamTextLastRenderAt = 0;

    const STREAM_TEXT_BASE_CHARS_PER_SECOND = 140;
    const STREAM_TEXT_MAX_CHARS_PER_SECOND = 2600;
    const STREAM_TEXT_TARGET_LAG_MS = 180;
    const STREAM_TEXT_RENDER_INTERVAL_MS = 24;

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

    function findLastStreamingBlockByType(blocks: ContentBlock[], type: string): ContentBlock | undefined {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.type === type) return block;
      }
      return undefined;
    }

    function stopStreamTextAnimation(): void {
      if (streamTextRafId !== null) {
        cancelAnimationFrame(streamTextRafId);
        streamTextRafId = null;
      }
      streamTextLastFrameAt = 0;
      streamTextLastRenderAt = 0;
    }

    function resolveStreamTextRate(backlogChars: number): number {
      if (backlogChars <= 0) return STREAM_TEXT_BASE_CHARS_PER_SECOND;
      const catchUpRate = Math.ceil(
        (backlogChars * 1000) / STREAM_TEXT_TARGET_LAG_MS,
      );
      return Math.min(
        STREAM_TEXT_MAX_CHARS_PER_SECOND,
        Math.max(STREAM_TEXT_BASE_CHARS_PER_SECOND, catchUpRate),
      );
    }

    function streamTextStep(timestamp: number): void {
      if (!uiState.chatStreamingMessage) {
        stopStreamTextAnimation();
        return;
      }

      if (streamTextLastFrameAt <= 0) streamTextLastFrameAt = timestamp;

      const elapsedMs = Math.max(1, timestamp - streamTextLastFrameAt);
      const backlogChars = Math.max(
        0,
        streamingTextTarget.length - streamingTextVisible.length,
      );
      if (backlogChars <= 0) {
        stopStreamTextAnimation();
        return;
      }

      const adaptiveRate = resolveStreamTextRate(backlogChars);
      const charBudget = Math.max(
        1,
        Math.floor((elapsedMs * adaptiveRate) / 1000),
      );
      const nextLength = Math.min(
        streamingTextTarget.length,
        streamingTextVisible.length + charBudget,
      );
      const changed = nextLength !== streamingTextVisible.length;
      if (changed) {
        streamingTextVisible = streamingTextTarget.slice(0, nextLength);
      }

      const remaining = Math.max(
        0,
        streamingTextTarget.length - streamingTextVisible.length,
      );
      const elapsedSinceRender =
        streamTextLastRenderAt <= 0
          ? Number.POSITIVE_INFINITY
          : timestamp - streamTextLastRenderAt;
      const shouldRender =
        changed &&
        (remaining === 0 || elapsedSinceRender >= STREAM_TEXT_RENDER_INTERVAL_MS);
      if (shouldRender) {
        applyStreamingText(renderMarkdownToHtml(streamingTextVisible));
        streamTextLastRenderAt = timestamp;
      }

      streamTextLastFrameAt = timestamp;

      if (remaining > 0) {
        streamTextRafId = requestAnimationFrame(streamTextStep);
        return;
      }

      if (changed && !shouldRender) {
        applyStreamingText(renderMarkdownToHtml(streamingTextVisible));
      }
      stopStreamTextAnimation();
    }

    function scheduleStreamTextAnimation(): void {
      if (streamTextRafId !== null) return;
      streamTextRafId = requestAnimationFrame(streamTextStep);
    }

    function resetStreamingText(): void {
      stopStreamTextAnimation();
      streamingTextTarget = '';
      streamingTextVisible = '';
    }

    function flushStreamingText(): void {
      stopStreamTextAnimation();
      if (streamingTextVisible !== streamingTextTarget) {
        streamingTextVisible = streamingTextTarget;
        updateStreamingMessage((message) => {
          const blocks = message.content as ContentBlock[];
          const textBlock = findLastStreamingBlockByType(blocks, 'text');
          if (textBlock) {
            textBlock.text = streamingTextVisible;
            textBlock.streaming = true;
          }
        });
      }
    }

    function flushThinkingRender(): void {
      streamThinkingRafPending = false;
      streamThinkingRafId = null;

      if (streamThinkingDirtyIndex !== null) {
        updateStreamingMessage((message) => {
          const blocks = message.content as ContentBlock[];
          const thinkingBlock = blocks.find(
            (block) =>
              block?.type === 'thinking' &&
              block.id === getStreamingBlockId('thinking', streamThinkingDirtyIndex as number),
          );
          if (thinkingBlock && thinkingBlock.type === 'thinking') {
            thinkingBlock.thinking = streamingThinkingBuffer;
            thinkingBlock.streaming = true;
          }
        });
        streamThinkingDirtyIndex = null;
      }
    }

    function scheduleThinkingRender(): void {
      if (streamThinkingRafPending) return;
      streamThinkingRafPending = true;
      streamThinkingRafId = requestAnimationFrame(flushThinkingRender);
    }

    function cancelThinkingRaf(): void {
      if (streamThinkingRafId !== null) {
        cancelAnimationFrame(streamThinkingRafId);
        streamThinkingRafId = null;
      }
      streamThinkingRafPending = false;
      streamThinkingDirtyIndex = null;
    }

    if (bridge.onChatAiStreamStart) {
      bridge.onChatAiStreamStart((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;

        uiState.chatError = null;
        notifyUiStateChanged();

        cancelThinkingRaf();
        resetStreamingText();
        streamingThinkingBuffer = '';
        activeStreamTurn = Number(data.turn) + 1;
        activeStreamStartedAt = Date.now();
        updateStreamingIndicator();
        if (!uiState.chatStreamingMessage) {
          setStreamingMessage({
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
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;

        if (uiState.chatWaitingForStream) {
          uiState.chatWaitingForStream = false;
          notifyUiStateChanged();
        }

        if (data.blockType === 'text') {
          resetStreamingText();
          updateStreamingMessage((message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'text',
              renderKey: createStreamingRenderKey('text', data.index),
              text: '',
              streaming: true,
            });
            message.content = blocks;
          });
        } else if (data.blockType === 'thinking') {
          streamingThinkingBuffer = '';
          const thinkingLabel = getMyrmecochoryLabel(
            (activeStreamTurn || 0) + Number(data.index || 0),
          );
          updateStreamingMessage((message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'thinking',
              renderKey: createStreamingRenderKey('thinking', data.index),
              id: getStreamingBlockId('thinking', data.index),
              name: thinkingLabel,
              thinking: '',
              streaming: true,
            });
            message.content = blocks;
          });
        } else if (data.blockType === 'tool_use') {
          updateStreamingMessage((message) => {
            const blocks = getStreamingBlocks(message);
            blocks.push({
              type: 'tool_use',
              renderKey: createStreamingRenderKey('tool', data.toolId || data.index),
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
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;

        if (data.blockType === 'text') {
          streamingTextTarget += data.text;
          scheduleStreamTextAnimation();
        } else if (data.blockType === 'thinking') {
          streamingThinkingBuffer += data.text;
          streamThinkingDirtyIndex = data.index;
          scheduleThinkingRender();
        }
      });
    }

    if (bridge.onChatAiStreamBlockStop) {
      bridge.onChatAiStreamBlockStop((data) => {
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;

        if (data.blockType === 'text') {
          flushStreamingText();
          updateStreamingMessage((message) => {
            const blocks = message.content as ContentBlock[];
            const textBlock = findLastStreamingBlockByType(blocks, 'text');
            if (textBlock) textBlock.streaming = false;
          });
        } else if (data.blockType === 'thinking') {
          updateStreamingMessage((message) => {
            const blocks = message.content as ContentBlock[];
            const thinkingBlock = blocks.find(
              (block) => block.type === 'thinking' && block.id === getStreamingBlockId('thinking', data.index),
            );
            if (thinkingBlock && thinkingBlock.type === 'thinking') {
              thinkingBlock.streaming = false;
            }
          });
        } else if (data.blockType === 'tool_use' && data.input) {
          updateStreamingMessage((message) => {
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
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;
        updateStreamingMessage((message) => {
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
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;
        updateStreamingMessage((message) => {
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
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !uiState.chatStreamingMessage
        )
          return;
        updateStreamingMessage((message) => {
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
        if (data.conversationId !== uiState.chatActiveConversation) return;

        cancelThinkingRaf();
        flushStreamingText();

        const elapsedMs =
          activeStreamStartedAt > 0 ? Date.now() - activeStreamStartedAt : 0;

        const finalizedStreamingMessage = materializeStreamingMessage();
        if (finalizedStreamingMessage) {
          commitAssistantMessage(finalizedStreamingMessage);
        }

        setStreamingMessage(null);
        streamingTextTarget = '';
        streamingTextVisible = '';
        streamingThinkingBuffer = '';
        setChatSending(false);
        uiState.chatError = null;
        notifyUiStateChanged();

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
        if (data.conversationId !== uiState.chatActiveConversation) return;

        cancelThinkingRaf();
        stopStreamTextAnimation();
        uiState.chatStreamingMessage = null;
        notifyUiStateChanged();
        streamingTextTarget = '';
        streamingTextVisible = '';
        streamingThinkingBuffer = '';
        setChatSending(false);

        if (data.error !== 'Request aborted') {
          showChatError(data.error);
          appendSystemLog(`AI Chat error: ${data.error}`);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  updateThreadMeta(null);
  updateStreamingIndicator();
  void refreshChatModelOptions();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    refreshChatProxyStatus,
    refreshChatConversations,
    createNewConversation,
    startNewChat,
    deleteConversation,
    renameConversation,
    openConversation,
    sendMessage,
    abortChat,
    handleModelChange,
    handleModelFocus,
    handleModelBlur,
  };
}
