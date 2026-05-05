import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchHistory,
  type BackfillStatus,
  type HistoryPoint,
  type HistoryRange,
} from '../api';
import { BackfillSyncStrip } from './BackfillSyncStrip';

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: '1d', label: '1d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/**
 * Hourly buckets show HH:mm; daily buckets show MMM-dd. Same component handles
 * both because the bucket size travels with the response.
 */
export function formatTick(tsSec: number, bucketSeconds: number): string {
  const d = new Date(tsSec * 1000);
  if (bucketSeconds < 86_400) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTooltipLabel(tsSec: number, bucketSeconds: number): string {
  const d = new Date(tsSec * 1000);
  return bucketSeconds < 86_400
    ? d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Shared chrome for the history charts: range tabs, query state, sync strip,
 * empty/loading/error states. The chart body itself is a render prop so each
 * caller can provide its own Recharts composition.
 *
 * Range state is lifted to the parent so multiple frames on the same page
 * stay in sync. react-query dedupes identical ['history', range] keys, so
 * two frames with the same range share a single fetch.
 */
export function HistoryChartFrame({
  range,
  onRangeChange,
  ariaLabel,
  backfill = null,
  now = Date.now(),
  renderChart,
  renderLegend,
}: {
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
  ariaLabel: string;
  backfill?: BackfillStatus | null;
  now?: number;
  renderChart: (points: HistoryPoint[], bucketSeconds: number) => ReactNode;
  renderLegend: (bucketSeconds: number) => ReactNode;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['history', range],
    queryFn: () => fetchHistory(range),
    // Server appends a sample once per minute; match that cadence.
    refetchInterval: 60_000,
  });

  const points = data?.points ?? [];
  const bucketSeconds = data?.bucketSeconds ?? 3600;

  return (
    <div className="history-chart">
      <div className="history-chart-header">
        <div className="history-chart-controls" role="tablist" aria-label={ariaLabel}>
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="tab"
              aria-selected={range === r.value}
              className={`history-chart-tab${range === r.value ? ' is-active' : ''}`}
              onClick={() => onRangeChange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <BackfillSyncStrip backfill={backfill} now={now} />
      {isLoading && <div className="history-chart-empty">Loading history…</div>}
      {error && (
        <div className="history-chart-empty history-chart-empty--error">
          Error: {(error as Error).message}
        </div>
      )}
      {!isLoading && !error && points.length === 0 && (
        <div className="history-chart-empty">
          No samples yet — server records one every minute. The chart will populate shortly.
        </div>
      )}
      {points.length > 0 && (
        <div className="history-chart-canvas">
          {renderChart(points, bucketSeconds)}
          <div className="history-chart-legend">{renderLegend(bucketSeconds)}</div>
        </div>
      )}
    </div>
  );
}
