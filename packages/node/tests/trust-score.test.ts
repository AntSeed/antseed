import { describe, expect, it, vi } from 'vitest';
import { computeTrustScore, trustScore, shareCurve, TRUST_WEIGHTS } from '../src/reputation/trust-score.js';
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

describe('shareCurve', () => {
  it('maps a share of all pools onto a 0-1 log curve with a 1000x range', () => {
    expect(shareCurve(0)).toBe(0);
    expect(shareCurve(100)).toBeCloseTo(0.347, 2);
    expect(shareCurve(1_000)).toBeCloseTo(0.667, 2);
    expect(shareCurve(10_000)).toBe(1);
    expect(shareCurve(50_000)).toBe(1);
    expect(shareCurve(NaN)).toBe(0);
  });

  it('weights sum to 100', () => {
    expect(Object.values(TRUST_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('computeTrustScore', () => {
  it('is null when nothing about the peer is known', () => {
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW)).toBeNull();
    expect(trustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, onChainChannelCount: 500, onChainTotalVolumeUsdcMicros: 1e9 }, NOW)).toBeNull();
  });

  it('adds weighted last-epoch usage share and current-epoch power share', () => {
    const balanced = chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: 1_000 });
    expect(computeTrustScore(balanced, NOW)).toMatchObject({
      usage: { shareBps: 1_000, epoch: 21 }, power: { shareBps: 1_000, epoch: 22 }, identity: null, washFlagged: false,
    });
    expect(trustScore(balanced, NOW)).toBeCloseTo(60 * shareCurve(1_000));
    const powerOnly = chainPeer({ onChainPoolPowerShareBps: 1_000 });
    expect(trustScore(powerOnly, NOW)).toBeCloseTo(20 * shareCurve(1_000));
    expect(trustScore(chainPeer(), NOW)).toBe(0);
    expect(trustScore(chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000 }), NOW)).toBe(60);
  });

  it('has no usage part in the first epoch and no power part without pool data', () => {
    expect(computeTrustScore(chainPeer({ onChainUsageEpoch: 0, onChainUsageShareBps: 5_000 }), NOW)?.usage).toBeNull();
    const noPools = computeTrustScore(chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: undefined }), NOW);
    expect(noPools?.power).toBeNull();
    expect(noPools?.score).toBeCloseTo(40 * shareCurve(1_000));
  });

  it('adds up to 40 points for a verified identity on top of the on-chain parts', () => {
    const identityOnly = peerWithGithub();
    expect(computeTrustScore(identityOnly, NOW)).toMatchObject({ score: 40, usage: null, power: null, identity: { score: 40, kind: 'github', claim: 'portfolio' }, washFlagged: null });
    const strong = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000 }) };
    expect(trustScore(strong, NOW)).toBe(100);
    const typical = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: 1_000 }) };
    expect(trustScore(typical, NOW)).toBeCloseTo(40 + 60 * shareCurve(1_000));
    const domainOnly = peerWithGithub([]);
    domainOnly.verificationResults!.identityHistory = { version: 1, identities: [{ kind: 'domain', claim: 'portfolio.example',
      status: 'available', identityId: 'domain:portfolio.example', fetchedAtMs: NOW, createdAtMs: NOW - 20 * 365.25 * 86_400_000 }] };
    expect(trustScore(domainOnly, NOW)).toBeCloseTo(40 * 12 / 70);
  });

  it('zeroes a proven wash trader regardless of usage, power or identity', () => {
    const flagged = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000, onChainWashFlagged: true }) };
    expect(computeTrustScore(flagged, NOW)).toMatchObject({ score: 0, washFlagged: true });
    expect(trustScore(chainPeer({ onChainWashFlagged: true }), NOW)).toBe(0);
  });

  it('ignores lifetime channel stats, stake amount and the local sybil heuristic', () => {
    const peer = chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: 1_000, onChainChannelCount: 5, onChainGhostCount: 500,
      onChainSybilRisk: 1, onChainTotalVolumeUsdcMicros: 0, onChainPoolStakeAnts: 1_000_000, onChainUsageLastEpochUsdcMicros: 5 });
    expect(trustScore(peer, NOW)).toBeCloseTo(60 * shareCurve(1_000));
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
