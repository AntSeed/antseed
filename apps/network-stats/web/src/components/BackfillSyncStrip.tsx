import type { BackfillStatus } from '../api';

/**
 * Strip that appears at the top of a history-chart card while the one-shot
 * chain backfill is reconstructing historical data.
 *
 * Visibility rules:
 *   running           → always show (with progress %)
 *   failed            → show; sticky (the user should know it didn't finish)
 *   done              → show for ~30 s after finishedAt as a "just synced" pip,
 *                       then hide so the chart is uncluttered
 *   skipped/idle/null → hide (nothing to say)
 */
export function BackfillSyncStrip({
  backfill,
  now,
}: {
  backfill: BackfillStatus | null;
  now: number; // ms since epoch — passed in so the parent's tick re-renders us
}) {
  if (!backfill) return null;

  if (backfill.state === 'running') {
    const pct = backfill.totalBlocks > 0
      ? Math.min(100, Math.floor((backfill.scannedBlocks / backfill.totalBlocks) * 100))
      : 0;
    const phaseLabel = backfill.phase === 'resolving-timestamps'
      ? 'Resolving block timestamps…'
      : 'Reconstructing history from chain…';
    return (
      <div className="history-chart-sync history-chart-sync--running" role="status" aria-live="polite">
        <span className="history-chart-sync-spinner" aria-hidden />
        <span className="history-chart-sync-label">{phaseLabel}</span>
        <span className="history-chart-sync-meta">
          {backfill.scannedBlocks.toLocaleString()} / {backfill.totalBlocks.toLocaleString()} blocks · {pct}%
          {backfill.events > 0 ? ` · ${backfill.events} events` : ''}
        </span>
      </div>
    );
  }

  if (backfill.state === 'failed') {
    return (
      <div className="history-chart-sync history-chart-sync--failed" role="status">
        <span className="history-chart-sync-label">
          History backfill failed — chart is showing live data only.
        </span>
        {backfill.errorMessage && (
          <span className="history-chart-sync-meta" title={backfill.errorMessage}>
            {backfill.errorMessage.length > 80
              ? `${backfill.errorMessage.slice(0, 80)}…`
              : backfill.errorMessage}
          </span>
        )}
      </div>
    );
  }

  if (backfill.state === 'done' && backfill.finishedAt != null) {
    const ageMs = now - backfill.finishedAt * 1000;
    if (ageMs < 30_000) {
      return (
        <div className="history-chart-sync history-chart-sync--done" role="status">
          <span className="history-chart-sync-label">
            Reconstructed {backfill.rowsWritten} day{backfill.rowsWritten === 1 ? '' : 's'} of history
            from {backfill.events} on-chain event{backfill.events === 1 ? '' : 's'}.
          </span>
        </div>
      );
    }
  }

  return null;
}
