import type { PeerId } from './peer.js';

export type RatingDimension = 'quality' | 'speed' | 'reliability' | 'value' | 'overall';

export interface PeerRating {
  ratingId: string;
  raterPeerId: PeerId;
  targetPeerId: PeerId;
  sessionId: string;
  dimensions: Record<RatingDimension, 1 | 2 | 3 | 4 | 5>;
  comment?: string;
  timestamp: number;
  /** secp256k1 signature (hex) */
  signature: string;
}

export interface AggregateRating {
  peerId: PeerId;
  averageByDimension: Record<RatingDimension, number>;
  overallAverage: number;
  totalRatings: number;
  lastUpdated: number;
}
