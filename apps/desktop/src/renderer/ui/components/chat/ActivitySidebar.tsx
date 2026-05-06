// Codex-style activity sidebar (experiment).
//
// Renders the processBlocks (thinking / tool_use / tool_result) of a single
// assistant turn — the user-selected one, or the live streaming one, or the
// latest assistant turn by default. The sidebar lives next to .chatMain in
// ChatView and scrolls independently from the main conversation.
//
// Reuses ThinkingBlockView and ToolGroupView from ChatBubble so the sidebar
// looks visually consistent with the existing inline rendering.

import { useMemo } from 'react';
import type { ChatMessage, ContentBlock } from './chat-shared';
import {
  buildAssistantTurnContent,
  summarizeAssistantProcess,
} from './chat-shared';
import { ThinkingBlockView, ToolGroupView } from './ChatBubble';
import styles from './ActivitySidebar.module.scss';

type ActivitySidebarProps = {
  message: ChatMessage | null;
  /** True when `message` is the currently streaming assistant turn. */
  streaming: boolean;
  /** Forwarded to ToolGroupView so preview-capable tools keep their button. */
  onOpenPreview?: (url: string) => void;
};

export function ActivitySidebar({ message, streaming, onOpenPreview }: ActivitySidebarProps) {
  const turn = useMemo(
    () => (message ? buildAssistantTurnContent(message.content) : null),
    [message],
  );
  const processBlocks = turn?.processBlocks ?? [];
  const summary = useMemo(() => summarizeAssistantProcess(processBlocks), [processBlocks]);

  const thinkingBlocks = processBlocks.filter((b) => b.type === 'thinking');
  const toolUseBlocks = processBlocks.filter((b) => b.type === 'tool_use');
  const errorResultBlocks = processBlocks.filter(
    (b) => b.type === 'tool_result' && (b.is_error || b.status === 'error'),
  );

  const statusPill =
    streaming && summary.running > 0
      ? { label: 'Streaming', tone: styles.pillStreaming }
      : summary.errors > 0
        ? { label: 'Errors', tone: styles.pillError }
        : summary.total > 0
          ? { label: 'Done', tone: styles.pillIdle }
          : null;

  return (
    <aside className={styles.activitySidebar} aria-label="Assistant activity">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.title}>Activity</span>
          {statusPill && (
            <span className={`${styles.pill} ${statusPill.tone}`}>{statusPill.label}</span>
          )}
        </div>
        <div className={styles.subtitle}>Behind the scenes</div>
        {message && summary.total > 0 ? (
          <div className={styles.counts}>
            {summary.toolUse > 0 && (
              <span className={styles.countChip}>
                {summary.toolUse} tool{summary.toolUse === 1 ? '' : 's'}
              </span>
            )}
            {summary.thinking > 0 && (
              <span className={styles.countChip}>
                {summary.thinking} reasoning
              </span>
            )}
            {summary.errors > 0 && (
              <span className={`${styles.countChip} ${styles.countChipError}`}>
                {summary.errors} error{summary.errors === 1 ? '' : 's'}
              </span>
            )}
          </div>
        ) : null}
      </header>

      <div className={styles.scroll}>
        {!message ? (
          <EmptyState
            title="No assistant turn selected"
            hint="Activity for the latest or streaming response will appear here."
          />
        ) : summary.total === 0 ? (
          <EmptyState
            title="No process activity"
            hint="This response had no reasoning, tool calls, or errors."
          />
        ) : (
          <>
            {thinkingBlocks.length > 0 && (
              <Section label="Reasoning">
                {thinkingBlocks.map((block, index) => (
                  <ThinkingBlockView
                    key={`activity-thinking-${index}-${String(block.id || index)}`}
                    block={block}
                  />
                ))}
              </Section>
            )}

            {toolUseBlocks.length > 0 && (
              <Section label="Tools">
                <ToolGroupView blocks={toolUseBlocks} onOpenPreview={onOpenPreview} />
              </Section>
            )}

            {errorResultBlocks.length > 0 && (
              <Section label="Errors">
                {errorResultBlocks.map((block, index) => (
                  <ErrorResult key={`activity-error-${index}`} block={block} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionLabel}>{label}</h3>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptyHint}>{hint}</div>
    </div>
  );
}

function ErrorResult({ block }: { block: ContentBlock }) {
  const text = String(block.content || '');
  const truncated = text.length > 600 ? `${text.slice(0, 600)}\n... (truncated)` : text;
  return (
    <div className={styles.errorResult}>
      <pre className={styles.errorOutput}>{truncated || 'Tool reported an error.'}</pre>
    </div>
  );
}
