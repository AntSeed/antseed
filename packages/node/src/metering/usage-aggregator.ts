import type { UsageAggregate, SessionMetrics, ProviderType } from '../types/metering.js';

export type AggregationGranularity = 'daily' | 'weekly' | 'monthly';

/**
 * Time period boundaries for aggregation.
 */
export interface TimePeriod {
  start: number; // ms since epoch
  end: number;   // ms since epoch
}

/**
 * Aggregates session metrics into time-period summaries.
 */
export class UsageAggregator {
  /**
   * Aggregate a list of session metrics into time-period buckets.
   *
   * @param sessions - Session metrics to aggregate
   * @param granularity - Time period granularity
   * @param topPeerCount - Number of top peers to include (default: 5)
   * @returns Array of UsageAggregate, one per period that has data
   */
  aggregate(
    sessions: SessionMetrics[],
    granularity: AggregationGranularity,
    topPeerCount: number = 5
  ): UsageAggregate[] {
    if (sessions.length === 0) return [];

    // Group sessions by period
    const buckets = new Map<string, SessionMetrics[]>();

    for (const session of sessions) {
      const period = this.getPeriod(session.startedAt, granularity);
      const key = `${period.start}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(session);
      } else {
        buckets.set(key, [session]);
      }
    }

    // Build aggregates
    const aggregates: UsageAggregate[] = [];

    for (const [_key, bucketSessions] of buckets) {
      const period = this.getPeriod(bucketSessions[0]!.startedAt, granularity);
      aggregates.push(this.buildAggregate(bucketSessions, period, granularity, topPeerCount));
    }

    // Sort by period start
    aggregates.sort((a, b) => a.periodStart - b.periodStart);

    return aggregates;
  }

  /**
   * Get the time period that a timestamp falls into.
   */
  getPeriod(timestamp: number, granularity: AggregationGranularity): TimePeriod {
    const date = new Date(timestamp);

    switch (granularity) {
      case 'daily': {
        const start = new Date(Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate()
        ));
        const end = new Date(Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate() + 1
        ));
        return { start: start.getTime(), end: end.getTime() };
      }
      case 'weekly': {
        // Monday 00:00 UTC to next Monday 00:00 UTC
        const dayOfWeek = date.getUTCDay();
        // getUTCDay() returns 0 for Sunday, 1 for Monday, etc.
        // We want Monday as the start, so offset: Monday=0, Tue=1, ..., Sun=6
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const monday = new Date(Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate() - daysFromMonday
        ));
        const nextMonday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
        return { start: monday.getTime(), end: nextMonday.getTime() };
      }
      case 'monthly': {
        const start = new Date(Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          1
        ));
        const end = new Date(Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          1
        ));
        return { start: start.getTime(), end: end.getTime() };
      }
    }
  }

  /**
   * Get aggregates for a specific date range.
   *
   * @param sessions - All available session metrics
   * @param startDate - Start of range (ms since epoch)
   * @param endDate - End of range (ms since epoch)
   * @param granularity - Bucket granularity
   * @param topPeerCount - Number of top peers to include (default: 5)
   */
  aggregateRange(
    sessions: SessionMetrics[],
    startDate: number,
    endDate: number,
    granularity: AggregationGranularity,
    topPeerCount: number = 5
  ): UsageAggregate[] {
    const filtered = sessions.filter(
      (s) => s.startedAt >= startDate && s.startedAt < endDate
    );
    return this.aggregate(filtered, granularity, topPeerCount);
  }

  /**
   * Get a single aggregate for all-time usage.
   */
  aggregateAll(sessions: SessionMetrics[]): UsageAggregate {
    if (sessions.length === 0) {
      return {
        periodStart: 0,
        periodEnd: 0,
        granularity: 'monthly',
        totalSessions: 0,
        totalRequests: 0,
        totalTokens: 0,
        totalCostCents: 0,
        byProvider: {},
        topPeers: [],
      };
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;

    for (const s of sessions) {
      if (s.startedAt < minStart) minStart = s.startedAt;
      const end = s.endedAt ?? s.startedAt;
      if (end > maxEnd) maxEnd = end;
    }

    return this.buildAggregate(
      sessions,
      { start: minStart, end: maxEnd },
      'monthly',
      sessions.length // Include all peers in all-time view
    );
  }

  /**
   * Build a single UsageAggregate from a list of sessions.
   */
  private buildAggregate(
    sessions: SessionMetrics[],
    period: TimePeriod,
    granularity: AggregationGranularity,
    topPeerCount: number
  ): UsageAggregate {
    const byProvider: Record<ProviderType, { requests: number; tokens: number; costCents: number }> = {};
    const peerMap = new Map<string, { requests: number; tokens: number; costCents: number }>();

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostCents = 0;

    for (const session of sessions) {
      totalRequests += session.totalRequests;
      totalTokens += session.totalTokens;
      totalCostCents += session.totalCostCents;

      // Provider breakdown
      const providerEntry = byProvider[session.provider];
      if (providerEntry) {
        providerEntry.requests += session.totalRequests;
        providerEntry.tokens += session.totalTokens;
        providerEntry.costCents += session.totalCostCents;
      } else {
        byProvider[session.provider] = {
          requests: session.totalRequests,
          tokens: session.totalTokens,
          costCents: session.totalCostCents,
        };
      }

      // Peer breakdown (use sellerPeerId as the peer identifier)
      const peerId = session.sellerPeerId;
      const peerEntry = peerMap.get(peerId);
      if (peerEntry) {
        peerEntry.requests += session.totalRequests;
        peerEntry.tokens += session.totalTokens;
        peerEntry.costCents += session.totalCostCents;
      } else {
        peerMap.set(peerId, {
          requests: session.totalRequests,
          tokens: session.totalTokens,
          costCents: session.totalCostCents,
        });
      }
    }

    // Sort peers by costCents descending, take top N
    const topPeers = Array.from(peerMap.entries())
      .map(([peerId, data]) => ({ peerId, ...data }))
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, topPeerCount);

    return {
      periodStart: period.start,
      periodEnd: period.end,
      granularity,
      totalSessions: sessions.length,
      totalRequests,
      totalTokens,
      totalCostCents,
      byProvider,
      topPeers,
    };
  }
}
