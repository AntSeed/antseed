import type { RoutingDecisionRow } from './ledger.js';

/**
 * Daily performance digest. Sent as its own request over the reserved-path
 * infrastructure, distinguished from a routing request by shape alone -- a
 * routing request always carries `inputMessage`, this never does. No `v`
 * field: digest versioning is left explicitly unresolved, so none is
 * invented here.
 */
export interface DailyDigestBody {
  period: string; // calendar day, YYYY-MM-DD
  routedRequests: number;
  predictedCostUsd: number;
  observedCostUsd: number;
  predictedInputTokens: number;
  predictedCachedInputTokens: number;
  predictedOutputTokens: number;
  observedInputTokens: number;
  observedCachedInputTokens: number;
  observedOutputTokens: number;
  modelMix: Record<string, number>;
  // failovers/timeouts: both need a signal nothing currently produces
  // (failover-walk counters) -- always 0 in this pass, not a fabricated
  // measurement, and never silently presented as real data.
  failovers: number;
  timeouts: number;
  avgRoutingLatencyMs: number | null;
  cqtDistribution: Record<number, number>;
}

export function periodKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Builds the daily digest from the local ledger's rows for one calendar day. */
export function buildDigest(rows: readonly RoutingDecisionRow[], period: string): DailyDigestBody {
  const dayRows = rows.filter((r) => periodKey(new Date(r.atMs)) === period);

  const modelMix: Record<string, number> = {};
  const cqtDistribution: Record<number, number> = {};
  let predictedCostUsd = 0;
  let observedCostUsd = 0;
  let predictedInputTokens = 0;
  let predictedCachedInputTokens = 0;
  let predictedOutputTokens = 0;
  let observedInputTokens = 0;
  let observedCachedInputTokens = 0;
  let observedOutputTokens = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const row of dayRows) {
    modelMix[row.actualModel] = (modelMix[row.actualModel] ?? 0) + 1;
    if (row.cqt != null) cqtDistribution[row.cqt] = (cqtDistribution[row.cqt] ?? 0) + 1;
    predictedCostUsd += row.predictedCostUsd ?? 0;
    observedCostUsd += row.actualUsdcPaid ?? 0;
    predictedInputTokens += row.predictedInputTokens ?? 0;
    predictedCachedInputTokens += row.predictedCachedInputTokens ?? 0;
    predictedOutputTokens += row.predictedOutputTokens ?? 0;
    // actualPromptTokens is fresh+cached combined (router.ts's onResult wiring) --
    // subtract cached to keep observedInputTokens "fresh" and parallel to predictedInputTokens.
    observedInputTokens += Math.max(0, row.actualPromptTokens - row.actualCachedTokens);
    observedCachedInputTokens += row.actualCachedTokens;
    observedOutputTokens += row.actualCompletionTokens;
    if (row.routingLatencyMs !== null) {
      latencySum += row.routingLatencyMs;
      latencyCount += 1;
    }
  }

  return {
    period,
    routedRequests: dayRows.length,
    predictedCostUsd,
    observedCostUsd,
    predictedInputTokens,
    predictedCachedInputTokens,
    predictedOutputTokens,
    observedInputTokens,
    observedCachedInputTokens,
    observedOutputTokens,
    modelMix,
    failovers: 0,
    timeouts: 0,
    avgRoutingLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    cqtDistribution,
  };
}
