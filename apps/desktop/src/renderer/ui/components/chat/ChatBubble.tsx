import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MarkdownContent } from './chat-utils.js';
import styles from './ChatBubble.module.scss';
import type { ChatMessage, ContentBlock } from './chat-shared';
import {
  buildChatMetaParts,
  formatToolExecutionLabel,
  getMyrmecochoryLabel,
  renderMarkdownToHtml,
} from './chat-shared';
import { registerStreamingTextUpdater } from '../../../core/streaming-text';

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


function getBlockRenderKey(block: ContentBlock, index: number): string {
  return String(block.renderKey || block.id || block.tool_use_id || `${block.type}-${index}`);
}


// Renders streaming text content directly into the DOM via innerHTML, bypassing
// React re-renders for high-frequency character-level updates. The RAF loop
// in chat.ts calls applyStreamingText(), which writes here imperatively.
// When streaming ends, this component is swapped out for MarkdownContent.
function StreamingText({ initialText }: { initialText: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = renderMarkdownToHtml(initialText);
    }
    return registerStreamingTextUpdater((html) => {
      if (ref.current) ref.current.innerHTML = html;
    });
  }, []); // intentionally empty — updates come imperatively via the bridge

  // eslint-disable-next-line react/no-danger -- content is AI-generated, not user input
  return <div ref={ref} className="chat-bubble-content streaming-cursor" />;
}

function ThinkingBlockView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);

  if (!block.thinking?.trim()) return null;

  const thinkingLabel =
    String(block.name || '').trim() || getMyrmecochoryLabel(block.thinking.length);

  return (
    <div className={`thinking-block${block.streaming ? ' streaming' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="thinking-block-header"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="thinking-block-triangle">▶</span>
        <span>{thinkingLabel}</span>
        {block.streaming ? (
          <span className="thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
      <div className="thinking-block-body">{block.thinking}</div>
    </div>
  );
}

function ToolModal({ item, onClose }: { item: ToolRenderItem; onClose: () => void }) {
  const [closing, setClosing] = useState(false);

  const close = (): void => {
    setClosing(true);
    window.setTimeout(onClose, 180);
  };

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
  const [collapsed, setCollapsed] = useState(true);
  const [modalItem, setModalItem] = useState<ToolRenderItem | null>(null);
  const items = useMemo(
    () => blocks.map((block, index) => buildToolRenderItem(block, index)),
    [blocks],
  );

  const anyRunning = items.some((item) => item.status === 'running');
  const anyError = !anyRunning && items.some((item) => item.status === 'error');
  const groupStatus: 'running' | 'error' | 'success' = anyRunning ? 'running' : anyError ? 'error' : 'success';
  const groupStatusLabel = anyRunning ? 'Running' : anyError ? 'Error' : 'Done';
  const label = `${items.length} tool${items.length === 1 ? '' : 's'} used`;

  return (
    <>
      <div className="tool-group">
        <button
          type="button"
          className={`tool-group-header-btn${collapsed ? ' collapsed' : ''}`}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="tool-group-chevron">›</span>
          <span className="tool-group-label">{label}</span>
          {anyRunning ? (
            <span className="thinking-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          ) : null}
          <span className="tool-group-spacer" />
          <span className={`tool-group-status ${groupStatus}`}>{groupStatusLabel}</span>
        </button>
        <div className={`tool-group-list-wrap${collapsed ? ' collapsed' : ''}`}>
          <div className="tool-group-list-inner">
            <div className="tool-group-list">
              {items.map((item) => {
                const statusLabel =
                  item.kind === 'edit' && item.diff.length > 0
                    ? `+${item.additions} / -${item.removals}`
                    : item.kind === 'bash' && item.outputLineCount > 0
                      ? `${item.outputLineCount} lines`
                      : item.status === 'running'
                        ? 'Running'
                        : item.status === 'error'
                          ? 'Error'
                          : 'Done';
                const hasDetail =
                  item.diff.length > 0 || item.output.trim().length > 0;

                return (
                  <div key={item.id} className="tool-inline">
                    <button
                      type="button"
                      className={`tool-inline-row${hasDetail ? ' expandable' : ''}`}
                      onClick={() => hasDetail && setModalItem(item)}
                    >
                      <span className={`tool-inline-dot ${item.status}`} />
                      <span className="tool-inline-label">{item.label}</span>
                      <span className={`tool-inline-status ${item.status}`}>{statusLabel}</span>
                      <span className={`tool-inline-open${hasDetail ? '' : ' hidden'}`}>↗</span>
                    </button>
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

function renderAssistantBlocks(blocks: ContentBlock[], streaming = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  let toolGroup: ContentBlock[] = [];

  const flushToolGroup = (): void => {
    if (toolGroup.length === 0) return;
    nodes.push(
      <ToolGroupView
        key={`tool-group-${String(toolGroup[0]?.id || toolGroup[0]?.tool_use_id || nodes.length)}`}
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
    nodes.push(renderBlock(block, index, streaming));
  });

  flushToolGroup();
  return nodes;
}

function renderBlock(block: ContentBlock, index: number, streaming = false): ReactNode {
  const blockKey = getBlockRenderKey(block, index);

  if (block.type === 'text') {
    if (block.streaming) {
      return <StreamingText key={blockKey} initialText={String(block.text || '')} />;
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

type ChatBubbleProps = {
  message: ChatMessage;
  streaming?: boolean;
};

export function ChatBubble({ message, streaming = false }: ChatBubbleProps) {
  const [metaExpanded, setMetaExpanded] = useState(false);
  const metaParts = useMemo(() => buildChatMetaParts(message), [message]);

  const content = useMemo(() => {
    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        return renderAssistantBlocks(message.content as ContentBlock[], streaming);
      }
      return <MarkdownContent text={String(message.content)} />;
    }

    if (typeof message.content === 'string') {
      return <MarkdownContent text={message.content} />;
    }

    if (Array.isArray(message.content)) {
      return (message.content as ContentBlock[]).map((block, index) => renderBlock(block, index, streaming));
    }

    return <div className="chat-bubble-content">{JSON.stringify(message.content)}</div>;
  }, [message, streaming]);

  const bubbleMeta =
    metaParts.length > 0 && !streaming ? (
      <button
        type="button"
        className={`${styles.chatBubbleMeta}${metaExpanded ? ` ${styles.chatBubbleMetaExpanded}` : ''}`}
        onClick={() => setMetaExpanded((value) => !value)}
      >
        <span className={styles.chatBubbleStats}>{metaParts.join(' · ')}</span>
      </button>
    ) : null;

  return (
    <div className={`${styles.chatBubble} ${message.role === 'user' ? styles.own : styles.other}`}>
      {bubbleMeta}
      <div>{content}</div>
    </div>
  );
}
