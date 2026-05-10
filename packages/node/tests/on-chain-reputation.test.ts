import { describe, expect, it } from 'vitest';
import {
  ON_CHAIN_REPUTATION_VOLUME_EXPONENT,
  ON_CHAIN_REPUTATION_VOLUME_LOG_TARGET_USDC,
  computeOnChainReputationBreakdown,
  computeOnChainReputationScore,
} from '../src/reputation/on-chain-reputation.js';
import type { PeerInfo } from '../src/types/peer.js';

const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function peer(stats: Partial<PeerInfo>): Pick<PeerInfo,
  | 'onChainChannelCount'
  | 'onChainGhostCount'
  | 'onChainTotalVolumeUsdcMicros'
  | 'onChainLastSettledAtSec'
  | 'onChainStakedAtSec'
> {
  return stats;
}

describe('on-chain reputation score', () => {
  it('returns null when no on-chain stats are available', () => {
    expect(computeOnChainReputationScore(peer({}), NOW_MS)).toBeNull();
  });

  it('does not treat raw channel count alone as reputation', () => {
    expect(computeOnChainReputationScore(peer({
      onChainChannelCount: 100,
      onChainGhostCount: 0,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS)).toBe(0);
  });

  it('rewards mature channels, high volume, average channel value, and recency', () => {
    const score = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);

    expect(score).toBeCloseTo(100, 6);
  });

  it('uses a logarithmic volume curve so settled volume keeps differentiating peers', () => {
    const low = computeOnChainReputationBreakdown(peer({
      onChainChannelCount: 50,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 25_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const high = computeOnChainReputationBreakdown(peer({
      onChainChannelCount: 50,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 250_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);

    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(low!.volumeFactor).toBeCloseTo(
      Math.pow(
        Math.log1p(25) / Math.log1p(ON_CHAIN_REPUTATION_VOLUME_LOG_TARGET_USDC),
        ON_CHAIN_REPUTATION_VOLUME_EXPONENT,
      ),
      6,
    );
    expect(high!.score).toBeGreaterThan(low!.score);
  });

  it('penalizes ghost-channel rate', () => {
    const clean = computeOnChainReputationScore(peer({
      onChainChannelCount: 50,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const ghosted = computeOnChainReputationScore(peer({
      onChainChannelCount: 50,
      onChainGhostCount: 5,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);

    expect(clean).toBeGreaterThan(ghosted ?? 0);
    expect(ghosted).toBeCloseTo(70.762, 3);
  });

  it('uses staking age as a small maturity signal when available', () => {
    const freshStake = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakedAtSec: NOW_SEC,
    }), NOW_MS);
    const matureStake = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakedAtSec: NOW_SEC - 30 * 86_400,
    }), NOW_MS);
    const unknownStake = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);

    expect(freshStake).toBeCloseTo(95, 6);
    expect(matureStake).toBeCloseTo(100, 6);
    expect(unknownStake).toBeCloseTo(matureStake ?? 0, 6);
  });

  it('applies a recency floor when settlement is stale', () => {
    const recent = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const stale = computeOnChainReputationScore(peer({
      onChainChannelCount: 120,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC - 365 * 86_400,
    }), NOW_MS);

    expect(recent).toBeCloseTo(100, 6);
    expect(stale).toBeCloseTo(96.25, 6);
  });

  it('ranks very high settled volume first among mature peers', () => {
    const darkSignal = computeOnChainReputationScore(peer({
      onChainChannelCount: 639,
      onChainGhostCount: 9,
      onChainTotalVolumeUsdcMicros: 1_703_960_398,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const openForge = computeOnChainReputationScore(peer({
      onChainChannelCount: 230,
      onChainGhostCount: 1,
      onChainTotalVolumeUsdcMicros: 547_450_547,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const theSeeder = computeOnChainReputationScore(peer({
      onChainChannelCount: 268,
      onChainGhostCount: 1,
      onChainTotalVolumeUsdcMicros: 382_242_981,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);
    const openAnt = computeOnChainReputationScore(peer({
      onChainChannelCount: 73,
      onChainGhostCount: 0,
      onChainTotalVolumeUsdcMicros: 35_416_982,
      onChainLastSettledAtSec: NOW_SEC,
    }), NOW_MS);

    expect(darkSignal).toBeGreaterThan(openForge ?? 0);
    expect(openForge).toBeGreaterThan(theSeeder ?? 0);
    expect(openAnt).toBeLessThan(40);
  });
});
