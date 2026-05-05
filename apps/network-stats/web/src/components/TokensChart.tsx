import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchTokensHistory, type BackfillStatus, type HistoryRange } from '../api';
import { formatLargeNumber } from '../utils';
import { formatTick, formatTooltipLabel, HistoryChartFrame } from './HistoryChartFrame';

export function TokensChart({
  range,
  onRangeChange,
  backfill = null,
  now = Date.now(),
}: {
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
  backfill?: BackfillStatus | null;
  now?: number;
}) {
  return (
    <HistoryChartFrame
      range={range}
      onRangeChange={onRangeChange}
      ariaLabel="Tokens range"
      backfill={backfill}
      now={now}
      fetcher={fetchTokensHistory}
      queryKey="history/tokens"
      renderChart={(points, bucketSeconds) => {
        const seriesLabel = bucketSeconds < 86_400 ? 'Tokens / hour' : 'Tokens / day';
        return (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="tokens-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--divider)" vertical={false} />
              <XAxis
                dataKey="ts"
                tickFormatter={(ts) => formatTick(ts as number, bucketSeconds)}
                stroke="var(--text-muted)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--divider)' }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(v) => formatLargeNumber(v as number)}
                stroke="var(--text-muted)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--divider)' }}
                width={56}
                allowDecimals={false}
              />
              <Tooltip
                labelFormatter={(ts) => formatTooltipLabel(ts as number, bucketSeconds)}
                contentStyle={{
                  background: 'var(--box-bg)',
                  border: '1px solid var(--box-border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--text-primary)',
                }}
                labelStyle={{ color: 'var(--text-secondary)', marginBottom: 4 }}
                formatter={(value) => [
                  typeof value === 'number' ? formatLargeNumber(value) : String(value),
                  seriesLabel,
                ]}
              />
              <Area
                type="monotone"
                dataKey="tokens"
                name={seriesLabel}
                stroke="var(--accent)"
                strokeWidth={2}
                fill="url(#tokens-fill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        );
      }}
      renderLegend={(bucketSeconds) => (
        <span className="history-chart-legend-item">
          <span className="history-chart-legend-swatch history-chart-legend-swatch--peers" />
          {bucketSeconds < 86_400 ? 'Tokens / hour' : 'Tokens / day'}
        </span>
      )}
    />
  );
}
