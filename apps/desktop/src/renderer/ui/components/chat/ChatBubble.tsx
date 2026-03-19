import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { MarkdownContent } from './chat-utils.js';
import styles from './ChatBubble.module.scss';
import type { ChatMessage, ContentBlock } from './chat-shared';
import {
  buildChatMetaParts,
  formatToolExecutionLabel,
  getMyrmecochoryLabel,
  toToolDisplayName,
} from './chat-shared';
import { isPaymentBubble } from './payment-types';
import { PaymentBubble } from './PaymentBubble';
import { getActions } from '../../actions';

type ToolRenderItem = {
  id: string;
  label: string;
  kind: string;
  status: 'running' | 'success' | 'error';
  output: string;
  outputLineCount: number;
  diff: string;
  additions: number;
  removals: number;
};

function getToolKind(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

function extractToolDiff(block: ContentBlock): string {
  const detailsDiff = block.details?.diff;
  if (typeof detailsDiff === 'string' && detailsDiff.trim().length > 0) {
    return detailsDiff;
  }
  const output = String(block.content || '');
  if (/^--- .*?\n\+\+\+ .*?\n@@/m.test(output)) {
    return output;
  }
  return '';
}

function countDiffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) removals += 1;
  }
  return { additions, removals };
}

function buildToolRenderItem(block: ContentBlock, index: number): ToolRenderItem {
  const output = String(block.content || '');
  const diff = extractToolDiff(block);
  const diffStats = countDiffStats(diff);
  return {
    id: String(block.id || `tool-${index}`),
    label: formatToolExecutionLabel(block.name, block.input),
    kind: getToolKind(block.name),
    status: block.status ?? 'success',
    output,
    outputLineCount: output.split('\n').filter((line) => line.trim().length > 0).length,
    diff,
    additions: diffStats.additions,
    removals: diffStats.removals,
  };
}


// messagePrefix scopes the key to a specific message so that when
// buildDisplayMessages merges consecutive assistant turns, two text-0 blocks
// from different turns don't share the same React key.
function getBlockRenderKey(block: ContentBlock, index: number, messagePrefix = ''): string {
  const base = String(block.renderKey || block.id || block.tool_use_id || `${block.type}-${index}`);
  return messagePrefix ? `${messagePrefix}-${base}` : base;
}


function StreamingMarkdown({ text }: { text: string }) {
  const [visibleText, setVisibleText] = useState(text);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const visibleTextRef = useRef(text);

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (visibleTextRef.current === text) return;
    if (!text.startsWith(visibleTextRef.current)) {
      visibleTextRef.current = text;
      setVisibleText(text);
      return;
    }

    const step = (timestamp: number): void => {
      if (lastFrameAtRef.current <= 0) {
        lastFrameAtRef.current = timestamp;
      }

      const elapsedMs = Math.max(1, timestamp - lastFrameAtRef.current);
      const currentVisibleText = visibleTextRef.current;
      const remaining = text.length - currentVisibleText.length;
      if (remaining <= 0) {
        frameRef.current = null;
        lastFrameAtRef.current = 0;
        return;
      }

      const charsPerSecond = Math.min(2600, Math.max(140, Math.ceil((remaining * 1000) / 180)));
      const charBudget = Math.max(1, Math.floor((elapsedMs * charsPerSecond) / 1000));
      const nextText = text.slice(0, Math.min(text.length, currentVisibleText.length + charBudget));

      lastFrameAtRef.current = timestamp;
      visibleTextRef.current = nextText;
      setVisibleText(nextText);
      if (nextText.length < text.length) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        lastFrameAtRef.current = 0;
      }
    };

    lastFrameAtRef.current = 0;
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      lastFrameAtRef.current = 0;
    };
  }, [text]);

  return (
    <div className="chat-bubble-content streaming-cursor">
      <MarkdownContent text={visibleText} />
    </div>
  );
}

function ThinkingBlockView({ block }: { block: ContentBlock }) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const isOpen = manualToggle ?? true;

  if (!block.thinking?.trim()) return null;

  const thinkingText = String(block.thinking || '');
  const previewLength = 120;
  const preview = thinkingText.length > previewLength
    ? `${thinkingText.slice(0, previewLength).trimEnd()}...`
    : thinkingText;

  return (
    <div className={`thinking-block${block.streaming ? ' streaming' : ''}${isOpen ? ' open' : ''}`}>
      <button
        type="button"
        className="thinking-block-header"
        onClick={() => setManualToggle((prev) => !(prev ?? true))}
      >
        <span className="thinking-block-triangle">▶</span>
        <span>Internal Thoughts</span>
        {block.streaming ? (
          <span className="thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
      {!isOpen && (
        <div className="thinking-block-preview">
          <MarkdownContent text={preview} className="thinking-block-preview-md" />
        </div>
      )}
      <div className="thinking-block-body">
        {block.streaming
          ? <StreamingMarkdown text={thinkingText} />
          : <MarkdownContent text={thinkingText} className="thinking-block-markdown" />}
      </div>
    </div>
  );
}

function ToolDiffInline({ diff }: { diff: string }) {
  return (
    <div className={styles.toolInlineDiff}>
      {diff.split('\n').map((line, index) => {
        let cls = styles.diffContext;
        if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffAdded;
        else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffRemoved;
        else if (line.startsWith('@@')) cls = styles.diffHunk;
        else if (line.startsWith('+++') || line.startsWith('---')) cls = styles.diffFile;
        return (
          <div key={`${index}-${line.slice(0, 12)}`} className={`${styles.diffLine} ${cls}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

function ToolModal({ item, onClose }: { item: ToolRenderItem; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const closingTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const close = (): void => {
    setClosing(true);
    closingTimerRef.current = window.setTimeout(onClose, 180);
  };

  // Clean up the close timer if the parent unmounts while the modal is open.
  useEffect(() => {
    return () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const outputText =
    item.output.length > 20000
      ? `${item.output.slice(0, 20000)}\n... (truncated)`
      : item.output;

  const statusLabel =
    item.status === 'running' ? 'Running' : item.status === 'error' ? 'Error' : 'Done';

  return createPortal(
    <div
      className={`${styles.toolModalBackdrop}${closing ? ` ${styles.toolModalClosing}` : ''}`}
      onClick={close}
      role="presentation"
    >
      <div
        className={styles.toolModalPanel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={item.label}
      >
        <div className={styles.toolModalHeader}>
          <div className={styles.toolModalTitle}>
            <span className={`${styles.toolModalDot} ${styles[item.status]}`} />
            <span className={styles.toolModalName}>{item.label}</span>
            <span className={`${styles.toolModalStatusBadge} ${styles[item.status]}`}>
              {statusLabel}
            </span>
          </div>
          <button type="button" className={styles.toolModalClose} onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={styles.toolModalBody}>
          {item.diff.length > 0 ? (
            <div className={styles.toolModalDiff}>
              {item.diff.split('\n').map((line, index) => {
                let cls = styles.diffContext;
                if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffAdded;
                else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffRemoved;
                else if (line.startsWith('@@')) cls = styles.diffHunk;
                else if (line.startsWith('+++') || line.startsWith('---')) cls = styles.diffFile;
                return (
                  <div key={`${index}-${line.slice(0, 12)}`} className={`${styles.diffLine} ${cls}`}>
                    {line}
                  </div>
                );
              })}
            </div>
          ) : outputText.trim().length > 0 ? (
            <pre className={`${styles.toolModalOutput}${item.status === 'error' ? ` ${styles.toolModalOutputError}` : ''}`}>
              {outputText}
            </pre>
          ) : (
            <div className={styles.toolModalEmpty}>No output</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolGroupView({ blocks }: { blocks: ContentBlock[] }) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const [modalItem, setModalItem] = useState<ToolRenderItem | null>(null);
  const wasRunningRef = useRef(false);
  const items = useMemo(
    () => blocks.map((block, index) => buildToolRenderItem(block, index)),
    [blocks],
  );

  const anyRunning = items.some((item) => item.status === 'running');
  const anyError = items.some((item) => item.status === 'error');

  // Auto-collapse when tools finish running
  if (wasRunningRef.current && !anyRunning) {
    wasRunningRef.current = false;
  }
  if (anyRunning) wasRunningRef.current = true;

  // Open while running (unless user manually closed), collapsed when done (unless user manually opened)
  const isOpen = manualToggle ?? anyRunning;

  const groupStatus: 'running' | 'success' | 'error' = anyRunning ? 'running' : anyError ? 'error' : 'success';
  const groupStatusLabel = anyRunning ? 'Running' : anyError ? 'Error' : 'Done';
  const label = `Tools (${items.length})`;
  const runningSummary = items
    .filter((item) => item.status === 'running')
    .map((item) => item.label)
    .join(' / ');
  const preview = items
    .slice(0, 3)
    .map((item) => item.label)
    .join(' • ');
  const previewSuffix = items.length > 3 ? ` +${items.length - 3} more` : '';

  return (
    <>
      <div className={`tool-group${anyRunning ? ' streaming' : ''}${isOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="tool-group-header-btn"
          onClick={() => setManualToggle((prev) => !(prev ?? anyRunning))}
        >
          <span className="tool-group-chevron">›</span>
          <span className="tool-group-label">{label}</span>
          {anyRunning ? (
            <span className="thinking-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          ) : null}
        </button>
        {!isOpen ? (
          <div className="tool-group-preview">
            <span className="tool-group-preview-text">
              {runningSummary || preview}
              {previewSuffix}
            </span>
            <span className={`tool-group-status ${groupStatus}`}>{groupStatusLabel}</span>
          </div>
        ) : null}
        <div className={`tool-group-list-wrap${isOpen ? '' : ' collapsed'}`}>
          <div className="tool-group-list-inner">
            <div className="tool-group-list">
              {items.map((item) => {
                const hasInlineDiff = item.kind === 'edit' && item.diff.length > 0;
                const hasDetail = !hasInlineDiff && (item.diff.length > 0 || item.output.trim().length > 0);

                const statusNode =
                  hasInlineDiff ? (
                    <span className={`tool-inline-status ${item.status}`}>
                      <span className="diff-additions">+{item.additions}</span>
                      {' / '}
                      <span className="diff-removals">-{item.removals}</span>
                    </span>
                  ) : (
                    <span className={`tool-inline-status ${item.status}`}>
                      {item.kind === 'bash' && item.outputLineCount > 0
                        ? `${item.outputLineCount} lines`
                        : item.status === 'running'
                          ? 'Running'
                          : item.status === 'error'
                            ? 'Error'
                            : 'Done'}
                    </span>
                  );

                return (
                  <div key={item.id} className="tool-inline">
                    <button
                      type="button"
                      className={`tool-inline-row${hasDetail ? ' expandable' : ''}${hasInlineDiff ? ' has-inline-diff' : ''}`}
                      onClick={() => hasDetail && setModalItem(item)}
                    >
                      <span className={`tool-inline-dot ${item.status}`} />
                      <span className="tool-inline-label">{item.label}</span>
                      {statusNode}
                      <span className={`tool-inline-open${hasDetail ? '' : ' hidden'}`}>↗</span>
                    </button>
                    {hasInlineDiff ? <ToolDiffInline diff={item.diff} /> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {modalItem ? (
        <ToolModal item={modalItem} onClose={() => setModalItem(null)} />
      ) : null}
    </>
  );
}

function renderAssistantBlocks(blocks: ContentBlock[], streaming = false, messagePrefix = ''): ReactNode[] {
  const nodes: ReactNode[] = [];
  let toolGroup: ContentBlock[] = [];

  const flushToolGroup = (): void => {
    if (toolGroup.length === 0) return;
    nodes.push(
      <ToolGroupView
        key={`${messagePrefix}-tool-group-${nodes.length}-${String(toolGroup[0]?.id || toolGroup[0]?.tool_use_id || '')}`}
        blocks={toolGroup}
      />,
    );
    toolGroup = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      toolGroup.push(block);
      return;
    }
    flushToolGroup();
    nodes.push(renderBlock(block, index, streaming, messagePrefix));
  });

  flushToolGroup();
  return nodes;
}

function renderBlock(block: ContentBlock, index: number, streaming = false, messagePrefix = ''): ReactNode {
  const blockKey = getBlockRenderKey(block, index, messagePrefix);

  if (block.type === 'text') {
    if (block.streaming) {
      return <StreamingMarkdown key={blockKey} text={String(block.text || '')} />;
    }
    return <MarkdownContent key={blockKey} text={String(block.text || '')} />;
  }

  if (block.type === 'thinking') {
    return <ThinkingBlockView key={blockKey} block={block} />;
  }

  if (block.type === 'tool_use') {
    // tool_use blocks are grouped by renderAssistantBlocks into ToolGroupView
    return null;
  }

  if (block.type === 'tool_result' && block.is_error) {
    const normalizedOutput = String(block.content || '');
    const truncated =
      normalizedOutput.length > 600
        ? `${normalizedOutput.slice(0, 600)}\n... (truncated)`
        : normalizedOutput;
    return (
      <div key={blockKey} className="tool-inline">
        <div className="tool-inline-output error">{truncated}</div>
      </div>
    );
  }

  if (block.type === 'image' && block.source?.data && block.source?.media_type) {
    return (
      <img
        key={blockKey}
        src={`data:${block.source.media_type};base64,${block.source.data}`}
        className="chat-image-preview"
        alt="Attached image"
      />
    );
  }

  return null;
}

function extractPlainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((block) => block.type === 'text' || block.type === 'thinking')
      .map((block) => (block.type === 'thinking' ? String(block.thinking || '') : String(block.text || '')))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function CopyResponseButton({ content }: { content: unknown }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    const text = extractPlainText(content);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {/* clipboard denied — silently ignore */});
  }, [content]);

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`${styles.copyResponseBtn}${copied ? ` ${styles.copyResponseBtnCopied}` : ''}`}
            onClick={handleCopy}
            aria-label={copied ? 'Copied!' : 'Copy response'}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={16}
              color="currentColor"
              strokeWidth={2}
            />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={styles.tooltipContent} sideOffset={5}>
            {copied ? 'Copied!' : 'Copy'}
            <Tooltip.Arrow className={styles.tooltipArrow} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

type ChatBubbleProps = {
  message: ChatMessage;
  streaming?: boolean;
};

export function ChatBubble({ message, streaming = false }: ChatBubbleProps) {
  const [metaExpanded, setMetaExpanded] = useState(false);
  const metaParts = useMemo(() => buildChatMetaParts(message), [message]);
  const hasStreamingBlocks = useMemo(
    () =>
      Array.isArray(message.content) &&
      (message.content as ContentBlock[]).some((block) => block.streaming),
    [message.content],
  );
  const isStreamingBubble = streaming || hasStreamingBlocks;

  // Derive a stable per-message prefix so block keys are scoped to this message
  // and don't collide when buildDisplayMessages merges consecutive assistant turns.
  const messagePrefix = String(
    (message as { id?: unknown }).id ||
    message.createdAt ||
    message.role,
  );

  const content = useMemo(() => {
    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        return renderAssistantBlocks(message.content as ContentBlock[], isStreamingBubble, messagePrefix);
      }
      return <MarkdownContent text={String(message.content)} />;
    }

    if (typeof message.content === 'string') {
      return <MarkdownContent text={message.content} />;
    }

    if (Array.isArray(message.content)) {
      return (message.content as ContentBlock[]).map((block, index) => renderBlock(block, index, isStreamingBubble, messagePrefix));
    }

    return <div className="chat-bubble-content">{JSON.stringify(message.content)}</div>;
  }, [message, isStreamingBubble, messagePrefix]);

  const bubbleMeta =
    metaParts.length > 0 && !isStreamingBubble ? (
      <button
        type="button"
        className={`${styles.chatBubbleMeta}${metaExpanded ? ` ${styles.chatBubbleMetaExpanded}` : ''}`}
        onClick={() => setMetaExpanded((value) => !value)}
      >
        <span className={styles.chatBubbleStats}>{metaParts.join(' · ')}</span>
      </button>
    ) : null;

  if (isPaymentBubble(message)) {
    return (
      <PaymentBubble
        message={message}
        onComplete={(callbackId) => {
          const actions = getActions();
          actions.onPaymentComplete?.(callbackId);
        }}
      />
    );
  }

  return (
    <div className={`${styles.chatBubble} ${message.role === 'user' ? styles.own : styles.other}`}>
      {bubbleMeta}
      <div>{content}</div>
      {message.role !== 'user' && !isStreamingBubble ? (
        <div className={styles.messageActions}>
          <CopyResponseButton content={message.content} />
        </div>
      ) : null}
    </div>
  );
}
