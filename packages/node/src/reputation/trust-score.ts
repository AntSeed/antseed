import type { PeerId } from '../types/peer.js';

/**
 * Individual components that make up a trust score.
 * Each component is normalized to 0.0 - 1.0.
 */
export interface TrustComponents {
  /** Successful delivery rate (completed requests / total requests) */
  deliveryRate: number;
  /** Uptime percentage over rolling window */
  uptimeRate: number;
  /** Response quality score from metering data */
  responseQuality: number;
  /** Weight based on staked amount (normalized) */
  stakeWeight: number;
  /** Aggregate peer ratings (normalized average) */
  peerRatings: number;
  /** Account age factor (logarithmic scale) */
  accountAge: number;
}

/**
 * Computed trust score for a peer.
 */
export interface TrustScore {
  peerId: PeerId;
  /** Overall trust score 0-100 */
  score: number;
  /** Individual component scores */
  components: TrustComponents;
  /** When this score was last computed */
  updatedAt: number;
}

/** Default weights for trust score computation. */
export const DEFAULT_TRUST_WEIGHTS: Record<keyof TrustComponents, number> = {
  deliveryRate: 0.40,
  uptimeRate: 0.20,
  responseQuality: 0.20,
  stakeWeight: 0.10,
  peerRatings: 0.05,
  accountAge: 0.05,
};

/** Default component values for unknown metrics */
export const DEFAULT_COMPONENTS: TrustComponents = {
  deliveryRate: 0.5,
  uptimeRate: 0.5,
  responseQuality: 0.5,
  stakeWeight: 0.0,
  peerRatings: 0.5,
  accountAge: 0.0,
};

/**
 * Compute a trust score from components using weighted sum.
 * @returns Score from 0-100
 */
export function computeTrustScore(
  components: TrustComponents,
  weights: Partial<Record<keyof TrustComponents, number>> = {}
): number {
  const w = { ...DEFAULT_TRUST_WEIGHTS, ...weights };
  let score = 0;
  for (const key of Object.keys(w) as Array<keyof TrustComponents>) {
    const component = Math.max(0, Math.min(1, components[key]));
    score += component * w[key];
  }
  return Math.round(score * 100 * 100) / 100; // 2 decimal places
}
