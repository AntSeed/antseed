import type { DiscoverRow, VprRoutingPreferences } from '../../core/state';
import {
  chooseBestModelRoute,
  isModelRouteCoolingDown,
  isModelRouteEligible,
  isModelRoutePeerAllowed,
  modelRouteTotalPrice,
  scoreModelRoute,
} from '@antseed/node/model-routing';

export type VprScoredRoute = {
  row: DiscoverRow;
  score: number;
  reasons: string[];
};

export function isRowCoolingDown(row: DiscoverRow, now: number = Date.now()): boolean {
  return isModelRouteCoolingDown(row, now);
}

export function scoreVprRoute(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
): VprScoredRoute {
  const scored = scoreModelRoute(row, preferences, now);
  return { row, score: scored.score, reasons: scored.reasons };
}

/**
 * Whether auto routing may select this peer.
 *
 * The blocklist is absolute. The allowlist is exclusive while it holds any
 * entry — an empty allowlist means "no restriction", not "nothing allowed".
 *
 * Deliberately knows nothing about cooldowns: those are a scoring penalty, not
 * a filter, so that a network where every peer is cooling down still routes.
 */
export function isPeerRoutable(peerId: string, preferences: VprRoutingPreferences): boolean {
  return isModelRoutePeerAllowed(peerId, preferences);
}

export function isRouteEligibleForAutoSelection(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
): boolean {
  return isModelRouteEligible(row, preferences);
}

/** Drop every route whose peer the allow/block lists rule out. */
export function filterRoutableVprRoutes(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): DiscoverRow[] {
  return rows.filter((row) => isPeerRoutable(row.peerId, preferences));
}

/** Whether auto-selection can use a free route from this set. */
export function hasEligibleFreeVprRoute(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): boolean {
  return rows.some(
    (row) => modelRouteTotalPrice(row) === 0 && isModelRouteEligible(row, preferences),
  );
}

export function chooseBestVprRoute(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
): DiscoverRow | null {
  return chooseBestModelRoute(rows, preferences, now);
}
