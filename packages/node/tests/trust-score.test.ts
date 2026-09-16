import { describe, expect, it, vi } from 'vitest';
import { computeTrustScore, trustScore, shareScore } from '../src/reputation/trust-score.js';
import { DefaultRouter } from '../src/routing/default-router.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { peerWithGithub } from './helpers/identity-fixtures.js';

const NOW = Date.parse('2026-09-06T00:00:00Z');
const PEER_ID = 'a'.repeat(40) as PeerInfo['peerId'];

function chainPeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: PEER_ID, providers: [], lastSeen: NOW,
    onChainUsageEpoch: 22, onChainUsageShareBps: 0, onChainPoolPowerShareBps: 0, onChainWashFlagged: false,
    ...overrides,
  };
}

describe('shareScore', () => {
  it('maps a share of all pools onto a log curve with a 1000x range', () => {
    expect(shareScore(0)).toBe(0);
    expect(shareScore(100)).toBeCloseTo(34.7, 0);
    expect(shareScore(620)).toBeCloseTo(60, 0);
    expect(shareScore(1_000)).toBeCloseTo(66.7, 0);
    expect(shareScore(10_000)).toBe(100);
    expect(shareScore(50_000)).toBe(100);
    expect(shareScore(NaN)).toBe(0);
  });
});

describe('computeTrustScore', () => {
  it('is null when nothing about the peer is known', () => {
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW)).toBeNull();
    expect(trustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, onChainChannelCount: 500, onChainTotalVolumeUsdcMicros: 1e9 }, NOW)).toBeNull();
  });

  it('averages last epoch usage share and current epoch power share', () => {
    const balanced = chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: 1_000 });
    expect(computeTrustScore(balanced, NOW)).toMatchObject({
      usage: { shareBps: 1_000, epoch: 21 }, power: { shareBps: 1_000, epoch: 22 }, identity: null, washFlagged: false,
    });
    expect(trustScore(balanced, NOW)).toBeCloseTo(shareScore(1_000));
    const powerOnly = chainPeer({ onChainPoolPowerShareBps: 1_000 });
    expect(trustScore(powerOnly, NOW)).toBeCloseTo(shareScore(1_000) / 2);
    expect(trustScore(chainPeer(), NOW)).toBe(0);
    expect(trustScore(chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000 }), NOW)).toBe(100);
  });

  it('has no usage part in the first epoch and no power part without pool data', () => {
    expect(computeTrustScore(chainPeer({ onChainUsageEpoch: 0, onChainUsageShareBps: 5_000 }), NOW)?.usage).toBeNull();
    const noPools = computeTrustScore(chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: undefined }), NOW);
    expect(noPools?.power).toBeNull();
    expect(noPools?.score).toBeCloseTo(shareScore(1_000) / 2);
  });

  it('lets a verified identity bootstrap a seller without a pool record, without stacking', () => {
    const identityOnly = peerWithGithub();
    expect(computeTrustScore(identityOnly, NOW)).toMatchObject({ score: 70, usage: null, power: null, identity: { score: 70, kind: 'github', claim: 'portfolio' }, washFlagged: null });
    const strong = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000 }) };
    expect(trustScore(strong, NOW)).toBe(100);
    const weak = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 100, onChainPoolPowerShareBps: 100 }) };
    expect(trustScore(weak, NOW)).toBe(70);
  });

  it('zeroes a proven wash trader regardless of usage, power or identity', () => {
    const flagged = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000, onChainWashFlagged: true }) };
    expect(computeTrustScore(flagged, NOW)).toMatchObject({ score: 0, washFlagged: true });
    expect(trustScore(chainPeer({ onChainWashFlagged: true }), NOW)).toBe(0);
  });

  it('ignores lifetime channel stats, stake amount and the local sybil heuristic', () => {
    const peer = chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: 1_000, onChainChannelCount: 5, onChainGhostCount: 500,
      onChainSybilRisk: 1, onChainTotalVolumeUsdcMicros: 0, onChainPoolStakeAnts: 1_000_000, onChainUsageLastEpochUsdcMicros: 5 });
    expect(trustScore(peer, NOW)).toBeCloseTo(shareScore(1_000));
  });

  it('feeds the default router: price-first among eligible peers, trust as the eligibility gate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const cheap: PeerInfo = { ...chainPeer(), peerId: 'b'.repeat(40) as PeerInfo['peerId'], onChainReputationScore: 0, defaultInputUsdPerMillion: 1 };
      const established: PeerInfo = { ...chainPeer({ onChainUsageShareBps: 2_000, onChainPoolPowerShareBps: 2_000 }), onChainReputationScore: 75, defaultInputUsdPerMillion: 2 };
      const request = {} as SerializedHttpRequest;
      expect(new DefaultRouter().selectPeer(request, [established, cheap])).toBe(cheap);
      expect(new DefaultRouter({ minReputation: 60 }).selectPeer(request, [cheap, established])).toBe(established);
    } finally { vi.useRealTimers(); }
  });
});
