import { Lexer } from 'marked';

type LexerToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  tokens?: LexerToken[];
  items?: LexerToken[];
  ordered?: boolean;
  depth?: number;
  href?: string;
  title?: string | null;
  header?: LexerToken[];
  rows?: LexerToken[][];
  align?: Array<'center' | 'left' | 'right' | null>;
  task?: boolean;
  checked?: boolean;
};

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, 'https://antseed.invalid');
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function flatInline(tokens: LexerToken[] | undefined): string {
  if (!tokens?.length) return '';
  let out = '';
  for (const t of tokens) {
    if (t.type === 'br') { out += '<br>'; continue; }
    if (t.tokens?.length) { out += flatInline(t.tokens); continue; }
    out += String(t.text ?? t.raw ?? '');
  }
  return out;
}

function inlineHtml(tokens: LexerToken[] | undefined): string {
  if (!tokens?.length) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += t.tokens?.length ? inlineHtml(t.tokens) : esc(String(t.text ?? ''));
        break;
      case 'escape':
        out += esc(String(t.text ?? ''));
        break;
      case 'strong':
        out += `<strong>${inlineHtml(t.tokens)}</strong>`;
        break;
      case 'em':
        out += `<em>${inlineHtml(t.tokens)}</em>`;
        break;
      case 'del':
        out += `<del>${inlineHtml(t.tokens)}</del>`;
        break;
      case 'codespan':
        out += `<code class="chat-inline-code">${esc(String(t.text ?? ''))}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'link': {
        const href = String(t.href ?? '');
        const inner = inlineHtml(t.tokens) || esc(href);
        if (!isSafeHref(href)) {
          out += `<span class="chat-inline-link-invalid">${inner}</span>`;
        } else {
          const titleAttr = t.title ? ` title="${esc(t.title)}"` : '';
          out += `<a href="${esc(href)}" style="color:var(--accent-blue);text-decoration:underline" target="_blank" rel="noopener noreferrer"${titleAttr}>${inner}</a>`;
        }
        break;
      }
      case 'image': {
        const href = String(t.href ?? '');
        const alt = flatInline(t.tokens) || esc(String(t.text ?? '')) || 'Image';
        if (!isSafeHref(href)) {
          out += `<span class="chat-inline-link-invalid">${alt}</span>`;
        } else {
          out += `<img src="${esc(href)}" alt="${alt}" class="chat-inline-image">`;
        }
        break;
      }
      default:
        out += t.tokens?.length ? inlineHtml(t.tokens) : esc(String(t.text ?? t.raw ?? ''));
    }
  }
  return out;
}

function listItemHtml(token: LexerToken): string {
  if (!token.tokens?.length) return esc(String(token.text ?? token.raw ?? ''));
  const hasBlock = token.tokens.some(
    (t) => !['paragraph', 'space', 'text', 'strong', 'em', 'codespan', 'link', 'del', 'br'].includes(t.type),
  );
  return hasBlock ? blocksHtml(token.tokens) : inlineHtml(token.tokens);
}

function blocksHtml(tokens: LexerToken[]): string {
  let out = '';
  for (const [, t] of tokens.entries()) {
    switch (t.type) {
      case 'space':
        break;
      case 'paragraph':
        out += `<p>${inlineHtml(t.tokens)}</p>`;
        break;
      case 'text':
        out += t.tokens?.length ? `<p>${inlineHtml(t.tokens)}</p>` : `<p>${esc(String(t.text ?? ''))}</p>`;
        break;
      case 'heading': {
        const depth = Math.min(Math.max(Number(t.depth) || 1, 1), 6);
        out += `<h${depth}>${inlineHtml(t.tokens)}</h${depth}>`;
        break;
      }
      case 'code': {
        const lang = (t.lang ?? '').trim() || 'code';
        out += `<div class="chat-code-container"><div class="chat-code-header"><span class="code-lang">${esc(lang)}</span></div><pre><code>${esc(String(t.text ?? ''))}</code></pre></div>`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>${blocksHtml(t.tokens ?? [])}</blockquote>`;
        break;
      case 'hr':
        out += '<hr>';
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const items = (t.items ?? []).map((item) => {
          if (item.task) {
            const checked = item.checked ? ' checked' : '';
            return `<li class="chat-md-li"><label class="chat-task-item"><input type="checkbox"${checked} disabled>${listItemHtml(item)}</label></li>`;
          }
          return `<li class="chat-md-li">${listItemHtml(item)}</li>`;
        }).join('');
        out += `<${tag} class="chat-md-list">${items}</${tag}>`;
        break;
      }
      case 'table': {
        const headerCells = (t.header ?? []).map((cell, ci) => {
          const align = t.align?.[ci];
          const alignAttr = align ? ` align="${align}"` : '';
          const content = cell.tokens?.length ? inlineHtml(cell.tokens) : esc(String(cell.text ?? cell.raw ?? ''));
          return `<th${alignAttr}>${content}</th>`;
        }).join('');
        const bodyRows = (t.rows ?? []).map((row) => {
          const cells = row.map((cell, ci) => {
            const align = t.align?.[ci];
            const alignAttr = align ? ` align="${align}"` : '';
            const content = cell.tokens?.length ? inlineHtml(cell.tokens) : esc(String(cell.text ?? cell.raw ?? ''));
            return `<td${alignAttr}>${content}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
        out += `<div class="chat-table-wrap"><table class="chat-md-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
        break;
      }
      default:
        if (t.tokens?.length) {
          out += `<p>${inlineHtml(t.tokens)}</p>`;
        } else {
          out += `<p>${esc(String(t.text ?? t.raw ?? ''))}</p>`;
        }
    }
  }
  return out;
}

export function renderMarkdownToHtml(text: string): string {
  const tokens = Lexer.lex(text, { gfm: true, breaks: true }) as LexerToken[];
  return blocksHtml(tokens);
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
  fileName?: string;
  mimeType?: string;
  size?: number;
  /** ID under which the raw bytes live in the attachment store. When
   *  present the renderer can build an `antseed-attachment://` URL and
   *  preview the file natively. */
  attachmentId?: string;
  error?: string;
  truncated?: boolean;
  attachment?: unknown;
  details?: Record<string, unknown>;
  status?: 'ready' | 'running' | 'success' | 'error';
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
  service: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: 'estimated' | 'usage' | 'unknown';
  costUsd: number;
  latencyMs: number;
};

export const THINKING_PHRASES: readonly string[] = [
  'Hodl',
  'Brrrr',
  'NGMI',
  'WAGMI',
  'To the moon',
  'Wen channel',
  'gm',
  'Stacking sats',
  'Few understand',
  'LFG',
  'Probably nothing',
  'Aping in',
  'This is the way',
  'Ser, pls wait',
  'Number go up',
  'Diamond hands',
  'p2p2pinging',
  'Foraging for tokens',
  'Pinning to the DHT',
  'Sharding the prompt',
];

const myrmecochoryPhrases = THINKING_PHRASES;

export function paymentLogToThinkingPhase(line: string): string | null {
  if (!line) return null;

  // Ignore no-op lines so they don't stick as the phase label.
  if (line.includes('NeedAuth stale')) return null;
  if (line.includes('NeedAuth: maxSignable')) return null;
  if (line.includes('NeedAuth responded')) return null;

  // --- Payment negotiation ---
  if (line.includes('[PaymentMux] ← recv PaymentRequired')) return 'Received 402 Payment Required';
  if (line.includes('[BuyerNegotiator] Got 402')) return 'Auto-negotiating payment';
  if (line.includes('[BuyerNegotiator] PaymentRequired')) return 'Parsing payment terms';
  if (line.includes('[BuyerPayment] authorizeSpending')) return 'Signing SpendingAuth';
  if (line.includes('[BuyerPayment] signPerRequestAuth')) return 'Signing per-request auth';
  if (line.includes('[BuyerPayment] topUpReserve sent')) return 'Reserve top-up broadcast';
  if (line.includes('[BuyerPayment] topUpReserve')) return 'Topping up reserve';
  if (line.includes('[BuyerPayment] Depositing')) return 'Depositing to escrow';
  if (line.includes('[BuyerPayment] Withdrawing')) return 'Withdrawing from escrow';
  if (line.includes('[BuyerPayment] NeedAuth: channel')) return 'Co-signing request cost';
  if (line.includes('[BuyerPayment] AuthAck confirmed')) return 'Auth confirmed by seller';
  if (line.includes('[BuyerNegotiator] Per-request SpendingAuth sent')) return 'Per-request auth sent';
  if (line.includes('[BuyerNegotiator] SpendingAuth sent to seller')) return 'Awaiting seller ack';
  if (line.includes('[BuyerNegotiator] AuthAck received')) return 'Seller acked auth';
  if (line.includes('[BuyerNegotiator] Payment negotiated')) return 'Payment ready';
  if (line.includes('[BuyerNegotiator] Reserve top-up needed')) return 'Reserve top-up needed';

  // --- Payment wire ---
  if (line.includes('[PaymentMux] → send SpendingAuth')) return 'Sending SpendingAuth';
  if (line.includes('[PaymentMux] → send ReserveAuth')) return 'Sending ReserveAuth';
  if (line.includes('[PaymentMux] → send AuthAck')) return 'Acking seller auth';
  if (line.includes('[PaymentMux] ← recv SpendingAuth')) return 'Received SpendingAuth';
  if (line.includes('[PaymentMux] ← recv ReserveAuth')) return 'Received ReserveAuth';
  if (line.includes('[PaymentMux] ← recv AuthAck')) return 'Received auth ack';
  if (line.includes('[PaymentMux] ← recv NeedAuth')) return 'Settling request with seller';

  // --- Cold-start connection events (only fire when a new peer dial happens) ---
  if (line.includes('[Node] Connecting to')) return 'Dialing peer';
  if (line.includes('[Node] Connection state: open')) return 'Peer connection open';

  return null;
}

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

export function shortServiceName(service: unknown): string {
  const raw = String(service || '').trim();
  if (!raw) return 'unknown-service';
  return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
}

export function formatCompactNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  return Math.floor(num).toLocaleString();
}

export function formatUsd(value: unknown, fractionDigits = 2): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return (0).toFixed(fractionDigits);
  return num.toLocaleString([], { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
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
  const service = typeof meta.service === 'string' && (meta.service as string).trim().length > 0 ? (meta.service as string).trim() : null;
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
    service,
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
  const assistantMeta = normalizeAssistantMeta(msg);

  if (blocks && msg.role === 'assistant') {
    const contentParts = splitAssistantMessageContent(msg);
    const responseStats = countBlocks(contentParts.responseBlocks);
    const processStats = countBlocks(contentParts.processBlocks);

    if (processStats.toolUse > 0) parts.push(`${processStats.toolUse} tool${processStats.toolUse === 1 ? '' : 's'}`);
    if (processStats.thinking > 0) parts.push(`${processStats.thinking} reasoning`);
    if (responseStats.text > 0) parts.push(`${responseStats.text} text block${responseStats.text === 1 ? '' : 's'}`);
  }

  if (assistantMeta) {
    if (assistantMeta.peerId) parts.push(`peer ${assistantMeta.peerId.slice(0, 8)}`);
    if (assistantMeta.provider) parts.push(assistantMeta.provider);
    if (assistantMeta.service) parts.push(shortServiceName(assistantMeta.service));
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
    }
    if (assistantMeta.costUsd > 0) parts.push(`$${formatUsd(assistantMeta.costUsd)}`);
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

export type AssistantContentBlockKind = 'response' | 'process';

export type AssistantContentBlockPart = {
  kind: AssistantContentBlockKind;
  block: ContentBlock;
};

export type AssistantMessageContentParts = {
  /** Blocks that represent the assistant-facing answer content for the main chat. */
  responseBlocks: ContentBlock[];
  /** Blocks that represent the assistant's background process, tools, and reasoning. */
  processBlocks: ContentBlock[];
};

export type AssistantTurnContent = AssistantMessageContentParts & {
  /**
   * Original assistant block order annotated with the lane it belongs to.
   *
   * This lets the current inline chat renderer keep existing behavior while
   * future turn-level UI can render responseBlocks and processBlocks in
   * separate, related lanes.
   */
  orderedParts: AssistantContentBlockPart[];
};

export function isAssistantProcessBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'tool_use' || block.type === 'tool_result';
}

export function isAssistantResponseBlock(block: ContentBlock): boolean {
  // Safe fallback: unknown/new block types stay with the response path until
  // they are intentionally routed into the background-process path here.
  return !isAssistantProcessBlock(block);
}

export function buildAssistantTurnContent(content: unknown): AssistantTurnContent {
  const responseBlocks: ContentBlock[] = [];
  const processBlocks: ContentBlock[] = [];
  const orderedParts: AssistantContentBlockPart[] = [];

  for (const block of asContentBlocks(content)) {
    if (isAssistantProcessBlock(block)) {
      processBlocks.push(block);
      orderedParts.push({ kind: 'process', block });
    } else {
      responseBlocks.push(block);
      orderedParts.push({ kind: 'response', block });
    }
  }

  return { responseBlocks, processBlocks, orderedParts };
}

export function splitAssistantContentBlocks(content: unknown): AssistantMessageContentParts {
  const { responseBlocks, processBlocks } = buildAssistantTurnContent(content);
  return { responseBlocks, processBlocks };
}

export function splitAssistantMessageContent(message: ChatMessage): AssistantMessageContentParts {
  if (message.role !== 'assistant') {
    return { responseBlocks: asContentBlocks(message.content), processBlocks: [] };
  }
  return splitAssistantContentBlocks(message.content);
}

export function hasAssistantProcessContent(message: ChatMessage): boolean {
  return message.role === 'assistant' && splitAssistantMessageContent(message).processBlocks.length > 0;
}

export function hasAssistantResponseContent(message: ChatMessage): boolean {
  return splitAssistantMessageContent(message).responseBlocks.length > 0;
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
