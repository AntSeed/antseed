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

function ToolDiffPreview({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="tool-diff-preview">
      {lines.map((line, index) => {
        let className = 'context';
        if (line.startsWith('+') && !line.startsWith('+++')) className = 'added';
        else if (line.startsWith('-') && !line.startsWith('---')) className = 'removed';
        else if (line.startsWith('@@')) className = 'hunk';
        else if (line.startsWith('+++') || line.startsWith('---')) className = 'file';
        return (
          <div key={`${index}-${line.slice(0, 16)}`} className={`tool-diff-line ${className}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
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

function ToolGroupView({ blocks }: { blocks: ContentBlock[] }) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const items = useMemo(
    () => blocks.map((block, index) => buildToolRenderItem(block, index)),
    [blocks],
  );

  return (
    <div className="tool-group">
      <div className="tool-group-header">
        <span>{items.length} tool{items.length === 1 ? '' : 's'}</span>
      </div>
      <div className="tool-group-list">
        {items.map((item) => {
          const canExpand =
            item.diff.length > 0 ||
            item.output.trim().length > 0 ||
            item.kind === 'bash';
          const isExpanded = expandedToolId === item.id;
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
          const outputText =
            item.output.length > 8000
              ? `${item.output.slice(0, 8000)}\n... (truncated)`
              : item.output;

          return (
            <div key={item.id} className="tool-inline">
              <button
                type="button"
                className={`tool-inline-row${canExpand ? ' expandable' : ''}`}
                onClick={() => {
                  if (!canExpand) return;
                  setExpandedToolId((current) => (current === item.id ? null : item.id));
                }}
              >
                <span className={`tool-inline-dot ${item.status}`} />
                <span className="tool-inline-label">{item.label}</span>
                <span className={`tool-inline-status ${item.status}`}>{statusLabel}</span>
              </button>
              {isExpanded ? (
                item.diff.length > 0 ? (
                  <ToolDiffPreview diff={item.diff} />
                ) : (
                  <div className={`tool-inline-output${item.status === 'error' ? ' error' : ''}`}>
                    {outputText.trim().length > 0 ? outputText : '(no output)'}
                  </div>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderAssistantBlocks(blocks: ContentBlock[], streaming = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  let toolGroup: ContentBlock[] = [];

  const flushToolGroup = (): void => {
    if (toolGroup.length === 0) return;
    nodes.push(
      <ToolGroupView
        key={`tool-group-${toolGroup.map((block) => String(block.id || '')).join('-')}`}
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
    return (
      <MarkdownContent
        key={blockKey}
        text={String(block.text || '')}
        className="chat-bubble-content"
      />
    );
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
