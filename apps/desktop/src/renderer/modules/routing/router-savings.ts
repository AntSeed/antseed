/**
 * "Router savings" is scoped to requests the routing-client actually decided
 * (the `routing_decisions` ledger), not the aggregate buyer usage
 * `computeMeasuredSavings` already covers -- so this line answers "how much
 * did Auto-routing save you," distinct from "AntSeed savings" (which every
 * AntSeed user gets regardless of routing).
 *
 * Compares actual paid vs. one fixed reference model's real AntSeed price
 * *at the time of each decision* (`RoutingDecisionRow.baselinePrices`) --
 * not an approximation against today's retail price for each row's own
 * actual model.
 */
import type { RoutingDecisionRow } from '@antseed/node';
import type { MeasuredSavings } from '../catalog/measured-savings.js';
import { activeAutoRouterSavingsBaselineModel } from './auto-router.js';

/**
 * Default reference model for the savings-page dropdown -- "the most
 * expensive, most capable flagship... the top GPT or Claude model." No
 * dropdown UI exists yet to let a buyer pick a different one, so callers get
 * this default unless/until that UI exists to pass a different
 * `baselineModel` through. Sourced from the active router plugin's own
 * declared `savingsBaselineModel` (packages/node's AntseedRouterPlugin) when
 * one is active, falling back to a plugin-agnostic generic default
 * otherwise -- see `activeAutoRouterSavingsBaselineModel`.
 */
export function defaultRouterSavingsBaselineModel(): string {
  return activeAutoRouterSavingsBaselineModel();
}

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `computeRouterSavings` over just the rows within `windowMs` of `nowMs` --
 * the Profile view's "saved $X in the past 7 days" pill. `nowMs` is a
 * parameter rather than an internal `Date.now()` call so this stays a pure,
 * directly-testable function.
 */
export function computeRecentRouterSavings(
  rows: readonly RoutingDecisionRow[] | null | undefined,
  windowMs: number,
  nowMs: number,
  baselineModel: string = defaultRouterSavingsBaselineModel(),
): MeasuredSavings | null {
  if (!rows) return null;
  const cutoff = nowMs - windowMs;
  return computeRouterSavings(rows.filter((row) => row.atMs >= cutoff), baselineModel);
}

export function computeRouterSavings(
  rows: readonly RoutingDecisionRow[] | undefined,
  baselineModel: string = defaultRouterSavingsBaselineModel(),
): MeasuredSavings | null {
  if (!rows || rows.length === 0) return null;

  let actualUsd = 0;
  let baselineUsd = 0;
  const seenModels = new Set<string>();

  for (const row of rows) {
    if (!row.actualModel) continue;
    if (row.actualUsdcPaid == null || !Number.isFinite(row.actualUsdcPaid) || row.actualUsdcPaid < 0) continue;
    const baseline = row.baselinePrices?.[baselineModel];
    // Absent, not zero -- the baseline model wasn't offered as a ranked
    // candidate at the moment of this specific decision, so there is no
    // real AntSeed price to compare against for this row.
    if (!baseline) continue;
    if ([baseline.inUsdPerM, baseline.outUsdPerM, baseline.cachedInUsdPerM ?? baseline.inUsdPerM,
      row.actualPromptTokens, row.actualCachedTokens, row.actualCompletionTokens].some((value) => !Number.isFinite(value) || value < 0)
      || row.actualCachedTokens > row.actualPromptTokens) continue;

    const freshInput = Math.max(0, row.actualPromptTokens - row.actualCachedTokens);
    const cached = row.actualCachedTokens;
    const output = row.actualCompletionTokens;
    if (freshInput === 0 && cached === 0 && output === 0) continue;

    const cachedPrice = baseline.cachedInUsdPerM ?? baseline.inUsdPerM;
    const rowBaseline = (freshInput * baseline.inUsdPerM + cached * cachedPrice + output * baseline.outUsdPerM) / 1_000_000;
    if (rowBaseline <= 0) continue;

    baselineUsd += rowBaseline;
    actualUsd += row.actualUsdcPaid;
    seenModels.add(row.actualModel);
  }

  const matchedServices = seenModels.size;
  if (matchedServices === 0 || baselineUsd <= 0) return null;
  const pct = Math.round(Math.max(0, Math.min(1, 1 - actualUsd / baselineUsd)) * 100);
  return { pct, actualUsd, baselineUsd, matchedServices };
}
