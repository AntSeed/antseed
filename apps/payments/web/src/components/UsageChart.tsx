import { useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  type TooltipProps,
} from 'recharts';
import type { BuyerUsageChannelPoint } from '../api';
import './UsageChart.scss';

interface UsageChartProps {
  channels: BuyerUsageChannelPoint[];
}

interface BucketPoint {
  t: number;            // bucket start (unix ms)
  date: string;         // short label for axis
  fullDate: string;     // full label for tooltip
  requests: number;
  tokens: number;       // input + output
}

const DAY_MS = 86_400_000;

function bucketByDay(channels: BuyerUsageChannelPoint[]): BucketPoint[] {
  if (channels.length === 0) return [];

  // Drop channels that were reserved but never saw a request. They still
  // exist in the local DB as `ghost`/`timeout` rows but don't represent any
  // real activity, and including them would stretch the X axis back to
  // whenever the empty channel was opened.
  const active = channels.filter((c) => c.requestCount > 0);
  if (active.length === 0) return [];

  // Timestamps are produced by Date.now() on the buyer side, so they are
  // already in milliseconds. Bucket to UTC day start.
  const map = new Map<number, BucketPoint>();
  let minT = Infinity;
  let maxT = -Infinity;

  for (const c of active) {
    const stamp = c.updatedAt || c.reservedAt;
    if (!Number.isFinite(stamp) || stamp <= 0) continue;
    const t = Math.floor(stamp / DAY_MS) * DAY_MS;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    let tokens = 0;
    try {
      tokens = Number(BigInt(c.inputTokens || '0') + BigInt(c.outputTokens || '0'));
    } catch { /* skip */ }
    const existing = map.get(t);
    if (existing) {
      existing.requests += c.requestCount;
      existing.tokens += tokens;
    } else {
      map.set(t, {
        t,
        date: formatShortDate(t),
        fullDate: formatFullDate(t),
        requests: c.requestCount,
        tokens,
      });
    }
  }

  if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return [];

  // Fill empty days between min and max so the X axis reads as continuous
  // time instead of "days that happened to have activity".
  const points: BucketPoint[] = [];
  for (let t = minT; t <= maxT; t += DAY_MS) {
    points.push(
      map.get(t) ?? {
        t,
        date: formatShortDate(t),
        fullDate: formatFullDate(t),
        requests: 0,
        tokens: 0,
      },
    );
  }
  return points;
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload as BucketPoint | undefined;
  if (!p) return null;
  return (
    <div className="usage-chart-tooltip">
      <div className="usage-chart-tooltip-date">{p.fullDate}</div>
      <div className="usage-chart-tooltip-rows">
        <div className="usage-chart-tooltip-row">
          <span className="usage-chart-tooltip-label">Requests</span>
          <span className="usage-chart-tooltip-value">{p.requests.toLocaleString('en-US')}</span>
        </div>
        <div className="usage-chart-tooltip-row">
          <span className="usage-chart-tooltip-label">Tokens</span>
          <span className="usage-chart-tooltip-value">{formatCompact(p.tokens)}</span>
        </div>
      </div>
    </div>
  );
}

export function UsageChart({ channels }: UsageChartProps) {
  const buckets = useMemo(() => bucketByDay(channels), [channels]);

  if (buckets.length === 0) {
    return (
      <div className="usage-chart usage-chart--empty">
        <div className="usage-chart-empty-text">
          No usage yet — start sending requests to see your activity here.
        </div>
      </div>
    );
  }

  return (
    <div className="usage-chart">
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={buckets} margin={{ top: 12, right: 8, left: 8, bottom: 4 }}>
          <defs>
            <linearGradient id="usage-chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.42} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--card-border)"
            strokeDasharray="2 5"
            vertical={false}
            opacity={0.5}
          />
          <XAxis
            dataKey="date"
            stroke="var(--text-muted)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            stroke="var(--text-muted)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(v: number) => formatCompact(v)}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: 'var(--accent)', strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey="requests"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#usage-chart-fill)"
            activeDot={{ r: 4, fill: 'var(--accent)', stroke: 'var(--page-bg)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
