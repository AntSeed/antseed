export interface ScoringWeights {
  price: number;
  capacity: number;
  latency: number;
  reputation: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  price: 0.35,
  capacity: 0.25,
  latency: 0.25,
  reputation: 0.15,
};

export interface PeerCandidate {
  peerId: string;
  region: string;
  inputUsdPerMillion: number;
  maxConcurrency: number;
  currentLoad: number;
  latencyMs: number;
  reputation: number;
}

export interface ScoredPeer {
  candidate: PeerCandidate;
  score: number;
}

/**
 * Score a single peer candidate.
 *
 * - priceScore: cheapestInputPrice / candidate.inputUsdPerMillion (capped at 1.0)
 * - capacityScore: (maxConcurrency - currentLoad) / maxConcurrency
 * - latencyScore: 1 - (latencyMs / 15000), clamped to [0, 1]
 * - reputationScore: candidate.reputation (expected 0..1)
 */
export function scorePeer(
  candidate: PeerCandidate,
  cheapestInputPrice: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number {
  // Price score
  const priceScore =
    candidate.inputUsdPerMillion > 0
      ? Math.min(cheapestInputPrice / candidate.inputUsdPerMillion, 1.0)
      : 1.0;

  // Capacity score
  const capacityScore =
    candidate.maxConcurrency > 0
      ? (candidate.maxConcurrency - candidate.currentLoad) /
        candidate.maxConcurrency
      : 0;

  // Latency score
  const latencyScore = Math.max(0, Math.min(1, 1 - candidate.latencyMs / 15000));

  // Reputation score
  const reputationScore = Math.max(0, Math.min(1, candidate.reputation));

  const score =
    weights.price * priceScore +
    weights.capacity * capacityScore +
    weights.latency * latencyScore +
    weights.reputation * reputationScore;

  return Math.max(0, Math.min(1, score));
}

export function rankPeers(
  candidates: PeerCandidate[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoredPeer[] {
  if (candidates.length === 0) {
    return [];
  }

  const cheapestInputPrice = Math.min(
    ...candidates.map((c) => c.inputUsdPerMillion).filter((p) => p > 0)
  );
  const effectiveCheapest = Number.isFinite(cheapestInputPrice)
    ? cheapestInputPrice
    : 0;

  const scored: ScoredPeer[] = candidates.map((candidate) => ({
    candidate,
    score: scorePeer(candidate, effectiveCheapest, weights),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function selectBestPeer(
  candidates: PeerCandidate[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoredPeer | null {
  const ranked = rankPeers(candidates, weights);
  return ranked[0] ?? null;
}

export function selectDiversePeers(
  candidates: PeerCandidate[],
  count: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoredPeer[] {
  const ranked = rankPeers(candidates, weights);
  if (ranked.length <= count) {
    return ranked;
  }

  const selected: ScoredPeer[] = [];
  const seenRegions = new Set<string>();

  // First pass: pick the best from each unique region
  for (const peer of ranked) {
    if (selected.length >= count) break;
    if (!seenRegions.has(peer.candidate.region)) {
      seenRegions.add(peer.candidate.region);
      selected.push(peer);
    }
  }

  // Second pass: fill remaining slots by score
  for (const peer of ranked) {
    if (selected.length >= count) break;
    if (!selected.includes(peer)) {
      selected.push(peer);
    }
  }

  return selected;
}
