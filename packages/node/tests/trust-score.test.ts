import { describe, expect, it, vi } from 'vitest';
import { computeTrustScore, trustScore, usageScoreFromUsdc, stakeScoreFromPowerShareBps,
  TRUST_STAKE_MAX_POINTS, TRUST_USAGE_FULL_SCORE_USDC } from '../src/reputation/trust-score.js';
import { DefaultRouter } from '../src/routing/default-router.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { peerWithGithub } from './helpers/identity-fixtures.js';

const NOW = Date.parse('2026-09-06T00:00:00Z');
const PEER_ID = 'a'.repeat(40) as PeerInfo['peerId'];

function chainPeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: PEER_ID, providers: [], lastSeen: NOW,
    onChainUsageEpoch: 22, onChainUsageCurrentEpochUsdcMicros: 0, onChainUsageLastEpochUsdcMicros: 0,
    onChainPoolPowerShareBps: 0, onChainWashFlagged: false,
    ...overrides,
  };
}

describe('trust score parts', () => {
  it('scores recognized usage on a log curve that saturates at the full-score amount', () => {
    expect(usageScoreFromUsdc(0)).toBe(0);
    expect(usageScoreFromUsdc(TRUST_USAGE_FULL_SCORE_USDC)).toBe(100);
    expect(usageScoreFromUsdc(60)).toBeCloseTo(59.5, 0);
    expect(usageScoreFromUsdc(100)).toBeCloseTo(66.8, 0);
    expect(usageScoreFromUsdc(1_000_000)).toBe(100);
    expect(usageScoreFromUsdc(NaN)).toBe(0);
  });

  it('scores pool power share by square root up to the stake cap', () => {
    expect(stakeScoreFromPowerShareBps(0)).toBe(0);
    expect(stakeScoreFromPowerShareBps(100)).toBeCloseTo(1.5);
    expect(stakeScoreFromPowerShareBps(2_500)).toBeCloseTo(7.5);
    expect(stakeScoreFromPowerShareBps(10_000)).toBe(TRUST_STAKE_MAX_POINTS);
    expect(stakeScoreFromPowerShareBps(50_000)).toBe(TRUST_STAKE_MAX_POINTS);
  });
});

describe('computeTrustScore', () => {
  it('is null when nothing about the peer is known', () => {
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW)).toBeNull();
    expect(trustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, onChainChannelCount: 500, onChainTotalVolumeUsdcMicros: 1e9 }, NOW)).toBeNull();
  });

  it('uses the better of the current and previous epoch usage', () => {
    const current = chainPeer({ onChainUsageCurrentEpochUsdcMicros: 500_000_000 });
    const previous = chainPeer({ onChainUsageLastEpochUsdcMicros: 500_000_000 });
    expect(computeTrustScore(current, NOW)).toMatchObject({ score: usageScoreFromUsdc(500), usage: { usdc: 500, epoch: 22 }, identity: null, washFlagged: false });
    expect(trustScore(previous, NOW)).toBe(trustScore(current, NOW));
    expect(trustScore(chainPeer(), NOW)).toBe(0);
  });

  it('lets a verified identity bootstrap a seller without usage, without stacking on usage', () => {
    const identityOnly = peerWithGithub();
    expect(computeTrustScore(identityOnly, NOW)).toMatchObject({ score: 70, usage: null, identity: { score: 70, kind: 'github', claim: 'portfolio' }, stake: null, washFlagged: null });
    const both = { ...peerWithGithub(), ...chainPeer({ onChainUsageCurrentEpochUsdcMicros: 1_000_000_000 }) };
    expect(trustScore(both, NOW)).toBe(100);
    const weakUsage = { ...peerWithGithub(), ...chainPeer({ onChainUsageCurrentEpochUsdcMicros: 10_000_000 }) };
    expect(trustScore(weakUsage, NOW)).toBe(70);
  });

  it('adds pool staking power on top, capped at 100', () => {
    const staked = chainPeer({ onChainUsageCurrentEpochUsdcMicros: 100_000_000, onChainPoolPowerShareBps: 2_500 });
    expect(computeTrustScore(staked, NOW)).toMatchObject({ stake: { score: 7.5, powerShareBps: 2_500 } });
    expect(trustScore(staked, NOW)).toBeCloseTo(usageScoreFromUsdc(100) + 7.5);
    expect(trustScore(chainPeer({ onChainUsageCurrentEpochUsdcMicros: 1_000_000_000, onChainPoolPowerShareBps: 10_000 }), NOW)).toBe(100);
  });

  it('zeroes a proven wash trader regardless of usage, identity or stake', () => {
    const flagged = { ...peerWithGithub(), ...chainPeer({ onChainUsageCurrentEpochUsdcMicros: 1_000_000_000, onChainPoolPowerShareBps: 10_000, onChainWashFlagged: true }) };
    expect(computeTrustScore(flagged, NOW)).toMatchObject({ score: 0, washFlagged: true });
    expect(trustScore(chainPeer({ onChainWashFlagged: true }), NOW)).toBe(0);
  });

  it('ignores lifetime channel stats and the local sybil heuristic', () => {
    const peer = chainPeer({ onChainUsageCurrentEpochUsdcMicros: 100_000_000, onChainChannelCount: 5, onChainGhostCount: 500, onChainSybilRisk: 1, onChainTotalVolumeUsdcMicros: 0 });
    expect(trustScore(peer, NOW)).toBe(usageScoreFromUsdc(100));
  });

  it('feeds the default router: price-first among eligible peers, trust as the eligibility gate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const cheap: PeerInfo = { ...chainPeer(), peerId: 'b'.repeat(40) as PeerInfo['peerId'], onChainReputationScore: 0, defaultInputUsdPerMillion: 1 };
      const established: PeerInfo = { ...chainPeer({ onChainUsageCurrentEpochUsdcMicros: 500_000_000 }), onChainReputationScore: 90, defaultInputUsdPerMillion: 2 };
      const request = {} as SerializedHttpRequest;
      expect(new DefaultRouter().selectPeer(request, [established, cheap])).toBe(cheap);
      expect(new DefaultRouter({ minReputation: 60 }).selectPeer(request, [cheap, established])).toBe(established);
    } finally { vi.useRealTimers(); }
  });
});
