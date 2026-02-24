import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PeerId } from '../types/peer.js';
import type { TrustScore, TrustComponents } from './trust-score.js';
import { DEFAULT_COMPONENTS, computeTrustScore } from './trust-score.js';

export interface TrustEngineConfig {
  configDir: string;
}

export class TrustScoreEngine {
  private readonly configDir: string;
  private scores: Map<string, TrustScore> = new Map();

  constructor(config: TrustEngineConfig) {
    this.configDir = config.configDir;
  }

  /**
   * Update trust score for a peer with new component data.
   * Merges partial components with existing or defaults.
   */
  updateScore(peerId: PeerId, partialComponents: Partial<TrustComponents>): TrustScore {
    const existing = this.scores.get(peerId);
    const components: TrustComponents = {
      ...(existing?.components ?? DEFAULT_COMPONENTS),
      ...partialComponents,
    };

    const score: TrustScore = {
      peerId,
      score: computeTrustScore(components),
      components,
      updatedAt: Date.now(),
    };

    this.scores.set(peerId, score);
    return score;
  }

  getScore(peerId: PeerId): TrustScore | null {
    return this.scores.get(peerId) ?? null;
  }

  getAllScores(): TrustScore[] {
    return Array.from(this.scores.values());
  }

  /**
   * Compute report rate component for trust score.
   * Based on unique reporters with 30-day half-life decay.
   */
  computeReportComponent(reports: Array<{ reporterPeerId: string; timestamp: number }>): number {
    if (reports.length === 0) return 1.0;

    const now = Date.now();
    const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

    const reporterWeights = new Map<string, number>();
    for (const r of reports) {
      const age = now - r.timestamp;
      const weight = Math.pow(0.5, age / HALF_LIFE_MS);
      const existing = reporterWeights.get(r.reporterPeerId) ?? 0;
      reporterWeights.set(r.reporterPeerId, Math.max(existing, weight));
    }

    const totalWeight = Array.from(reporterWeights.values()).reduce((a, b) => a + b, 0);
    return Math.max(0, 1 - totalWeight / 5);
  }

  /**
   * Compute peer rating component for trust score.
   * Uses Bayesian averaging: blend with global average until enough ratings.
   */
  computeRatingComponent(
    ratings: Array<{ overallScore: number; raterTrustScore?: number }>,
    globalAverage: number = 3.0,
    minRatings: number = 5,
  ): number {
    if (ratings.length === 0) return 0.5;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const r of ratings) {
      const weight = r.raterTrustScore !== undefined ? r.raterTrustScore / 100 : 0.5;
      weightedSum += r.overallScore * weight;
      totalWeight += weight;
    }

    const rawAverage = totalWeight > 0 ? weightedSum / totalWeight : globalAverage;

    const n = ratings.length;
    const bayesian = (minRatings * globalAverage + n * rawAverage) / (minRatings + n);

    return Math.max(0, Math.min(1, (bayesian - 1) / 4));
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const filePath = join(this.configDir, 'trust-scores.json');
    const data = Array.from(this.scores.values());
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async load(): Promise<void> {
    const filePath = join(this.configDir, 'trust-scores.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as TrustScore[];
      this.scores.clear();
      for (const score of data) {
        this.scores.set(score.peerId, score);
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.scores.clear();
    }
  }
}
