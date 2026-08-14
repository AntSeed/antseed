import type { DiscoverRow, VprRoutingPreferences } from '../../core/state';
import { scoreFromTrust } from '@antseed/node';
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

// A peer the buyer proxy has put in cooldown recently stopped responding.
// Deprioritized, never excluded: the penalty must lose to any healthy peer, but
// when every peer is cooling down they all take it equally and the best of a bad
// set still wins — which is why routing can never deadlock.
const COOLING_DOWN_PENALTY = 1000;
// Failures that have not yet reached the cooldown threshold still break ties
// against an otherwise equivalent healthy peer.
const FAILURE_STREAK_PENALTY = 3;

/** Sanity bound mirroring the proxy's cooldown ceiling. */
const MAX_COOLDOWN_MS = 8 * 60_000;

export function isRowCoolingDown(row: DiscoverRow, now: number = Date.now()): boolean {
  const until = row.peerCooldownUntil;
  if (until === null || until <= now) return false;
  // A corrupt or clock-skewed future value must not strand a peer forever.
  return until - now <= MAX_COOLDOWN_MS;
}

function hasKnownPrice(row: DiscoverRow): boolean {
  return totalRowPrice(row) !== null;
}

function comparableTotalPrice(row: DiscoverRow): number {
  return totalRowPrice(row) ?? Number.POSITIVE_INFINITY;
}

/** Model-specific reputation with on-chain fallbacks; null when unscored. */
function modelReputationScore(row: DiscoverRow): number | null {
  return row.effectiveReputationScore
    ?? row.onChainReputationScore
    ?? (row.onChainTrustScore === null ? null : scoreFromTrust(row.onChainTrustScore));
}

function compareScoredRoutes(a: VprScoredRoute, b: VprScoredRoute, now: number): number {
  // Health outranks price certainty. Without this tier a cooling-down priced
  // route would still beat a healthy unknown-price one, because the
  // known-price check below is evaluated before `score` — no penalty, however
  // large, could overcome it.
  const aCooling = isRowCoolingDown(a.row, now);
  const bCooling = isRowCoolingDown(b.row, now);
  if (aCooling !== bCooling) return aCooling ? 1 : -1;

  const aKnown = hasKnownPrice(a.row);
  const bKnown = hasKnownPrice(b.row);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return b.score - a.score
    || comparableTotalPrice(a.row) - comparableTotalPrice(b.row)
    || a.row.peerId.localeCompare(b.row.peerId);
}

export function scoreVprRoute(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
): VprScoredRoute {
  const reasons: string[] = [];
  let score = 100;

  if (isRowCoolingDown(row, now)) {
    score -= COOLING_DOWN_PENALTY;
    reasons.push('peer cooling down');
  } else if (row.peerFailureStreak > 0) {
    score -= FAILURE_STREAK_PENALTY * row.peerFailureStreak;
    reasons.push('recent peer failures');
  }

  if (preferences.preferFreePeers && row.inputUsdPerMillion === 0 && row.outputUsdPerMillion === 0) {
    score += 25;
    reasons.push('free peer preferred');
  }

  if (row.inputUsdPerMillion !== null && row.inputUsdPerMillion > preferences.maxInputUsdPerMillion) {
    score -= 50;
    reasons.push('input price exceeds maximum');
  }

  const modelReputation = modelReputationScore(row);
  if (modelReputation !== null && modelReputation < preferences.minTrustScore) {
    score -= 50;
    reasons.push('trust score below minimum');
  }

  score += Math.min(modelReputation ?? 0, 100) / 5;

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
 *
 * Deliberately knows nothing about cooldowns: those are a scoring penalty, not
 * a filter, so that a network where every peer is cooling down still routes.
 */
export function isPeerRoutable(peerId: string, preferences: VprRoutingPreferences): boolean {
  if (preferences.blockedPeerIds.includes(peerId)) return false;
  return preferences.allowedPeerIds.length === 0 || preferences.allowedPeerIds.includes(peerId);
}

export function isRouteEligibleForAutoSelection(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
): boolean {
  if (!isPeerRoutable(row.peerId, preferences)) return false;
  if (preferences.minTrustScore <= 0) return true;
  const reputation = modelReputationScore(row);
  return reputation !== null && reputation >= preferences.minTrustScore;
}

/** Drop every route whose peer the allow/block lists rule out. */
export function filterRoutableVprRoutes(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): DiscoverRow[] {
  return rows.filter((row) => isPeerRoutable(row.peerId, preferences));
}

export function chooseBestVprRoute(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
): DiscoverRow | null {
  const best = rows
    .filter((row) => isRouteEligibleForAutoSelection(row, preferences))
    .map((row) => scoreVprRoute(row, preferences, now))
    .sort((a, b) => compareScoredRoutes(a, b, now))[0];

  return best?.row ?? null;
}
