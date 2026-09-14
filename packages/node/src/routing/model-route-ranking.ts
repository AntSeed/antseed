import { normalizedModelReputationScore } from '../reputation/model-reputation.js';

export type ModelRoutingPreferences = {
  preferFreePeers: boolean;
  maxInputUsdPerMillion: number;
  minTrustScore: number;
  allowedPeerIds: string[];
  blockedPeerIds: string[];
  /**
   * Cost/quality tradeoff dial -- one of the five discrete values
   * {1, 3, 5, 7, 9} on Sage's underlying 0-10 scale; 5 is "Balanced." Only
   * meaningful to a router that implements selectRoute -- optional so
   * existing routers (e.g. router-local) that don't read it are unaffected.
   */
  cqt?: number;
  /**
   * Explicit opt-in to Auto model-routing's daily flat-fee day pass -- off
   * by default. A router that gates real signing on this (e.g. a router
   * plugin's own `signDayPassOnDemand`) must treat "unknown"
   * (preferences not yet supplied) the same as `false`, never as implicit
   * consent. Optional so existing routers that don't read it are
   * unaffected.
   */
  dayPassOnDemandEnabled?: boolean;
  routerEnabled?: boolean;
  /**
   * npm package name of the router plugin `dayPassOnDemandEnabled` applies
   * to (e.g. '@antseed/router-acme'), chosen from whichever router-type
   * plugins are actually installed. Optional/nullable so a preferences
   * object from before this field existed, or a host with exactly one
   * router plugin, still behaves the same as it always did.
   */
  selectedRouterPackage?: string | null;
  /**
   * The buyer's standing "Auto select seller" switch -- distinct from, and
   * checked ALONGSIDE, dayPassOnDemandEnabled. Found live: a buyer trying
   * to stop real-money day-pass billing reasonably reached for this
   * toggle (labeled "Off pauses routing everywhere" in the UI) instead of
   * the separate "Select model router" control that actually owns
   * dayPassOnDemandEnabled -- and billing kept running, because nothing
   * gated on this flag. A router that bills on dayPassOnDemandEnabled
   * (e.g. a router plugin's own `signDayPassOnDemand`) should treat an explicit
   * `false` here as an additional stop condition, same as
   * dayPassOnDemandEnabled itself: `undefined` (an older caller that
   * doesn't send this field) must NOT be treated as consent to keep
   * billing, but must also not newly block a host that never intended to
   * gate on it -- so callers default it to `true` (routing enabled) when
   * absent, not to `false`. Optional so existing routers/callers that
   * don't need it are unaffected.
   */
  autoRouting?: boolean;
  /**
   * Day-pass daily prices (whole USD, e.g. 0.89) this buyer has actually
   * agreed to, keyed by the routing-peer's own seller peer id (lowercase
   * hex, no `0x`) rather than by router package -- the seller relationship
   * a day-pass charge is actually against, and already the key every
   * day-pass function (`signDailyIfNeeded`, `resolveDiscoveredPriceUsdc`,
   * `configureFlatFeeSigning`) takes. Keying by seller peer id rather than
   * package means switching to a different router plugin naturally starts
   * with no agreement on file for that plugin's (different) seller, with no
   * separate reset step needed.
   *
   * Set once per seller: either the first time a day-pass signature is ever
   * produced for it (implicit agreement to whatever price was live at that
   * moment) or explicitly when a buyer re-confirms after a price increase.
   * Day-pass signing must never sign above the stored value for a seller
   * once one exists; a live/shipped price above it is capped, not paid.
   * Missing entry means no agreement exists yet for that seller. Optional
   * so existing preferences objects from before this field existed are
   * unaffected.
   */
  agreedDayPassPricesUsdc?: Record<string, number>;
};

export const DEFAULT_MODEL_ROUTING_PREFERENCES: ModelRoutingPreferences = {
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
  cqt: 5,
  dayPassOnDemandEnabled: false,
  selectedRouterPackage: null,
  agreedDayPassPricesUsdc: {},
};

export type ModelRouteCandidate = {
  peerId: string;
  effectiveReputationScore?: number | null;
  onChainReputationScore?: number | null;
  onChainTrustScore?: number | null;
  reputationScore?: number | null;
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
  minImageUsdPerImage?: number | null;
  peerCooldownUntil?: number | null;
  peerFailureStreak?: number | null;
};

export type ScoredModelRoute<T extends ModelRouteCandidate> = {
  route: T;
  score: number;
  reasons: string[];
};

const UNKNOWN_PRICE_PENALTY = 10;
const COOLING_DOWN_PENALTY = 1000;
const FAILURE_STREAK_PENALTY = 3;
const MAX_COOLDOWN_MS = 8 * 60_000;

function normalizedPeerId(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, '');
}

function peerIdSet(values: string[]): Set<string> {
  return new Set(values.map(normalizedPeerId).filter((value) => value.length > 0));
}

export function modelRouteReputationScore(route: ModelRouteCandidate): number | null {
  const effective = route.effectiveReputationScore;
  if (typeof effective === 'number' && Number.isFinite(effective)) return effective;
  return normalizedModelReputationScore(route);
}

export function modelRouteTotalPrice(route: ModelRouteCandidate): number | null {
  const imagePrice = route.minImageUsdPerImage;
  if (typeof imagePrice === 'number' && Number.isFinite(imagePrice) && imagePrice >= 0) {
    return imagePrice;
  }
  const input = route.inputUsdPerMillion;
  const output = route.outputUsdPerMillion;
  if (
    typeof input !== 'number'
    || !Number.isFinite(input)
    || input < 0
    || typeof output !== 'number'
    || !Number.isFinite(output)
    || output < 0
  ) {
    return null;
  }
  return input + output;
}

export function isModelRouteCoolingDown(
  route: ModelRouteCandidate,
  now: number = Date.now(),
): boolean {
  const until = route.peerCooldownUntil;
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) return false;
  return until - now <= MAX_COOLDOWN_MS;
}

export function isModelRoutePeerAllowed(
  peerId: string,
  preferences: ModelRoutingPreferences,
): boolean {
  const normalized = normalizedPeerId(peerId);
  const blocked = peerIdSet(preferences.blockedPeerIds);
  if (blocked.has(normalized)) return false;
  const allowed = peerIdSet(preferences.allowedPeerIds);
  return allowed.size === 0 || allowed.has(normalized);
}

export function isModelRouteEligible(
  route: ModelRouteCandidate,
  preferences: ModelRoutingPreferences,
): boolean {
  if (!isModelRoutePeerAllowed(route.peerId, preferences)) return false;
  if (preferences.minTrustScore <= 0) return true;
  const reputation = modelRouteReputationScore(route);
  return reputation !== null && reputation >= preferences.minTrustScore;
}

export function scoreModelRoute<T extends ModelRouteCandidate>(
  route: T,
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
): ScoredModelRoute<T> {
  const reasons: string[] = [];
  let score = 100;

  if (isModelRouteCoolingDown(route, now)) {
    score -= COOLING_DOWN_PENALTY;
    reasons.push('peer cooling down');
  } else {
    const failureStreak = typeof route.peerFailureStreak === 'number' && Number.isFinite(route.peerFailureStreak)
      ? Math.max(0, Math.trunc(route.peerFailureStreak))
      : 0;
    if (failureStreak > 0) {
      score -= FAILURE_STREAK_PENALTY * failureStreak;
      reasons.push('recent peer failures');
    }
  }

  const totalPrice = modelRouteTotalPrice(route);
  if (preferences.preferFreePeers && totalPrice === 0) {
    score += 25;
    reasons.push('free peer preferred');
  }

  const inputPrice = route.inputUsdPerMillion;
  if (
    typeof inputPrice === 'number'
    && Number.isFinite(inputPrice)
    && inputPrice > preferences.maxInputUsdPerMillion
  ) {
    score -= 50;
    reasons.push('input price exceeds maximum');
  }

  const reputation = modelRouteReputationScore(route);
  if (reputation !== null && reputation < preferences.minTrustScore) {
    score -= 50;
    reasons.push('trust score below minimum');
  }
  score += Math.min(reputation ?? 0, 100) / 5;

  if (totalPrice === null) {
    score -= UNKNOWN_PRICE_PENALTY;
    reasons.push('price unknown');
  } else {
    score -= totalPrice;
  }

  return { route, score, reasons };
}

function compareScoredModelRoutes<T extends ModelRouteCandidate>(
  a: ScoredModelRoute<T>,
  b: ScoredModelRoute<T>,
  preferences: ModelRoutingPreferences,
  now: number,
): number {
  const aEligible = isModelRouteEligible(a.route, preferences);
  const bEligible = isModelRouteEligible(b.route, preferences);
  if (aEligible !== bEligible) return aEligible ? -1 : 1;

  const aCooling = isModelRouteCoolingDown(a.route, now);
  const bCooling = isModelRouteCoolingDown(b.route, now);
  if (aCooling !== bCooling) return aCooling ? 1 : -1;

  const aPrice = modelRouteTotalPrice(a.route);
  const bPrice = modelRouteTotalPrice(b.route);
  const aKnown = aPrice !== null;
  const bKnown = bPrice !== null;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;

  // Trust is a gate, not a rank: among eligible, ready peers the cheapest
  // total price wins, and the blended score (reputation, failure streaks,
  // preference bonuses) only breaks price ties. Reputation ordering above
  // the eligibility threshold would re-apply the trust filter as a soft
  // rank and let a well-rated seller beat a free one on 2 display points.
  return (aPrice ?? Number.POSITIVE_INFINITY) - (bPrice ?? Number.POSITIVE_INFINITY)
    || b.score - a.score
    || normalizedPeerId(a.route.peerId).localeCompare(normalizedPeerId(b.route.peerId));
}

export function rankModelRoutes<T extends ModelRouteCandidate>(
  routes: T[],
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
): T[] {
  return routes
    .map((route) => scoreModelRoute(route, preferences, now))
    .sort((a, b) => compareScoredModelRoutes(a, b, preferences, now))
    .map(({ route }) => route);
}

export function chooseBestModelRoute<T extends ModelRouteCandidate>(
  routes: T[],
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
): T | null {
  return rankModelRoutes(routes, preferences, now)
    .find((route) => isModelRouteEligible(route, preferences)) ?? null;
}
