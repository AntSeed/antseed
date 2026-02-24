import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PeerId } from '../types/peer.js';
import type { PeerRating, RatingDimension, AggregateRating } from '../types/rating.js';
import type { Identity } from '../p2p/identity.js';
import { signData } from '../p2p/identity.js';
import { bytesToHex } from '../utils/hex.js';

const HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DIMENSIONS: RatingDimension[] = ['quality', 'speed', 'reliability', 'value', 'overall'];

export interface RatingManagerConfig {
  configDir: string;
  identity?: Identity;
}

export class RatingManager {
  private readonly configDir: string;
  private readonly identity: Identity | undefined;
  private ratings: PeerRating[] = [];

  constructor(config: RatingManagerConfig) {
    this.configDir = config.configDir;
    this.identity = config.identity;
  }

  async submitRating(
    targetPeerId: PeerId,
    sessionId: string,
    dimensions: Record<RatingDimension, 1 | 2 | 3 | 4 | 5>,
    comment?: string,
  ): Promise<PeerRating> {
    if (!this.identity) throw new Error('Identity required to submit ratings');

    const rating: PeerRating = {
      ratingId: randomUUID(),
      raterPeerId: this.identity.peerId as PeerId,
      targetPeerId,
      sessionId,
      dimensions,
      comment,
      timestamp: Date.now(),
      signature: '',
    };

    const dataToSign = `${rating.ratingId}:${rating.raterPeerId}:${rating.targetPeerId}:${rating.sessionId}:${rating.timestamp}`;
    const sig = await signData(this.identity.privateKey, new TextEncoder().encode(dataToSign));
    rating.signature = bytesToHex(sig);

    this.ratings.push(rating);
    await this.save();
    return rating;
  }

  getAggregateRating(peerId: PeerId): AggregateRating {
    const peerRatings = this.ratings.filter(r => r.targetPeerId === peerId);
    const now = Date.now();

    const weightedSums: Record<string, number> = Object.fromEntries(DIMENSIONS.map(d => [d, 0]));
    let totalWeight = 0;

    for (const rating of peerRatings) {
      // Exponential decay weight
      const age = now - rating.timestamp;
      const weight = Math.pow(0.5, age / HALF_LIFE_MS);
      totalWeight += weight;

      for (const dim of DIMENSIONS) {
        weightedSums[dim]! += rating.dimensions[dim] * weight;
      }
    }

    const averageByDimension = {} as Record<RatingDimension, number>;
    for (const dim of DIMENSIONS) {
      averageByDimension[dim] = totalWeight > 0
        ? Math.round((weightedSums[dim]! / totalWeight) * 100) / 100
        : 0;
    }

    const overallAverage = totalWeight > 0
      ? Math.round((DIMENSIONS.reduce((sum, dim) => sum + averageByDimension[dim], 0) / DIMENSIONS.length) * 100) / 100
      : 0;

    return {
      peerId,
      averageByDimension,
      overallAverage,
      totalRatings: peerRatings.length,
      lastUpdated: now,
    };
  }

  getRatingsFor(peerId: PeerId): PeerRating[] {
    return this.ratings.filter(r => r.targetPeerId === peerId);
  }

  getMyRatings(): PeerRating[] {
    if (!this.identity) return [];
    return this.ratings.filter(r => r.raterPeerId === this.identity!.peerId);
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const filePath = join(this.configDir, 'ratings.json');
    await writeFile(filePath, JSON.stringify(this.ratings, null, 2), 'utf-8');
  }

  async load(): Promise<void> {
    const filePath = join(this.configDir, 'ratings.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      this.ratings = JSON.parse(raw) as PeerRating[];
    } catch {
      this.ratings = [];
    }
  }
}
