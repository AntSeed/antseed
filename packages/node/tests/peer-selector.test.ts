import { describe, it, expect } from 'vitest';
import {
  scorePeer,
  rankPeers,
  selectBestPeer,
  selectDiversePeers,
  DEFAULT_SCORING_WEIGHTS,
  type PeerCandidate,
} from '../src/discovery/peer-selector.js';

function makeCandidate(overrides?: Partial<PeerCandidate>): PeerCandidate {
  return {
    peerId: 'peer-1',
    region: 'us-east-1',
    inputUsdPerMillion: 0.01,
    maxConcurrency: 10,
    currentLoad: 0,
    latencyMs: 100,
    reputation: 0.9,
    ...overrides,
  };
}

describe('scorePeer', () => {
  it('should return a score between 0 and 1', () => {
    const score = scorePeer(makeCandidate(), 0.01);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should give perfect score to ideal candidate', () => {
    const candidate = makeCandidate({
      inputUsdPerMillion: 0.01,
      maxConcurrency: 10,
      currentLoad: 0,
      latencyMs: 0,
      reputation: 1,
    });
    const score = scorePeer(candidate, 0.01);
    expect(score).toBeCloseTo(1.0, 2);
  });

  it('should give lower score to more expensive peers', () => {
    const cheap = makeCandidate({ inputUsdPerMillion: 0.01 });
    const expensive = makeCandidate({ inputUsdPerMillion: 0.10 });
    const cheapScore = scorePeer(cheap, 0.01);
    const expensiveScore = scorePeer(expensive, 0.01);
    expect(cheapScore).toBeGreaterThan(expensiveScore);
  });

  it('should give lower score to heavily loaded peers', () => {
    const idle = makeCandidate({ currentLoad: 0, maxConcurrency: 10 });
    const loaded = makeCandidate({ currentLoad: 9, maxConcurrency: 10 });
    expect(scorePeer(idle, 0.01)).toBeGreaterThan(scorePeer(loaded, 0.01));
  });

  it('should give lower score to high-latency peers', () => {
    const fast = makeCandidate({ latencyMs: 50 });
    const slow = makeCandidate({ latencyMs: 10000 });
    expect(scorePeer(fast, 0.01)).toBeGreaterThan(scorePeer(slow, 0.01));
  });

  it('should handle zero price (free) as perfect price score', () => {
    const free = makeCandidate({ inputUsdPerMillion: 0 });
    const score = scorePeer(free, 0.01);
    // price score = 1.0 for free peers
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('should handle maxConcurrency = 0 as zero capacity', () => {
    const candidate = makeCandidate({ maxConcurrency: 0, currentLoad: 0 });
    // capacity score = 0 when maxConcurrency is 0
    const score = scorePeer(candidate, 0.01);
    expect(score).toBeLessThan(1);
  });

  it('should clamp latency score at 0 for >= 15000ms', () => {
    const verySlowA = makeCandidate({ latencyMs: 15000 });
    const verySlowB = makeCandidate({ latencyMs: 20000 });
    expect(scorePeer(verySlowA, 0.01)).toEqual(scorePeer(verySlowB, 0.01));
  });

  it('should accept custom weights', () => {
    // Use a candidate where price score and capacity score differ
    const candidate = makeCandidate({
      inputUsdPerMillion: 0.05, // price score = 0.01/0.05 = 0.2
      maxConcurrency: 10,
      currentLoad: 5, // capacity score = 5/10 = 0.5
      latencyMs: 0,
      reputation: 0,
    });
    const priceOnly = { price: 1, capacity: 0, latency: 0, reputation: 0 };
    const capOnly = { price: 0, capacity: 1, latency: 0, reputation: 0 };
    const s1 = scorePeer(candidate, 0.01, priceOnly);
    const s2 = scorePeer(candidate, 0.01, capOnly);
    expect(s1).not.toBe(s2);
    expect(s1).toBeCloseTo(0.2, 2);
    expect(s2).toBeCloseTo(0.5, 2);
  });
});

describe('rankPeers', () => {
  it('should return empty array for empty input', () => {
    expect(rankPeers([])).toEqual([]);
  });

  it('should sort peers by score descending', () => {
    const candidates = [
      makeCandidate({ peerId: 'expensive', inputUsdPerMillion: 1.0, latencyMs: 5000 }),
      makeCandidate({ peerId: 'cheap', inputUsdPerMillion: 0.001, latencyMs: 50 }),
    ];
    const ranked = rankPeers(candidates);
    expect(ranked[0]!.candidate.peerId).toBe('cheap');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('should derive cheapest price automatically', () => {
    const candidates = [
      makeCandidate({ peerId: 'a', inputUsdPerMillion: 0.1 }),
      makeCandidate({ peerId: 'b', inputUsdPerMillion: 0.01 }),
    ];
    const ranked = rankPeers(candidates);
    // 'b' is cheapest so it should have perfect price score
    expect(ranked[0]!.candidate.peerId).toBe('b');
  });
});

describe('selectBestPeer', () => {
  it('should return null for empty candidates', () => {
    expect(selectBestPeer([])).toBeNull();
  });

  it('should return the highest-scoring peer', () => {
    const candidates = [
      makeCandidate({ peerId: 'slow', latencyMs: 10000, inputUsdPerMillion: 1 }),
      makeCandidate({ peerId: 'fast', latencyMs: 10, inputUsdPerMillion: 0.001 }),
    ];
    const best = selectBestPeer(candidates);
    expect(best).not.toBeNull();
    expect(best!.candidate.peerId).toBe('fast');
  });
});

describe('selectDiversePeers', () => {
  it('should return all peers when count >= candidates', () => {
    const candidates = [makeCandidate({ peerId: 'a' }), makeCandidate({ peerId: 'b' })];
    const result = selectDiversePeers(candidates, 5);
    expect(result).toHaveLength(2);
  });

  it('should prefer peers from different regions', () => {
    const candidates = [
      makeCandidate({ peerId: 'us1', region: 'us-east-1', inputUsdPerMillion: 0.01 }),
      makeCandidate({ peerId: 'us2', region: 'us-east-1', inputUsdPerMillion: 0.02 }),
      makeCandidate({ peerId: 'eu1', region: 'eu-west-1', inputUsdPerMillion: 0.03 }),
    ];
    const result = selectDiversePeers(candidates, 2);
    expect(result).toHaveLength(2);
    const regions = result.map((r) => r.candidate.region);
    expect(regions).toContain('us-east-1');
    expect(regions).toContain('eu-west-1');
  });

  it('should fill remaining slots by score after region diversity', () => {
    const candidates = [
      makeCandidate({ peerId: 'a', region: 'us', inputUsdPerMillion: 0.001 }),
      makeCandidate({ peerId: 'b', region: 'us', inputUsdPerMillion: 0.01 }),
      makeCandidate({ peerId: 'c', region: 'eu', inputUsdPerMillion: 0.1 }),
    ];
    const result = selectDiversePeers(candidates, 3);
    expect(result).toHaveLength(3);
  });
});

describe('DEFAULT_SCORING_WEIGHTS', () => {
  it('should sum to approximately 1.0', () => {
    const sum =
      DEFAULT_SCORING_WEIGHTS.price +
      DEFAULT_SCORING_WEIGHTS.capacity +
      DEFAULT_SCORING_WEIGHTS.latency +
      DEFAULT_SCORING_WEIGHTS.reputation;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
