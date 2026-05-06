// Codex-style activity sidebar (experiment, v2).
//
// Quiet, compact, review-oriented surface that lives next to the main chat in
// ChatView. Renders the processBlocks of a single assistant turn (selected,
// streaming, or latest) projected into four sections:
//
//   Plan    — short clamped reasoning preview (thinking blocks)
//   Actions — chronological tool calls, expandable inline
//   Files   — files the agent read / wrote / edited / listed
//   Results — errored tool calls and standalone error results
//
// The sidebar does NOT reuse ThinkingBlockView / ToolGroupView from the main
// chat. Those renderers compete with the chat visually. This file ships its
// own compact rows so the sidebar stays a secondary, scannable surface.

import { useMemo, useState } from 'react';
import type { ChatMessage } from './chat-shared';
import {
  buildAssistantTurnContent,
  formatChatTime,
  groupAssistantActivity,
  summarizeAssistantProcess,
  type ActivityActionItem,
  type ActivityFileItem,
  type ActivityPlanItem,
  type ActivityResultItem,
  type FileActionKind,
} from './chat-shared';
import styles from './ActivitySidebar.module.scss';

const PLAN_PREVIEW_LIMIT = 220;

type ActivitySidebarProps = {
  message: ChatMessage | null;
  /** True when `message` is the currently streaming assistant turn. */
  streaming: boolean;
  /** True when the user has explicitly pinned the sidebar to a non-latest
   *  turn. The header shows a "↻ Show latest" affordance in that case. */
  pinned: boolean;
  onShowLatest?: () => void;
  onOpenPreview?: (url: string) => void;
};

export function ActivitySidebar({
  message,
  streaming,
  pinned,
  onShowLatest,
  onOpenPreview,
}: ActivitySidebarProps) {
  const turn = useMemo(
    () => (message ? buildAssistantTurnContent(message.content) : null),
    [message],
  );
  const processBlocks = turn?.processBlocks ?? [];
  const grouped = useMemo(() => groupAssistantActivity(processBlocks), [processBlocks]);
  const summary = useMemo(() => summarizeAssistantProcess(processBlocks), [processBlocks]);

  const statusLabel =
    streaming && summary.running > 0
      ? 'Streaming'
      : summary.errors > 0
        ? 'Errors'
        : summary.total > 0
          ? 'Done'
          : 'Idle';
  const statusTone =
    statusLabel === 'Streaming'
      ? styles.dotStreaming
      : statusLabel === 'Errors'
        ? styles.dotError
        : statusLabel === 'Done'
          ? styles.dotDone
          : styles.dotIdle;

  const turnTime = message?.createdAt ? formatChatTime(message.createdAt) : '';

  return (
    <aside className={styles.activitySidebar} aria-label="Assistant activity">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.title}>Activity</span>
          <span className={styles.status}>
            <span className={`${styles.dot} ${statusTone}`} aria-hidden />
            <span className={styles.statusLabel}>{statusLabel}</span>
          </span>
        </div>
        {pinned && message ? (
          <div className={styles.scope}>
            <span className={styles.scopeText}>
              Earlier turn{turnTime ? ` · ${turnTime}` : ''}
            </span>
            {onShowLatest && (
              <button type="button" className={styles.scopeBtn} onClick={onShowLatest}>
                ↻ Show latest
              </button>
            )}
          </div>
        ) : null}
      </header>

      <div className={styles.scroll}>
        {!message ? (
          <EmptyState
            title="No assistant turn yet"
            hint="Activity for the latest response will appear here."
          />
        ) : summary.total === 0 ? (
          <EmptyState
            title="No background activity"
            hint="This response had no reasoning, tool calls, or errors."
          />
        ) : (
          <>
            {grouped.plan.length > 0 && <PlanSection items={grouped.plan} />}
            {grouped.actions.length > 0 && (
              <ActionsSection items={grouped.actions} onOpenPreview={onOpenPreview} />
            )}
            {grouped.files.length > 0 && <FilesSection items={grouped.files} />}
            {grouped.results.length > 0 && <ResultsSection items={grouped.results} />}
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function PlanSection({ items }: { items: ActivityPlanItem[] }) {
  // Plan is intentionally short. Only the latest thinking block is shown;
  // older ones collapse into a tiny "+N earlier" affordance that toggles
  // the rest. This keeps the sidebar from becoming a reading surface.
  const latest = items[items.length - 1];
  const earlier = items.slice(0, -1);
  const [showEarlier, setShowEarlier] = useState(false);
  const [expandLatest, setExpandLatest] = useState(false);

  const preview = clampText(latest.text, PLAN_PREVIEW_LIMIT);
  const isClamped = preview !== latest.text;

  return (
    <Section label="Plan">
      <div className={`${styles.planLatest}${latest.streaming ? ` ${styles.planStreaming}` : ''}`}>
        <div className={`${styles.planText}${expandLatest ? ` ${styles.planTextExpanded}` : ''}`}>
          {expandLatest ? latest.text : preview}
        </div>
        {isClamped && (
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setExpandLatest((v) => !v)}
          >
            {expandLatest ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
      {earlier.length > 0 && (
        <>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowEarlier((v) => !v)}
          >
            {showEarlier ? 'Hide' : `+${earlier.length} earlier`}
          </button>
          {showEarlier && (
            <ul className={styles.planEarlierList}>
              {earlier.map((item) => (
                <li key={item.id} className={styles.planEarlierItem}>
                  {clampText(item.text, 140)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function ActionsSection({
  items,
  onOpenPreview,
}: {
  items: ActivityActionItem[];
  onOpenPreview?: (url: string) => void;
}) {
  return (
    <Section label="Actions">
      <ul className={styles.rowList}>
        {items.map((item) => (
          <ActionRow key={item.id} item={item} onOpenPreview={onOpenPreview} />
        ))}
      </ul>
    </Section>
  );
}

function ActionRow({
  item,
  onOpenPreview,
}: {
  item: ActivityActionItem;
  onOpenPreview?: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = item.diff.length > 0 || item.output.trim().length > 0;
  const meta =
    item.diff.length > 0
      ? <DiffStats additions={item.additions} removals={item.removals} />
      : <StatusMeta status={item.status} output={item.output} />;

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={`${styles.rowBtn}${hasDetail ? ` ${styles.rowBtnExpandable}` : ''}`}
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={hasDetail ? open : undefined}
      >
        <span className={`${styles.dot} ${statusToneClass(item.status)}`} aria-hidden />
        <span className={styles.rowLabel} title={item.label}>{item.label}</span>
        <span className={styles.rowMeta}>{meta}</span>
        {item.previewUrl && onOpenPreview && (
          <span
            role="button"
            tabIndex={0}
            className={styles.previewLink}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPreview(item.previewUrl!);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onOpenPreview(item.previewUrl!);
              }
            }}
            title={`Preview ${item.previewUrl}`}
          >
            preview
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className={styles.detail}>
          {item.diff.length > 0 ? <DiffView diff={item.diff} /> : <OutputView output={item.output} />}
        </div>
      )}
    </li>
  );
}

function FilesSection({ items }: { items: ActivityFileItem[] }) {
  return (
    <Section label="Files">
      <ul className={styles.rowList}>
        {items.map((item) => (
          <FileRow key={`${item.id}-${item.path}`} item={item} />
        ))}
      </ul>
    </Section>
  );
}

function FileRow({ item }: { item: ActivityFileItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail = item.diff.length > 0 || item.output.trim().length > 0;
  const meta =
    item.diff.length > 0
      ? <DiffStats additions={item.additions} removals={item.removals} />
      : <span className={styles.metaMuted}>{kindVerb(item.kind)}</span>;

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={`${styles.rowBtn}${hasDetail ? ` ${styles.rowBtnExpandable}` : ''}`}
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={hasDetail ? open : undefined}
      >
        <span
          className={`${styles.fileGlyph} ${styles[`fileGlyph${capitalize(item.kind)}`]}`}
          aria-hidden
        >
          {kindGlyph(item.kind)}
        </span>
        <span className={styles.rowLabel} title={item.path}>{item.path}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </button>
      {open && hasDetail && (
        <div className={styles.detail}>
          {item.diff.length > 0 ? <DiffView diff={item.diff} /> : <OutputView output={item.output} />}
        </div>
      )}
    </li>
  );
}

function ResultsSection({ items }: { items: ActivityResultItem[] }) {
  return (
    <Section label="Results">
      <ul className={styles.rowList}>
        {items.map((item) => (
          <ResultRow key={item.id} item={item} />
        ))}
      </ul>
    </Section>
  );
}

function ResultRow({ item }: { item: ActivityResultItem }) {
  const [open, setOpen] = useState(false);
  const firstLine = item.output.split('\n').find((line) => line.trim().length > 0) || 'Tool reported an error.';

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={`${styles.rowBtn} ${styles.rowBtnExpandable}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`${styles.dot} ${styles.dotError}`} aria-hidden />
        <span className={styles.rowLabel} title={item.label}>{item.label}</span>
        <span className={`${styles.rowMeta} ${styles.metaError}`}>{clampText(firstLine, 56)}</span>
      </button>
      {open && (
        <div className={styles.detail}>
          <OutputView output={item.output || firstLine} error />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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

function DiffStats({ additions, removals }: { additions: number; removals: number }) {
  return (
    <span className={styles.diffStats}>
      <span className={styles.diffAdd}>+{additions}</span>
      <span className={styles.diffSep}> / </span>
      <span className={styles.diffRemove}>-{removals}</span>
    </span>
  );
}

function StatusMeta({ status, output }: { status: 'running' | 'success' | 'error'; output: string }) {
  if (status === 'running') return <span className={styles.metaMuted}>Running</span>;
  if (status === 'error') return <span className={styles.metaError}>Error</span>;
  const lineCount = output.split('\n').filter((l) => l.trim().length > 0).length;
  if (lineCount > 1) return <span className={styles.metaMuted}>{lineCount} lines</span>;
  return <span className={styles.metaMuted}>Done</span>;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <div className={styles.diff}>
      {diff.split('\n').map((line, index) => {
        let cls = styles.diffContext;
        if (line.startsWith('+++') || line.startsWith('---')) cls = styles.diffFile;
        else if (line.startsWith('@@')) cls = styles.diffHunk;
        else if (line.startsWith('+')) cls = styles.diffAddLine;
        else if (line.startsWith('-')) cls = styles.diffRemoveLine;
        return (
          <div key={`${index}-${line.slice(0, 12)}`} className={`${styles.diffLine} ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function OutputView({ output, error = false }: { output: string; error?: boolean }) {
  const truncated = output.length > 4000 ? `${output.slice(0, 4000)}\n... (truncated)` : output;
  return (
    <pre className={`${styles.output}${error ? ` ${styles.outputError}` : ''}`}>
      {truncated || '(no output)'}
    </pre>
  );
}

function statusToneClass(status: 'running' | 'success' | 'error'): string {
  if (status === 'running') return styles.dotStreaming;
  if (status === 'error') return styles.dotError;
  return styles.dotDone;
}

function kindGlyph(kind: FileActionKind): string {
  switch (kind) {
    case 'read': return 'R';
    case 'write': return 'W';
    case 'edit': return 'E';
    case 'list': return 'L';
  }
}

function kindVerb(kind: FileActionKind): string {
  switch (kind) {
    case 'read': return 'read';
    case 'write': return 'wrote';
    case 'edit': return 'edited';
    case 'list': return 'listed';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clampText(text: string, max: number): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}
