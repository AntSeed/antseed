import { marked } from 'marked';

export function renderMarkdownToHtml(text: string): string {
  return String(marked.parse(text, { gfm: true, breaks: true }));
}

export type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ContentBlock = {
  type: string;
  renderKey?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string };
  details?: Record<string, unknown>;
  status?: 'running' | 'success' | 'error';
  streaming?: boolean;
};

export type AssistantMeta = {
  peerId: string | null;
  peerAddress: string | null;
  peerProviders: string[];
  peerReputation: number | null;
  peerTrustScore: number | null;
  peerCurrentLoad: number | null;
  peerMaxConcurrency: number | null;
  routeRequestId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: 'estimated' | 'usage' | 'unknown';
  costUsd: number;
  latencyMs: number;
};

const myrmecochoryPhrases = [
  'Myrmecochory scouting for the right peer',
  'Myrmecochory optimizing route and cost',
  'Myrmecochory validating marketplace path',
  'Myrmecochory checking tool and context trail',
  'Myrmecochory preparing the next inference hop',
];

export function formatChatTime(timestamp: unknown): string {
  const ts = Number(timestamp);
  if (!ts || ts <= 0) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function shortModelName(model: unknown): string {
  const raw = String(model || '').trim();
  if (!raw) return 'unknown-model';
  return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
}

export function formatCompactNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  return Math.floor(num).toLocaleString();
}

export function formatUsd(value: unknown, maxFractionDigits = 6): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  return num.toLocaleString([], { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits });
}

export function getMyrmecochoryLabel(indexBase = 0): string {
  const index = Math.abs(Math.floor(Number(indexBase) || 0)) % myrmecochoryPhrases.length;
  return myrmecochoryPhrases[index];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeAssistantMeta(msg: ChatMessage): AssistantMeta | null {
  if (!msg || msg.role !== 'assistant' || !msg.meta || typeof msg.meta !== 'object') return null;
  const meta = msg.meta;
  const peerId = typeof meta.peerId === 'string' && (meta.peerId as string).trim().length > 0 ? (meta.peerId as string).trim() : null;
  const peerAddress = typeof meta.peerAddress === 'string' && (meta.peerAddress as string).trim().length > 0 ? (meta.peerAddress as string).trim() : null;
  const peerProviders = Array.isArray(meta.peerProviders) ? (meta.peerProviders as string[]).map(String).filter(Boolean) : [];
  const provider = typeof meta.provider === 'string' && (meta.provider as string).trim().length > 0 ? (meta.provider as string).trim() : null;
  const model = typeof meta.model === 'string' && (meta.model as string).trim().length > 0 ? (meta.model as string).trim() : null;
  const inputTokens = Math.max(0, Math.floor(Number(meta.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(meta.outputTokens) || 0));
  const explicitTotalTokens = Math.max(0, Math.floor(Number(meta.totalTokens) || 0));
  const totalTokens = explicitTotalTokens > 0 ? explicitTotalTokens : inputTokens + outputTokens;
  const tokenSourceRaw = String(meta.tokenSource || '').trim().toLowerCase();
  const tokenSource = tokenSourceRaw === 'estimated' ? 'estimated' : tokenSourceRaw === 'usage' ? 'usage' : 'unknown';
  const costUsd = Number.isFinite(Number(meta.estimatedCostUsd)) ? Number(meta.estimatedCostUsd) : 0;
  const latencyMs = Number.isFinite(Number(meta.latencyMs)) ? Number(meta.latencyMs) : 0;
  const peerReputation = Number.isFinite(Number(meta.peerReputation)) ? Number(meta.peerReputation) : null;
  const peerTrustScore = Number.isFinite(Number(meta.peerTrustScore)) ? Number(meta.peerTrustScore) : null;
  const peerCurrentLoad = Number.isFinite(Number(meta.peerCurrentLoad)) ? Number(meta.peerCurrentLoad) : null;
  const peerMaxConcurrency = Number.isFinite(Number(meta.peerMaxConcurrency)) ? Number(meta.peerMaxConcurrency) : null;
  const routeRequestId = typeof meta.routeRequestId === 'string' && (meta.routeRequestId as string).trim().length > 0 ? (meta.routeRequestId as string).trim() : null;
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

export function countBlocks(blocks: ContentBlock[]) {
  const summary = { text: 0, toolUse: 0, toolResult: 0, thinking: 0 };
  for (const block of blocks) {
    if (block.type === 'text') summary.text += 1;
    if (block.type === 'tool_use') summary.toolUse += 1;
    if (block.type === 'tool_result') summary.toolResult += 1;
    if (block.type === 'thinking') summary.thinking += 1;
  }
  return summary;
}

export function toToolDisplayName(name: unknown): string {
  const raw = String(name || 'tool').trim();
  if (!raw) return 'Tool';
  return raw.split(/[_\-\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function compactInlineText(value: unknown, maxLength = 72): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function extractPrimaryToolInput(name: unknown, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rawName = String(name || '').trim().toLowerCase();
  const payload = input as Record<string, unknown>;
  const preferredKeys = rawName === 'bash' ? ['command', 'cmd', 'script', 'args']
    : rawName === 'read_file' ? ['path', 'filePath', 'file', 'target']
    : rawName === 'write_file' ? ['path', 'filePath', 'file', 'target']
    : rawName === 'list_directory' ? ['path', 'directory', 'dir']
    : rawName === 'search_files' ? ['query', 'pattern', 'path']
    : rawName === 'grep' ? ['pattern', 'query', 'path']
    : ['command', 'cmd', 'path', 'query', 'pattern', 'target', 'file'];

  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
    if (Array.isArray(value) && value.length > 0) {
      const rendered = compactInlineText(value.map(String).join(' '));
      if (rendered.length > 0) return rendered;
    }
    if ((typeof value === 'number' || typeof value === 'boolean') && Number.isFinite(Number(value))) {
      return String(value);
    }
  }

  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
  }
  return '';
}

export function formatToolExecutionLabel(name: unknown, input: unknown): string {
  const toolName = toToolDisplayName(name);
  const summary = extractPrimaryToolInput(name, input);
  return summary.length > 0 ? `${toolName} (${summary})` : toolName;
}

export function buildChatMetaParts(msg: ChatMessage): string[] {
  const parts: string[] = [];
  if (msg.createdAt && Number(msg.createdAt) > 0) parts.push(formatChatTime(msg.createdAt));

  const blocks = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : null;
  const stats = blocks ? countBlocks(blocks) : null;
  const assistantMeta = normalizeAssistantMeta(msg);

  if (stats && msg.role === 'assistant') {
    if (stats.toolUse > 0) parts.push(`${stats.toolUse} tool${stats.toolUse === 1 ? '' : 's'}`);
    if (stats.thinking > 0) parts.push(`${stats.thinking} reasoning`);
    if (stats.text > 0) parts.push(`${stats.text} text block${stats.text === 1 ? '' : 's'}`);
  }

  if (assistantMeta) {
    parts.push(assistantMeta.peerId ? `peer ${assistantMeta.peerId.slice(0, 8)}` : 'peer n/a');
    if (assistantMeta.peerAddress) parts.push(assistantMeta.peerAddress);
    if (assistantMeta.provider) parts.push(assistantMeta.provider);
    if (assistantMeta.model) parts.push(shortModelName(assistantMeta.model));
    if (assistantMeta.peerProviders.length > 0 && !assistantMeta.provider) {
      parts.push(assistantMeta.peerProviders.join(','));
    }
    if (assistantMeta.totalTokens > 0) {
      const tokenParts = [`${formatCompactNumber(assistantMeta.totalTokens)} tok`];
      if (assistantMeta.inputTokens > 0 || assistantMeta.outputTokens > 0) {
        tokenParts.push(
          `(${formatCompactNumber(assistantMeta.inputTokens)} in / ${formatCompactNumber(assistantMeta.outputTokens)} out)`,
        );
      }
      parts.push(tokenParts.join(' '));
    } else {
      parts.push('tok n/a');
    }
    if (assistantMeta.tokenSource === 'estimated') parts.push('est.');
    if (assistantMeta.costUsd > 0) parts.push(`$${formatUsd(assistantMeta.costUsd)}`);
    else if (assistantMeta.totalTokens > 0) parts.push('$n/a');
    if (assistantMeta.latencyMs > 0) parts.push(`${Math.round(assistantMeta.latencyMs)}ms`);
    if (assistantMeta.peerReputation !== null) parts.push(`rep ${Math.round(assistantMeta.peerReputation)}`);
    if (assistantMeta.peerTrustScore !== null) parts.push(`trust ${Math.round(assistantMeta.peerTrustScore)}`);
    if (
      assistantMeta.peerCurrentLoad !== null &&
      assistantMeta.peerMaxConcurrency !== null &&
      assistantMeta.peerMaxConcurrency > 0
    ) {
      parts.push(`load ${Math.round(assistantMeta.peerCurrentLoad)}/${Math.round(assistantMeta.peerMaxConcurrency)}`);
    }
    if (assistantMeta.routeRequestId) parts.push(`route ${assistantMeta.routeRequestId.slice(0, 8)}`);
  }

  return parts;
}

export function isToolResultOnlyMessage(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    (msg.content as ContentBlock[]).every((block) => block.type === 'tool_result')
  );
}

export function cloneContentBlock(block: ContentBlock): ContentBlock {
  return {
    ...block,
    input: block.input ? { ...block.input } : undefined,
    source: block.source ? { ...block.source } : undefined,
    details: block.details ? { ...block.details } : undefined,
  };
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    meta: message.meta ? { ...message.meta } : undefined,
    content: Array.isArray(message.content)
      ? (message.content as ContentBlock[]).map(cloneContentBlock)
      : message.content,
  };
}

function asContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    return (content as ContentBlock[]).map(cloneContentBlock);
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function mergeAssistantMessages(base: ChatMessage, next: ChatMessage): ChatMessage {
  const mergedBase = cloneChatMessage(base);
  const mergedNext = cloneChatMessage(next);
  return {
    ...mergedBase,
    ...mergedNext,
    createdAt: mergedBase.createdAt || mergedNext.createdAt,
    meta: {
      ...(mergedBase.meta ?? {}),
      ...(mergedNext.meta ?? {}),
    },
    content: [...asContentBlocks(mergedBase.content), ...asContentBlocks(mergedNext.content)],
  };
}

function applyToolResultBlock(target: ChatMessage, resultBlock: ContentBlock): void {
  if (!Array.isArray(target.content)) return;
  const blocks = target.content as ContentBlock[];
  const toolUseId = String(resultBlock.tool_use_id || '').trim();
  const toolBlock = [...blocks]
    .reverse()
    .find((block) => block.type === 'tool_use' && String(block.id || '').trim() === toolUseId);
  if (toolBlock) {
    toolBlock.content = String(resultBlock.content || '');
    toolBlock.is_error = Boolean(resultBlock.is_error);
    toolBlock.status = resultBlock.is_error ? 'error' : 'success';
    if (resultBlock.details) {
      toolBlock.details = { ...resultBlock.details };
    }
    return;
  }
  blocks.push({
    ...cloneContentBlock(resultBlock),
    type: 'tool_use',
    id: toolUseId || resultBlock.id,
    name: resultBlock.name || 'tool',
    status: resultBlock.is_error ? 'error' : 'success',
  });
}

export function buildDisplayMessages(messages: ChatMessage[]): ChatMessage[] {
  const display: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;

  const flushPendingAssistant = (): void => {
    if (!pendingAssistant) return;
    display.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const rawMessage of messages) {
    const message = cloneChatMessage(rawMessage);

    if (isToolResultOnlyMessage(message)) {
      if (pendingAssistant && Array.isArray(message.content)) {
        for (const block of message.content as ContentBlock[]) {
          applyToolResultBlock(pendingAssistant, block);
        }
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (pendingAssistant) {
        pendingAssistant = mergeAssistantMessages(pendingAssistant, message);
      } else {
        pendingAssistant = message;
      }
      continue;
    }

    flushPendingAssistant();
    display.push(message);
  }

  flushPendingAssistant();
  return display;
}
