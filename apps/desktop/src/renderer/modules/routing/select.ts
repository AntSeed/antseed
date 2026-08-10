import type { DiscoverRow, VprRoutingPreferences } from '../../core/state';
import { totalRowPrice } from '../catalog/model-catalog.js';

export type VprScoredRoute = {
  row: DiscoverRow;
  score: number;
  reasons: string[];
};

// An unknown price must not score as free: the UI renders these routes as
// "Price unknown", and treating them as $0 would let them beat cheap priced
// routes and dodge the max-input-price preference entirely.
const UNKNOWN_PRICE_PENALTY = 10;

function hasKnownPrice(row: DiscoverRow): boolean {
  return totalRowPrice(row) !== null;
}

function comparableTotalPrice(row: DiscoverRow): number {
  return totalRowPrice(row) ?? Number.POSITIVE_INFINITY;
}

function compareScoredRoutes(a: VprScoredRoute, b: VprScoredRoute): number {
  const aKnown = hasKnownPrice(a.row);
  const bKnown = hasKnownPrice(b.row);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return b.score - a.score
    || comparableTotalPrice(a.row) - comparableTotalPrice(b.row)
    || a.row.peerId.localeCompare(b.row.peerId);
}

export function scoreVprRoute(row: DiscoverRow, preferences: VprRoutingPreferences): VprScoredRoute {
  const reasons: string[] = [];
  let score = 100;

  if (preferences.preferFreePeers && row.inputUsdPerMillion === 0 && row.outputUsdPerMillion === 0) {
    score += 25;
    reasons.push('free peer preferred');
  }

  if (row.inputUsdPerMillion !== null && row.inputUsdPerMillion > preferences.maxInputUsdPerMillion) {
    score -= 50;
    reasons.push('input price exceeds maximum');
  }

  if (row.onChainTrustScore !== null && row.onChainTrustScore < preferences.minTrustScore) {
    score -= 50;
    reasons.push('trust score below minimum');
  }

  const trustScore = row.onChainTrustScore ?? row.onChainReputationScore ?? 0;
  score += Math.min(trustScore, 100) / 5;

  const total = totalRowPrice(row);
  if (total === null) {
    score -= UNKNOWN_PRICE_PENALTY;
    reasons.push('price unknown');
  } else {
    score -= total;
  }

  return { row, score, reasons };
}

/**
 * Whether auto routing may select this peer.
 *
 * The blocklist is absolute. The allowlist is exclusive while it holds any
 * entry — an empty allowlist means "no restriction", not "nothing allowed".
 */
export function isPeerRoutable(peerId: string, preferences: VprRoutingPreferences): boolean {
  if (preferences.blockedPeerIds.includes(peerId)) return false;
  return preferences.allowedPeerIds.length === 0 || preferences.allowedPeerIds.includes(peerId);
}

/** Drop every route whose peer the allow/block lists rule out. */
export function filterRoutableVprRoutes(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): DiscoverRow[] {
  return rows.filter((row) => isPeerRoutable(row.peerId, preferences));
}

export function chooseBestVprRoute(rows: DiscoverRow[], preferences: VprRoutingPreferences): DiscoverRow | null {
  const best = filterRoutableVprRoutes(rows, preferences)
    .map((row) => scoreVprRoute(row, preferences))
    .sort(compareScoredRoutes)[0];

  return best?.row ?? null;
}
