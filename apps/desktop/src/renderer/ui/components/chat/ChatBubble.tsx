import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from './chat-utils.js';
import styles from './ChatBubble.module.scss';

type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string };
};

function formatChatTime(timestamp: unknown): string {
  const ts = Number(timestamp);
  if (!ts || ts <= 0) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  return num.toLocaleString([], { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits });
}

const myrmecochoryPhrases = [
  'Myrmecochory scouting for the right peer',
  'Myrmecochory optimizing route and cost',
  'Myrmecochory validating marketplace path',
  'Myrmecochory checking tool and context trail',
  'Myrmecochory preparing the next inference hop',
];

function getMyrmecochoryLabel(indexBase = 0): string {
  const index = Math.abs(Math.floor(Number(indexBase) || 0)) % myrmecochoryPhrases.length;
  return myrmecochoryPhrases[index];
}

function normalizeAssistantMeta(msg: ChatMessage) {
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
    peerId, peerAddress, peerProviders, peerReputation, peerTrustScore,
    peerCurrentLoad, peerMaxConcurrency, routeRequestId, provider, model,
    inputTokens, outputTokens, totalTokens, tokenSource,
    costUsd: costUsd > 0 ? costUsd : 0,
    latencyMs: latencyMs > 0 ? latencyMs : 0,
  };
}

function countBlocks(blocks: ContentBlock[]) {
  const summary = { text: 0, toolUse: 0, toolResult: 0, thinking: 0 };
  for (const block of blocks) {
    if (block.type === 'text') summary.text += 1;
    if (block.type === 'tool_use') summary.toolUse += 1;
    if (block.type === 'tool_result') summary.toolResult += 1;
    if (block.type === 'thinking') summary.thinking += 1;
  }
  return summary;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toToolDisplayName(name: unknown): string {
  const raw = String(name || 'tool').trim();
  if (!raw) return 'Tool';
  return raw.split(/[_\-\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function compactInlineText(value: unknown, maxLength = 72): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function extractPrimaryToolInput(name: unknown, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rawName = String(name || '').trim().toLowerCase();
  const payload = input as Record<string, unknown>;
  const preferredKeys = rawName === 'bash' ? ['command', 'cmd', 'script', 'args']
    : rawName === 'read_file' ? ['path', 'filePath', 'file', 'target']
    : rawName === 'write_file' ? ['path', 'filePath', 'file', 'target']
    : ['command', 'cmd', 'path', 'query', 'pattern', 'target', 'file'];

  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
    if (Array.isArray(value) && value.length > 0) {
      const rendered = compactInlineText(value.map(String).join(' '));
      if (rendered.length > 0) return rendered;
    }
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
  }
  return '';
}

function renderToolRow(block: ContentBlock): string {
  const toolName = toToolDisplayName(block.name);
  const summary = extractPrimaryToolInput(block.name, block.input);
  const label = summary.length > 0 ? `${toolName} (${summary})` : toolName;
  return `<div class="tool-inline"><div class="tool-inline-row"><span class="tool-inline-dot success"></span><span class="tool-inline-label">${escapeHtml(label)}</span><span class="tool-inline-status success">Done</span></div></div>`;
}

function renderContentBlocks(blocks: ContentBlock[]): string {
  let html = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      html += `<div class="chat-bubble-content">${renderMarkdown(block.text || '')}</div>`;
    } else if (block.type === 'thinking' && block.thinking?.trim()) {
      const thinkingLabel = getMyrmecochoryLabel(block.thinking?.length);
      html += `<div class="thinking-block"><div class="thinking-block-header" onclick="this.parentElement.classList.toggle('open')"><span class="thinking-block-triangle">▶</span><span>${escapeHtml(thinkingLabel)}</span></div><div class="thinking-block-body">${escapeHtml(block.thinking)}</div></div>`;
    } else if (block.type === 'tool_use') {
      html += renderToolRow(block);
    } else if (block.type === 'tool_result' && block.is_error) {
      const outputText = String(block.content || '');
      const truncated = outputText.length > 600 ? `${outputText.slice(0, 600)}\n... (truncated)` : outputText;
      html += `<div class="tool-inline"><div class="tool-inline-row"><span class="tool-inline-dot error"></span><span class="tool-inline-label">Result</span><span class="tool-inline-status error">Error</span></div><div class="tool-inline-output error">${escapeHtml(truncated)}</div></div>`;
    }
  }
  return html;
}

function buildMetaParts(msg: ChatMessage): string[] {
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
    if (assistantMeta.peerProviders.length > 0 && !assistantMeta.provider) parts.push(assistantMeta.peerProviders.join(','));
    if (assistantMeta.totalTokens > 0) {
      const tokenParts = [`${formatCompactNumber(assistantMeta.totalTokens)} tok`];
      if (assistantMeta.inputTokens > 0 || assistantMeta.outputTokens > 0) {
        tokenParts.push(`(${formatCompactNumber(assistantMeta.inputTokens)} in / ${formatCompactNumber(assistantMeta.outputTokens)} out)`);
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
    if (assistantMeta.peerCurrentLoad !== null && assistantMeta.peerMaxConcurrency !== null && assistantMeta.peerMaxConcurrency > 0) {
      parts.push(`load ${Math.round(assistantMeta.peerCurrentLoad)}/${Math.round(assistantMeta.peerMaxConcurrency)}`);
    }
    if (assistantMeta.routeRequestId) parts.push(`route ${assistantMeta.routeRequestId.slice(0, 8)}`);
  }

  return parts;
}

type ChatBubbleProps = {
  message: ChatMessage;
};

export function ChatBubble({ message }: ChatBubbleProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [metaExpanded, setMetaExpanded] = useState(false);
  const metaParts = useMemo(() => buildMetaParts(message), [message]);
  const contentHtml = useMemo(() => {
    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        return renderContentBlocks(message.content as ContentBlock[]);
      }
      return `<div class="chat-bubble-content">${renderMarkdown(String(message.content))}</div>`;
    }
    if (typeof message.content === 'string') {
      return `<div class="chat-bubble-content">${renderMarkdown(message.content)}</div>`;
    }
    // User message with multipart content (e.g. image + text)
    if (Array.isArray(message.content)) {
      let html = '';
      for (const block of message.content as ContentBlock[]) {
        if (block.type === 'image' && block.source?.data && block.source?.media_type) {
          html += `<img src="data:${block.source.media_type};base64,${block.source.data}" class="chat-image-preview" alt="Attached image" />`;
        } else if (block.type === 'text' && block.text) {
          html += `<div class="chat-bubble-content">${renderMarkdown(block.text)}</div>`;
        }
      }
      return html;
    }
    return `<div class="chat-bubble-content">${escapeHtml(JSON.stringify(message.content))}</div>`;
  }, [message.role, message.content]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const handleClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('[data-copy-code="true"]');
      if (!button) return;
      const codeId = button.dataset.copyTarget;
      if (!codeId) return;
      const codeNode = container.querySelector<HTMLElement>(`#${CSS.escape(codeId)}`);
      const codeText = codeNode?.textContent ?? '';
      if (!codeText) return;
      void navigator.clipboard.writeText(codeText).then(() => {
        const previousText = button.textContent;
        button.textContent = 'Copied!';
        window.setTimeout(() => {
          button.textContent = previousText || 'Copy';
        }, 1500);
      });
    };
    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  }, [contentHtml]);

  const bubbleMeta =
    metaParts.length > 0 ? (
      <div
        className={`${styles.chatBubbleMeta}${metaExpanded ? ` ${styles.chatBubbleMetaExpanded}` : ''}`}
        onClick={() => setMetaExpanded((v) => !v)}
      >
        <span className={styles.chatBubbleStats}>{metaParts.join(' · ')}</span>
      </div>
    ) : null;

  return (
    <div className={`${styles.chatBubble} ${message.role === 'user' ? styles.own : styles.other}`}>
      {bubbleMeta}
      <div ref={contentRef} dangerouslySetInnerHTML={{ __html: contentHtml }} />
    </div>
  );
}

export { isToolResultOnlyMessage } from './chat-utils.js';
