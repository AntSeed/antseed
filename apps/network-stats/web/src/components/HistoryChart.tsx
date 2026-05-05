import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchPeersHistory, type BackfillStatus, type HistoryRange } from '../api';
import { formatTick, formatTooltipLabel, HistoryChartFrame } from './HistoryChartFrame';

export function HistoryChart({
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
      ariaLabel="History range"
      backfill={backfill}
      now={now}
      fetcher={fetchPeersHistory}
      queryKey="history/peers"
      renderChart={(points, bucketSeconds) => {
        const requestsLabel = bucketSeconds < 86_400 ? 'Requests / hour' : 'Requests / day';
        return (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
                yAxisId="peers"
                orientation="left"
                stroke="var(--text-muted)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--divider)' }}
                width={36}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="rate"
                orientation="right"
                stroke="var(--text-muted)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--divider)' }}
                width={36}
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
                formatter={(value, name) => [
                  typeof value === 'number' ? value.toLocaleString() : String(value),
                  name,
                ]}
              />
              <Line
                yAxisId="peers"
                type="monotone"
                dataKey="activePeers"
                name="Active peers"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="rate"
                type="monotone"
                dataKey="requests"
                name={requestsLabel}
                stroke="var(--text-secondary)"
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        );
      }}
      renderLegend={(bucketSeconds) => (
        <>
          <span className="history-chart-legend-item">
            <span className="history-chart-legend-swatch history-chart-legend-swatch--peers" />
            Active peers
          </span>
          <span className="history-chart-legend-item">
            <span className="history-chart-legend-swatch history-chart-legend-swatch--rate" />
            {bucketSeconds < 86_400 ? 'Requests / hour' : 'Requests / day'}
          </span>
        </>
      )}
    />
  );
}
