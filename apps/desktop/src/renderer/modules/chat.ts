import type { RendererUiState } from '../core/state';
import type { BadgeTone } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge } from '../types/bridge';

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

type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
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
  deleteConversation: () => Promise<void>;
  openConversation: (convId: string) => Promise<void>;
  sendMessage: (text: string) => void;
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

  const myrmecochoryPhrases = [
    'Myrmecochory scouting for the right peer',
    'Myrmecochory optimizing route and cost',
    'Myrmecochory validating marketplace path',
    'Myrmecochory checking tool and context trail',
    'Myrmecochory preparing the next inference hop',
  ];

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
  let streamGeneration = 0;
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

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function formatChatTime(timestamp: unknown): string {
    const d = new Date(Number(timestamp));
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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

  function shortModelName(model: unknown): string {
    const raw = String(model || '').trim();
    if (!raw) return 'unknown-model';
    return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
  }

  function formatCompactNumber(value: unknown): string {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '0';
    return Math.floor(num).toLocaleString();
  }

  function formatUsd(value: unknown, maxFractionDigits = 6): string {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '0';
    return num.toLocaleString([], {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
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

  function getMyrmecochoryLabel(indexBase = 0): string {
    const index =
      Math.abs(Math.floor(Number(indexBase) || 0)) % myrmecochoryPhrases.length;
    return myrmecochoryPhrases[index];
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function normalizeAssistantMeta(msg: ChatMessage) {
    if (!msg || msg.role !== 'assistant' || !msg.meta || typeof msg.meta !== 'object') return null;
    const meta = msg.meta;
    const peerId =
      typeof meta.peerId === 'string' && (meta.peerId as string).trim().length > 0
        ? (meta.peerId as string).trim()
        : null;
    const peerAddress =
      typeof meta.peerAddress === 'string' && (meta.peerAddress as string).trim().length > 0
        ? (meta.peerAddress as string).trim()
        : null;
    const peerProviders = Array.isArray(meta.peerProviders)
      ? (meta.peerProviders as string[])
          .map((e) => String(e).trim())
          .filter((e) => e.length > 0)
      : [];
    const provider =
      typeof meta.provider === 'string' && (meta.provider as string).trim().length > 0
        ? (meta.provider as string).trim()
        : null;
    const model =
      typeof meta.model === 'string' && (meta.model as string).trim().length > 0
        ? (meta.model as string).trim()
        : null;
    const inputTokens = Math.max(0, Math.floor(Number(meta.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(meta.outputTokens) || 0));
    const explicitTotalTokens = Math.max(0, Math.floor(Number(meta.totalTokens) || 0));
    const totalTokens = explicitTotalTokens > 0 ? explicitTotalTokens : inputTokens + outputTokens;
    const tokenSourceRaw = String(meta.tokenSource || '').trim().toLowerCase();
    const tokenSource =
      tokenSourceRaw === 'estimated'
        ? 'estimated'
        : tokenSourceRaw === 'usage'
          ? 'usage'
          : 'unknown';
    const costUsd = Number.isFinite(Number(meta.estimatedCostUsd))
      ? Number(meta.estimatedCostUsd)
      : 0;
    const latencyMs = Number.isFinite(Number(meta.latencyMs)) ? Number(meta.latencyMs) : 0;
    const peerReputation = Number.isFinite(Number(meta.peerReputation))
      ? Number(meta.peerReputation)
      : null;
    const peerTrustScore = Number.isFinite(Number(meta.peerTrustScore))
      ? Number(meta.peerTrustScore)
      : null;
    const peerCurrentLoad = Number.isFinite(Number(meta.peerCurrentLoad))
      ? Number(meta.peerCurrentLoad)
      : null;
    const peerMaxConcurrency = Number.isFinite(Number(meta.peerMaxConcurrency))
      ? Number(meta.peerMaxConcurrency)
      : null;
    const routeRequestId =
      typeof meta.routeRequestId === 'string' &&
      (meta.routeRequestId as string).trim().length > 0
        ? (meta.routeRequestId as string).trim()
        : null;
    return {
      peerId,
      peerAddress,
      peerProviders,
      peerReputation,
      peerTrustScore,
      peerCurrentLoad,
      peerMaxConcurrency,
      routeRequestId,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      tokenSource,
      costUsd: costUsd > 0 ? costUsd : 0,
      latencyMs: latencyMs > 0 ? latencyMs : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers (for imperative streaming only)
  // ---------------------------------------------------------------------------

  function renderMarkdown(text: string): string {
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const langLabel = lang || 'code';
      const codeId = 'code-' + Math.random().toString(36).slice(2, 8);
      return `<div class="chat-code-container"><div class="chat-code-header"><span class="code-lang">${langLabel}</span><button class="chat-code-copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('${codeId}').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button></div><pre><code id="${codeId}">${code}</code></pre></div>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    html = html.replace(
      /^### (.+)$/gm,
      '<h3 style="font-size:14px;font-weight:600;margin:12px 0 6px;color:var(--text-primary)">$1</h3>',
    );
    html = html.replace(
      /^## (.+)$/gm,
      '<h2 style="font-size:16px;font-weight:600;margin:14px 0 8px;color:var(--text-primary)">$1</h2>',
    );
    html = html.replace(
      /^# (.+)$/gm,
      '<h1 style="font-size:18px;font-weight:700;margin:16px 0 8px;color:var(--text-primary)">$1</h1>',
    );
    html = html.replace(
      /^---$/gm,
      '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">',
    );
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" style="color:var(--accent-blue);text-decoration:underline" target="_blank" rel="noopener">$1</a>',
    );
    html = html.replace(
      /^\s*[\-*•] (.+)$/gm,
      '<li class="chat-md-li chat-md-li-ul">$1</li>',
    );
    html = html.replace(
      /^\s*\d+\. (.+)$/gm,
      '<li class="chat-md-li chat-md-li-ol">$1</li>',
    );
    html = html.replace(/<br>\s*(<li class="chat-md-li[^"]*">)/g, '$1');
    html = html.replace(/(<\/li>)\s*(?:<br>\s*)+(?=<li class="chat-md-li)/g, '$1');
    html = html.replace(
      /((?:<li class="chat-md-li[^"]*">[\s\S]*?<\/li>(?:\s*<br>\s*)*)+)/g,
      (listBlock) => {
        const ordered = listBlock.includes('chat-md-li-ol');
        const tag = ordered ? 'ol' : 'ul';
        const cleaned = listBlock
          .replace(/^\s*(?:<br>\s*)+/, '')
          .replace(/(?:<br>\s*)+\s*$/, '');
        return `<${tag} class="chat-md-list">${cleaned}</${tag}>`;
      },
    );
    html = html.replace(
      /<(ul|ol) class="chat-md-list">\s*(?:<br>\s*)+/g,
      '<$1 class="chat-md-list">',
    );
    html = html.replace(/(?:<br>\s*)+\s*<\/(ul|ol)>/g, '</$1>');
    return html;
  }

  function toToolDisplayName(name: unknown): string {
    const raw = String(name || 'tool').trim();
    if (!raw) return 'Tool';
    return raw
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function compactInlineText(value: unknown, maxLength = 72): string {
    const normalized = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 1)}...`;
  }

  function extractPrimaryToolInput(name: unknown, input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const rawName = String(name || '').trim().toLowerCase();
    const payload = input as Record<string, unknown>;
    const preferredKeys =
      rawName === 'bash'
        ? ['command', 'cmd', 'script', 'args']
        : rawName === 'read_file'
          ? ['path', 'filePath', 'file', 'target']
          : rawName === 'write_file'
            ? ['path', 'filePath', 'file', 'target']
            : rawName === 'list_directory'
              ? ['path', 'directory', 'dir']
              : rawName === 'search_files'
                ? ['query', 'pattern', 'path']
                : rawName === 'grep'
                  ? ['pattern', 'query', 'path']
                  : ['command', 'cmd', 'path', 'query', 'pattern', 'target', 'file'];

    for (const key of preferredKeys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
      if (Array.isArray(value) && value.length > 0) {
        const rendered = compactInlineText(value.map(String).join(' '));
        if (rendered.length > 0) return rendered;
      }
      if (
        (typeof value === 'number' || typeof value === 'boolean') &&
        Number.isFinite(Number(value))
      ) {
        return String(value);
      }
    }

    for (const value of Object.values(payload)) {
      if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
    }
    return '';
  }

  function formatToolExecutionLabel(name: unknown, input: unknown): string {
    const toolName = toToolDisplayName(name);
    const summary = extractPrimaryToolInput(name, input);
    return summary.length > 0 ? `${toolName} (${summary})` : toolName;
  }

  function renderToolExecutionRow({
    name,
    input = undefined,
    status = 'success',
    output = '',
    showOutput = false,
    isError = false,
    toolId = '',
  }: {
    name: unknown;
    input?: unknown;
    status?: string;
    output?: string;
    showOutput?: boolean;
    isError?: boolean;
    toolId?: string;
  }): string {
    const safeStatus =
      status === 'running' || status === 'error' ? status : 'success';
    const statusLabel =
      safeStatus === 'running' ? 'Running' : safeStatus === 'error' ? 'Error' : 'Done';
    const label = formatToolExecutionLabel(name, input);
    const outputClass = isError ? 'tool-inline-output error' : 'tool-inline-output';
    const hasOutput = showOutput && String(output).trim().length > 0;
    const outputHtml = hasOutput
      ? `<div class="${outputClass}">${escapeHtml(String(output))}</div>`
      : `<div class="${outputClass}" style="display:none"></div>`;

    return `
      <div class="tool-inline" data-tool-id="${escapeHtml(String(toolId || ''))}" data-tool-name="${escapeHtml(String(name || 'tool'))}">
        <div class="tool-inline-row">
          <span class="tool-inline-dot ${safeStatus}"></span>
          <span class="tool-inline-label">${escapeHtml(label)}</span>
          <span class="tool-inline-status ${safeStatus}">${statusLabel}</span>
        </div>
        ${outputHtml}
      </div>
    `;
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
    const elapsedText =
      activeStreamStartedAt > 0
        ? ` · ${formatElapsedMs(Date.now() - activeStreamStartedAt)}`
        : '';

    if (activeStreamTurn !== null && uiState.chatSending) {
      const label = getMyrmecochoryLabel(activeStreamTurn);
      uiState.chatStreamingIndicatorText = `Turn ${activeStreamTurn} · ${label}${elapsedText} · ${genericStatus}`;
    } else if (uiState.chatSending) {
      uiState.chatStreamingIndicatorText = `Generating response...${elapsedText} · ${genericStatus}`;
    } else {
      uiState.chatStreamingIndicatorText = genericStatus;
    }

    uiState.chatStreamingActive = uiState.chatSending;
    notifyUiStateChanged();
  }

  function updateThreadMeta(conv: ChatConversation | null): void {
    if (!conv) {
      uiState.chatThreadMeta = 'No conversation selected';
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
  // Scroll helper (imperative — used by streaming code)
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

  async function deleteConversation(): Promise<void> {
    const convId = uiState.chatActiveConversation;
    if (!convId || !bridge || !bridge.chatAiDeleteConversation) return;

    try {
      await bridge.chatAiDeleteConversation(convId);
      uiState.chatActiveConversation = null;
      uiState.chatMessages = [];
      activeConversation = null;
      uiState.chatDeleteVisible = false;
      uiState.chatInputDisabled = true;
      uiState.chatSendDisabled = true;
      uiState.chatConversationTitle = 'Conversation';

      updateThreadMeta(null);
      uiState.chatError = null;
      notifyUiStateChanged();
      await refreshChatConversations();
    } catch (err) {
      reportChatError(err, 'Failed to delete conversation');
    }
  }

  function isInProgressErrorMessage(message: unknown): boolean {
    return String(message ?? '')
      .toLowerCase()
      .includes('already in progress');
  }

  function sendMessage(text: string): void {
    const convId = uiState.chatActiveConversation;
    if (!convId || !bridge) return;

    if (uiState.chatSending) {
      showChatError('Another chat request is already in progress.');
      return;
    }

    const content = text.trim();
    if (content.length === 0) return;

    uiState.chatMessages = [...uiState.chatMessages, { role: 'user', content, createdAt: Date.now() }];
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
        await bridge.chatAiSendStream!(convId, content, selection.id || undefined);

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
            await bridge.chatAiSend!(convId, content, selection.id || undefined);

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
          const assistantMessage = {
            ...data.message,
            createdAt: data.message?.createdAt || Date.now(),
          };
          uiState.chatMessages.push(assistantMessage);
          if (activeConversation) {
            activeConversation.messages = uiState.chatMessages as ChatMessage[];
            activeConversation.updatedAt = Date.now();
            updateThreadMeta(activeConversation);
          }
          setChatSending(false);
          uiState.chatError = null;
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

    // --- Streaming callbacks (imperative DOM — escape hatch) ---

    let streamingBubble: HTMLElement | null = null;
    let streamingContentEl: HTMLElement | null = null;
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

    function renderStreamingText(): void {
      if (!streamingContentEl) return;
      streamingContentEl.innerHTML = renderMarkdown(streamingTextVisible);
      streamingContentEl.classList.add('streaming-cursor');
      scrollChatToBottom();
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
      if (!streamingContentEl) {
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
        renderStreamingText();
        streamTextLastRenderAt = timestamp;
      }

      streamTextLastFrameAt = timestamp;

      if (remaining > 0) {
        streamTextRafId = requestAnimationFrame(streamTextStep);
        return;
      }

      if (changed && !shouldRender) {
        renderStreamingText();
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
        renderStreamingText();
      }
    }

    function flushThinkingRender(): void {
      streamThinkingRafPending = false;
      streamThinkingRafId = null;

      if (streamThinkingDirtyIndex !== null && streamingBubble) {
        const thinkBody = streamingBubble.querySelector(
          `#stream-think-${streamThinkingDirtyIndex} .thinking-block-body`,
        );
        if (thinkBody) {
          thinkBody.textContent = streamingThinkingBuffer;
        }
        streamThinkingDirtyIndex = null;
      }

      scrollChatToBottom();
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

    function clearStreamContainer(): void {
      const container = document.querySelector<HTMLElement>('[data-chat-stream]');
      if (container) container.innerHTML = '';
    }

    if (bridge.onChatAiStreamStart) {
      bridge.onChatAiStreamStart((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;

        uiState.chatError = null;
        notifyUiStateChanged();

        cancelThinkingRaf();
        resetStreamingText();
        streamingThinkingBuffer = '';
        streamingContentEl = null;
        activeStreamTurn = Number(data.turn) + 1;
        activeStreamStartedAt = Date.now();
        streamGeneration++;
        updateStreamingIndicator();

        const streamContainer = document.querySelector<HTMLElement>(
          '[data-chat-stream]',
        );
        if (!streamContainer) return;

        streamContainer.innerHTML = '';
        streamingBubble = document.createElement('div');
        streamingBubble.className = 'chat-bubble other';
        const streamMeta = activeStreamTurn
          ? `turn ${activeStreamTurn} · ${getMyrmecochoryLabel(activeStreamTurn)}`
          : 'streaming';
        streamingBubble.innerHTML = `
          <div class="chat-bubble-meta">
            <span class="chat-bubble-stats">${escapeHtml(streamMeta)}</span>
          </div>
        `;
        streamContainer.appendChild(streamingBubble);
        scrollChatToBottom();
      });
    }

    if (bridge.onChatAiStreamBlockStart) {
      bridge.onChatAiStreamBlockStart((data) => {
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !streamingBubble
        )
          return;

        if (data.blockType === 'text') {
          resetStreamingText();
          streamingContentEl = document.createElement('div');
          streamingContentEl.className = 'chat-bubble-content streaming-cursor';
          streamingBubble.appendChild(streamingContentEl);
          scrollChatToBottom();
        } else if (data.blockType === 'thinking') {
          streamingThinkingBuffer = '';
          const thinkingLabel = getMyrmecochoryLabel(
            (activeStreamTurn || 0) + Number(data.index || 0),
          );
          const thinkDiv = document.createElement('div');
          thinkDiv.className = 'thinking-block streaming';
          thinkDiv.id = `stream-think-${data.index}`;
          thinkDiv.innerHTML = `<div class="thinking-block-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-block-triangle">▶</span><span>${escapeHtml(thinkingLabel)}</span><span class="thinking-dots"><span></span><span></span><span></span></span></div><div class="thinking-block-body"></div>`;
          streamingBubble.appendChild(thinkDiv);
          scrollChatToBottom();
        } else if (data.blockType === 'tool_use') {
          streamingBubble.insertAdjacentHTML(
            'beforeend',
            renderToolExecutionRow({
              name: data.toolName,
              status: 'running',
              toolId: data.toolId,
            }),
          );
          const toolDiv = streamingBubble.lastElementChild as HTMLElement | null;
          if (toolDiv) {
            toolDiv.id = `stream-tool-${data.toolId}`;
            toolDiv.dataset.toolName = String(data.toolName || 'tool');
          }
          scrollChatToBottom();
        }
      });
    }

    if (bridge.onChatAiStreamDelta) {
      bridge.onChatAiStreamDelta((data) => {
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !streamingBubble
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
          !streamingBubble
        )
          return;

        if (data.blockType === 'text') {
          flushStreamingText();
          if (streamingContentEl) {
            streamingContentEl.classList.remove('streaming-cursor');
            streamingContentEl = null;
          }
        } else if (data.blockType === 'thinking') {
          const thinkBlock = streamingBubble.querySelector(
            `#stream-think-${data.index}`,
          );
          if (thinkBlock) {
            thinkBlock.classList.remove('streaming');
            const dots = thinkBlock.querySelector('.thinking-dots');
            if (dots) dots.remove();
          }
        } else if (data.blockType === 'tool_use' && data.input) {
          const toolBlock = streamingBubble.querySelector(
            `#stream-tool-${data.toolId}`,
          );
          if (toolBlock) {
            const labelEl = toolBlock.querySelector('.tool-inline-label');
            const toolName =
              (toolBlock as HTMLElement).dataset.toolName || 'tool';
            if (labelEl)
              labelEl.textContent = formatToolExecutionLabel(
                toolName,
                data.input,
              );
          }
        }
      });
    }

    if (bridge.onChatAiToolExecuting) {
      bridge.onChatAiToolExecuting((data) => {
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !streamingBubble
        )
          return;

        const toolBlock = streamingBubble.querySelector(
          `#stream-tool-${data.toolUseId}`,
        );
        if (toolBlock) {
          (toolBlock as HTMLElement).dataset.toolName = String(
            data.name || (toolBlock as HTMLElement).dataset.toolName || 'tool',
          );
          const dotEl = toolBlock.querySelector('.tool-inline-dot');
          if (dotEl) dotEl.className = 'tool-inline-dot running';
          const statusEl = toolBlock.querySelector('.tool-inline-status');
          if (statusEl) {
            statusEl.className = 'tool-inline-status running';
            statusEl.textContent = 'Running';
          }
          const labelEl = toolBlock.querySelector('.tool-inline-label');
          if (labelEl) {
            labelEl.textContent = formatToolExecutionLabel(
              data.name ||
                (toolBlock as HTMLElement).dataset.toolName ||
                'tool',
              data.input,
            );
          }
        }
      });
    }

    if (bridge.onChatAiToolResult) {
      bridge.onChatAiToolResult((data) => {
        if (
          data.conversationId !== uiState.chatActiveConversation ||
          !streamingBubble
        )
          return;

        const toolBlock = streamingBubble.querySelector(
          `#stream-tool-${data.toolUseId}`,
        );
        if (toolBlock) {
          const dotEl = toolBlock.querySelector('.tool-inline-dot');
          if (dotEl)
            dotEl.className = `tool-inline-dot ${data.isError ? 'error' : 'success'}`;
          const statusEl = toolBlock.querySelector('.tool-inline-status');
          if (statusEl) {
            statusEl.className = `tool-inline-status ${data.isError ? 'error' : 'success'}`;
            statusEl.textContent = data.isError ? 'Error' : 'Done';
          }
          const outputEl = toolBlock.querySelector(
            '.tool-inline-output',
          ) as HTMLElement | null;
          if (outputEl && data.isError) {
            const truncated =
              data.output.length > 2000
                ? data.output.slice(0, 2000) + '\n... (truncated)'
                : data.output;
            outputEl.textContent = truncated;
            outputEl.style.display = '';
            outputEl.className = `tool-inline-output${data.isError ? ' error' : ''}`;
          }
        }
        scrollChatToBottom();
      });
    }

    if (bridge.onChatAiStreamDone) {
      bridge.onChatAiStreamDone((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;

        cancelThinkingRaf();
        flushStreamingText();
        if (streamingContentEl) {
          streamingContentEl.classList.remove('streaming-cursor');
        }

        const elapsedMs =
          activeStreamStartedAt > 0 ? Date.now() - activeStreamStartedAt : 0;

        streamingBubble = null;
        streamingContentEl = null;
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

        const gen = streamGeneration;
        void openConversation(data.conversationId).then(() => {
          if (streamGeneration === gen) {
            clearStreamContainer();
          }
          void refreshChatConversations();
        });
      });
    }

    if (bridge.onChatAiStreamError) {
      bridge.onChatAiStreamError((data) => {
        if (data.conversationId !== uiState.chatActiveConversation) return;

        cancelThinkingRaf();
        stopStreamTextAnimation();
        streamingBubble = null;
        streamingTextTarget = '';
        streamingTextVisible = '';
        streamingThinkingBuffer = '';
        streamingContentEl = null;
        setChatSending(false);

        clearStreamContainer();

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
    deleteConversation,
    openConversation,
    sendMessage,
    abortChat,
    handleModelChange,
    handleModelFocus,
    handleModelBlur,
  };
}
