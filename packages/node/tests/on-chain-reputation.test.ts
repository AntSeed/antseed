import { describe, expect, it } from 'vitest';
import {
  buildSybilContext,
  computeVerificationScoreBonus,
  computeOnChainReputationScore,
  computeOnChainScore,
  computeOnChainSybilRisk,
  computeOnChainTrust,
  computeOnChainTrustBreakdown,
  ON_CHAIN_VERIFICATION_DOMAIN_POINTS,
  ON_CHAIN_VERIFICATION_GITHUB_POINTS,
  ON_CHAIN_VERIFICATION_MAX_POINTS,
  ON_CHAIN_TRUST_NO_STAKE_FACTOR,
  ON_CHAIN_TRUST_RECENCY_DORMANT_FACTOR,
  scoreFromTrust,
  SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION,
} from '../src/reputation/on-chain-reputation.js';
import type { PeerInfo } from '../src/types/peer.js';

const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_SEC = Math.floor(NOW_MS / 1000);

const STUB_PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };

function makePeer(stats: Partial<PeerInfo> & { peerId?: string }): PeerInfo {
  const { peerId, ...rest } = stats;
  return {
    peerId: (peerId ?? 'a'.repeat(40)) as PeerInfo['peerId'],
    lastSeen: NOW_MS,
    providers: ['openai'],
    ...rest,
  } as PeerInfo;
}

function verifiedDomain(domain: string, verified = true) {
  return {
    domain,
    peerId: 'a'.repeat(40),
    verified,
    checkedAtMs: NOW_MS,
    attempts: [],
  };
}

function verifiedGithub(username: string, verified = true) {
  return {
    username,
    repository: username,
    peerId: 'a'.repeat(40),
    verified,
    checkedAtMs: NOW_MS,
  };
}

describe('computeOnChainTrust', () => {
  it('returns null when no on-chain stats are available', () => {
    expect(computeOnChainTrust(makePeer({}), NOW_MS)).toBeNull();
  });

  it('returns null for metadata-only channel counts', () => {
    expect(computeOnChainTrust(makePeer({ onChainChannelCount: 10 }), NOW_MS)).toBeNull();
  });

  it('returns 0 when the peer has channels but zero volume', () => {
    const trust = computeOnChainTrust(
      makePeer({
        onChainChannelCount: 10,
        onChainTotalVolumeUsdcMicros: 0,
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    );
    expect(trust).toBe(0);
  });

  it('uses settled volume as raw trust instead of channels × volume', () => {
    const stakedAt = NOW_SEC - 60 * 86_400;
    const small = computeOnChainTrust(
      makePeer({
        onChainChannelCount: 10,
        onChainTotalVolumeUsdcMicros: 20_000_000, // $20, avg $2
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: stakedAt,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    );
    const big = computeOnChainTrust(
      makePeer({
        onChainChannelCount: 100,
        onChainTotalVolumeUsdcMicros: 200_000_000, // $200, avg $2
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: stakedAt,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    );
    expect(small).toBeCloseTo(20, 6);
    expect(big).toBeCloseTo(200, 6);
    expect(big! / small!).toBeCloseTo(10, 6); // 10x volume only
  });

  it('caps newly-staked volume credit and matures it over time', () => {
    const young = computeOnChainTrustBreakdown(
      makePeer({
        onChainChannelCount: 1000,
        onChainTotalVolumeUsdcMicros: 10_000_000_000, // $10k
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: NOW_SEC - 1 * 86_400,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    )!;
    const mature = computeOnChainTrustBreakdown(
      makePeer({
        onChainChannelCount: 1000,
        onChainTotalVolumeUsdcMicros: 10_000_000_000,
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: NOW_SEC - 90 * 86_400,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    )!;

    expect(young.creditedVolumeUsdc).toBeCloseTo(150, 6); // $25 + 1d × $125
    expect(mature.creditedVolumeUsdc).toBeCloseTo(10_000, 6);
    expect(young.trust).toBeLessThan(mature.trust);
  });

  it('does not treat a verified staked account with an unknown timestamp as brand new', () => {
    const breakdown = computeOnChainTrustBreakdown(
      makePeer({
        onChainChannelCount: 1_208,
        onChainGhostCount: 16,
        onChainTotalVolumeUsdcMicros: 5_428_786_420,
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: 0,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    )!;

    expect(breakdown.daysSinceStaked).toBeNull();
    expect(breakdown.volumeCreditCapUsdc).toBe(3_775);
    expect(breakdown.creditedVolumeUsdc).toBe(3_775);
    expect(computeOnChainReputationScore({
      ...makePeer({
        onChainChannelCount: 1_208,
        onChainGhostCount: 16,
        onChainTotalVolumeUsdcMicros: 5_428_786_420,
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakedAtSec: 0,
        onChainStakeUsdcMicros: 10_000_000,
      }),
    }, NOW_MS)).toBeGreaterThan(80);
  });

  it('caps ticketBonus at TICKET_MAX (one fat channel cannot pump the score)', () => {
    // One channel at $100 → avg $100 → ticket would be 50× without the cap.
    const b = computeOnChainTrustBreakdown(
      makePeer({
        onChainChannelCount: 1,
        onChainTotalVolumeUsdcMicros: 100_000_000,
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    );
    expect(b).not.toBeNull();
    expect(b!.ticketBonus).toBe(1.5); // ON_CHAIN_TRUST_TICKET_MAX
    expect(b!.trust).toBeCloseTo(25, 6); // no stakedAt → initial volume credit only
    expect(b!.ticketGate).toBe(0.75); // one very large channel is penalized in score
  });

  it('floors ticketBonus at TICKET_MIN (microcent peers retain a meaningful score)', () => {
    const b = computeOnChainTrustBreakdown(
      makePeer({
        onChainChannelCount: 100,
        onChainTotalVolumeUsdcMicros: 1_000_000, // $1 total → avg $0.01
        onChainLastSettledAtSec: NOW_SEC,
        onChainStakeUsdcMicros: 10_000_000,
      }),
      NOW_MS,
    );
    expect(b!.ticketBonus).toBe(0.5); // ON_CHAIN_TRUST_TICKET_MIN
  });

  it('applies the recency gate in discrete bands', () => {
    const base = {
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 200_000_000,
      onChainStakeUsdcMicros: 10_000_000,
    } satisfies Partial<PeerInfo>;
    const fresh   = computeOnChainTrustBreakdown(makePeer({ ...base, onChainLastSettledAtSec: NOW_SEC }), NOW_MS)!;
    const dormant = computeOnChainTrustBreakdown(makePeer({ ...base, onChainLastSettledAtSec: NOW_SEC - 30 * 86_400 }), NOW_MS)!;
    const stale   = computeOnChainTrustBreakdown(makePeer({ ...base, onChainLastSettledAtSec: NOW_SEC - 90 * 86_400 }), NOW_MS)!;
    const never   = computeOnChainTrustBreakdown(makePeer({ ...base }), NOW_MS)!;

    expect(fresh.recencyGate).toBe(1);
    expect(dormant.recencyGate).toBe(ON_CHAIN_TRUST_RECENCY_DORMANT_FACTOR);
    expect(stale.recencyGate).toBe(0);
    expect(never.recencyGate).toBe(0);
    expect(computeOnChainScore(makePeer({ ...base, onChainLastSettledAtSec: NOW_SEC - 90 * 86_400 }), undefined, NOW_MS)).toBe(0);
  });

  it('applies a presence-only stake gate (any stake \u2265 $1 = full credit)', () => {
    const base = {
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 200_000_000,
      onChainLastSettledAtSec: NOW_SEC,
    } satisfies Partial<PeerInfo>;
    const small  = computeOnChainTrustBreakdown(makePeer({ ...base, onChainStakeUsdcMicros: 1_000_000   }), NOW_MS)!;
    const large  = computeOnChainTrustBreakdown(makePeer({ ...base, onChainStakeUsdcMicros: 100_000_000 }), NOW_MS)!;
    const noStake = computeOnChainTrustBreakdown(makePeer({ ...base }), NOW_MS)!;

    expect(small.stakeGate).toBe(1);
    expect(large.stakeGate).toBe(1); // amount doesn't matter
    expect(small.trust).toBeCloseTo(large.trust, 6);
    expect(noStake.stakeGate).toBe(ON_CHAIN_TRUST_NO_STAKE_FACTOR);
    expect(noStake.trust).toBeCloseTo(large.trust, 6);
    expect(computeOnChainScore(makePeer({ ...base, onChainStakeUsdcMicros: 0 }), undefined, NOW_MS)!)
      .toBeCloseTo(computeOnChainScore(makePeer({ ...base, onChainStakeUsdcMicros: 100_000_000 }), undefined, NOW_MS)! * ON_CHAIN_TRUST_NO_STAKE_FACTOR, 6);
  });
});

describe('scoreFromTrust', () => {
  it('returns 0 for trust 0 / negative / non-finite', () => {
    expect(scoreFromTrust(0)).toBe(0);
    expect(scoreFromTrust(-1)).toBe(0);
    expect(scoreFromTrust(Number.NaN)).toBe(0);
  });

  it('hits roughly 75 at $1k trust and saturates at 100 around $10k', () => {
    expect(scoreFromTrust(1_000)).toBeGreaterThan(74);
    expect(scoreFromTrust(1_000)).toBeLessThan(76);
    expect(scoreFromTrust(10_000)).toBe(100);
    expect(scoreFromTrust(1_000_000)).toBe(100);
  });

  it('is monotonically increasing', () => {
    let prev = scoreFromTrust(1);
    for (const t of [10, 100, 1_000, 10_000]) {
      const next = scoreFromTrust(t);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });
});

describe('buildSybilContext', () => {
  it('counts services across all peers (case-sensitive)', () => {
    const a = makePeer({
      peerId: 'a'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'claude': STUB_PRICING } },
      },
    });
    const b = makePeer({
      peerId: 'b'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax': STUB_PRICING } },
      },
    });
    const ctx = buildSybilContext([a, b]);
    expect(ctx.serviceCounts.get('gpt-5')).toBe(2);
    expect(ctx.serviceCounts.get('claude')).toBe(1);
    expect(ctx.serviceCounts.get('minimax')).toBe(1);
  });
});

describe('computeOnChainSybilRisk', () => {
  const NETWORK_PEERS: PeerInfo[] = [
    makePeer({
      peerId: 'a'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'claude': STUB_PRICING } },
      },
    }),
    makePeer({
      peerId: 'b'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    }),
  ];
  const ctx = buildSybilContext(NETWORK_PEERS);

  it('fires narrow_custom for a single exclusive service', () => {
    const peer = makePeer({
      onChainChannelCount: 50,
      onChainTotalVolumeUsdcMicros: 100_000_000,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'bespoke-model-7': STUB_PRICING } },
      },
    });
    const customCtx = buildSybilContext([peer, ...NETWORK_PEERS]);
    const { risk, flags, signals } = computeOnChainSybilRisk(peer, customCtx, NOW_MS);
    expect(signals.narrow_custom).toBe(1.0);
    expect(flags).toContain('narrow_custom');
    expect(risk).toBeGreaterThan(0);
  });

  it('does NOT fire burn_rate alone on popular brand services (Dark Signal case)', () => {
    // 46 channels/day on widely-offered services → no narrow_custom → no burn_rate flag.
    const stakedAt = NOW_SEC - 27 * 86_400;
    const peer = makePeer({
      onChainChannelCount: 1265, // 1265 / 27 ≈ 46 ch/day
      onChainTotalVolumeUsdcMicros: 3_000_000_000,
      onChainStakedAtSec: stakedAt,
      onChainStakeUsdcMicros: 10_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    const { signals } = computeOnChainSybilRisk(peer, ctx, NOW_MS);
    expect(signals.narrow_custom).toBe(0);
    expect(signals.burn_rate).toBe(0);
  });

  it('fires burn_rate when channels/day is high AND narrow_custom is set', () => {
    const stakedAt = NOW_SEC - 6 * 86_400; // young
    const peer = makePeer({
      onChainChannelCount: 429, // 429 / 6 ≈ 71 ch/day
      onChainTotalVolumeUsdcMicros: 382_000_000,
      onChainStakedAtSec: stakedAt,
      onChainStakeUsdcMicros: 50_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'medical-reasoning-r1': STUB_PRICING } },
      },
    });
    const customCtx = buildSybilContext([peer, ...NETWORK_PEERS]);
    const { signals, risk } = computeOnChainSybilRisk(peer, customCtx, NOW_MS);
    expect(signals.narrow_custom).toBe(1.0);
    expect(signals.burn_rate).toBeGreaterThan(0.5); // strongly fired
    expect(signals.young_high_vol).toBeGreaterThan(0);
    expect(risk).toBeGreaterThan(0.5);
  });

  it('fires subfloor_ticket only above the channel floor, suppressed for cheap-advertised peers', () => {
    // Below SYBIL_SUBFLOOR_MIN_CHANNELS — no flag even at micro avg.
    const tiny = makePeer({
      onChainChannelCount: 10,
      onChainTotalVolumeUsdcMicros: 100_000,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    expect(computeOnChainSybilRisk(tiny, ctx, NOW_MS).signals.subfloor_ticket).toBe(0);

    // Above the floor, micro avg, normal pricing → fires.
    const sub = makePeer({
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 10_000_000, // avg $0.10
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    expect(computeOnChainSybilRisk(sub, ctx, NOW_MS).signals.subfloor_ticket).toBeGreaterThan(0.5);

    // Same shape but the peer advertises sub-floor input prices → suppressed.
    const cheap = makePeer({
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 10_000_000,
      defaultInputUsdPerMillion: SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION - 0.001,
      defaultOutputUsdPerMillion: 0.1,
      providerPricing: {
        openai: {
          defaults: {
            inputUsdPerMillion: SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION - 0.001,
            outputUsdPerMillion: 0.1,
          },
          services: { 'gpt-5': STUB_PRICING },
        },
      },
    });
    expect(computeOnChainSybilRisk(cheap, ctx, NOW_MS).signals.subfloor_ticket).toBe(0);
  });
});

describe('computeOnChainScore — composed display value', () => {
  it('returns null when on-chain stats are absent', () => {
    expect(computeOnChainScore(makePeer({}))).toBeNull();
  });

  it('returns null when only external verification is available', () => {
    expect(computeOnChainScore(makePeer({
      verificationResults: {
        verified: true,
        checkedAtMs: NOW_MS,
        domains: [verifiedDomain('example.com')],
        github: [verifiedGithub('octocat')],
      },
    }), undefined, NOW_MS)).toBeNull();
  });

  it('returns sybil-attenuated score when a context is provided', () => {
    const peer = makePeer({
      onChainChannelCount: 50,
      onChainTotalVolumeUsdcMicros: 100_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakeUsdcMicros: 10_000_000,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'only-mine': STUB_PRICING } },
      },
    });
    const ctx = buildSybilContext([peer]); // only this peer in the network → narrow_custom = 1
    const noCtxScore = computeOnChainScore(peer, undefined, NOW_MS);
    const ctxScore = computeOnChainScore(peer, ctx, NOW_MS);
    expect(noCtxScore).not.toBeNull();
    expect(ctxScore).not.toBeNull();
    expect(ctxScore!).toBeLessThan(noCtxScore!);
    // narrow_custom alone weights 0.25 → expect ~25% attenuation.
    expect(ctxScore! / noCtxScore!).toBeCloseTo(0.75, 1);
  });

  it('adds a modest capped bonus for verified domain and GitHub claims', () => {
    const base = makePeer({
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 1_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakedAtSec: NOW_SEC - 90 * 86_400,
      onChainStakeUsdcMicros: 10_000_000,
    });
    const withDomain = makePeer({
      ...base,
      verificationResults: {
        verified: true,
        checkedAtMs: NOW_MS,
        domains: [verifiedDomain('example.com')],
        github: [],
      },
    });
    const withGithub = makePeer({
      ...base,
      verificationResults: {
        verified: true,
        checkedAtMs: NOW_MS,
        domains: [],
        github: [verifiedGithub('octocat')],
      },
    });
    const withBoth = makePeer({
      ...base,
      verificationResults: {
        verified: true,
        checkedAtMs: NOW_MS,
        domains: [verifiedDomain('example.com')],
        github: [verifiedGithub('octocat')],
      },
    });

    const baseScore = computeOnChainScore(base, undefined, NOW_MS)!;
    expect(computeVerificationScoreBonus(withDomain)).toBe(ON_CHAIN_VERIFICATION_DOMAIN_POINTS);
    expect(computeVerificationScoreBonus(withGithub)).toBe(ON_CHAIN_VERIFICATION_GITHUB_POINTS);
    expect(computeVerificationScoreBonus(withBoth)).toBe(ON_CHAIN_VERIFICATION_MAX_POINTS);
    expect(computeOnChainScore(withDomain, undefined, NOW_MS)).toBeCloseTo(baseScore + 5, 6);
    expect(computeOnChainScore(withGithub, undefined, NOW_MS)).toBeCloseTo(baseScore + 3, 6);
    expect(computeOnChainScore(withBoth, undefined, NOW_MS)).toBeCloseTo(baseScore + 8, 6);
  });

  it('ignores failed verification claims and clamps final score to 100', () => {
    const base = makePeer({
      onChainChannelCount: 1000,
      onChainTotalVolumeUsdcMicros: 10_000_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakedAtSec: NOW_SEC - 90 * 86_400,
      onChainStakeUsdcMicros: 10_000_000,
    });
    const failed = makePeer({
      ...base,
      verificationResults: {
        verified: false,
        checkedAtMs: NOW_MS,
        domains: [verifiedDomain('example.com', false)],
        github: [verifiedGithub('octocat', false)],
      },
    });
    const manyVerified = makePeer({
      ...base,
      verificationResults: {
        verified: true,
        checkedAtMs: NOW_MS,
        domains: [
          verifiedDomain('example.com'),
          verifiedDomain('example.org'),
        ],
        github: [
          verifiedGithub('octocat'),
          verifiedGithub('antseed'),
        ],
      },
    });

    expect(computeVerificationScoreBonus(failed)).toBe(0);
    expect(computeOnChainScore(failed, undefined, NOW_MS))
      .toBe(computeOnChainScore(base, undefined, NOW_MS));
    expect(computeVerificationScoreBonus(manyVerified)).toBe(ON_CHAIN_VERIFICATION_MAX_POINTS);
    expect(computeOnChainScore(manyVerified, undefined, NOW_MS)).toBe(100);
  });
});

describe('computeOnChainReputationScore — back-compat shim', () => {
  it('matches computeOnChainScore without context', () => {
    const peer = makePeer({
      onChainChannelCount: 50,
      onChainTotalVolumeUsdcMicros: 100_000_000,
      onChainLastSettledAtSec: NOW_SEC,
      onChainStakeUsdcMicros: 10_000_000,
    });
    expect(computeOnChainReputationScore(peer, NOW_MS))
      .toBe(computeOnChainScore(peer, undefined, NOW_MS));
  });
});

describe('Real-network ordering (locks in the Auralis-cluster catch)', () => {
  // Fixtures from the Auralis wash-trading cluster caught during design.
  const STAKED_27D_AGO = NOW_SEC - 27 * 86_400;
  const STAKED_6D_AGO  = NOW_SEC -  6 * 86_400;
  const STAKED_5D_AGO  = NOW_SEC -  5 * 86_400;

  const darkSignal = makePeer({
    peerId: '1111111111111111111111111111111111111111',
    onChainChannelCount: 1263,
    onChainTotalVolumeUsdcMicros: 3_035_830_000,
    onChainStakeUsdcMicros: 10_000_000,
    onChainStakedAtSec: STAKED_27D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax-m2.5': STUB_PRICING } },
    },
  });
  const openForge = makePeer({
    peerId: '2222222222222222222222222222222222222222',
    onChainChannelCount: 290,
    onChainTotalVolumeUsdcMicros: 1_116_980_000,
    onChainStakeUsdcMicros: 10_000_000,
    onChainStakedAtSec: NOW_SEC - 29 * 86_400,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax-m2.5': STUB_PRICING } },
    },
  });
  const auralisMedical = makePeer({
    peerId: '3333333333333333333333333333333333333333',
    onChainChannelCount: 429,
    onChainTotalVolumeUsdcMicros: 382_300_000,
    onChainStakeUsdcMicros: 50_000_000,
    onChainStakedAtSec: STAKED_6D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'medical-reasoning-r1': STUB_PRICING } },
    },
  });
  const auralisLegal = makePeer({
    peerId: '4444444444444444444444444444444444444444',
    onChainChannelCount: 90,
    onChainTotalVolumeUsdcMicros: 245_580_000,
    onChainStakeUsdcMicros: 50_000_000,
    onChainStakedAtSec: STAKED_5D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'legal-vl1': STUB_PRICING } },
    },
  });
  const peers = [darkSignal, openForge, auralisMedical, auralisLegal];
  const ctx = buildSybilContext(peers);

  it('Auralis cluster gets flagged with sybil signals', () => {
    const med = computeOnChainSybilRisk(auralisMedical, ctx, NOW_MS);
    const leg = computeOnChainSybilRisk(auralisLegal, ctx, NOW_MS);
    expect(med.flags).toContain('narrow_custom');
    expect(med.flags).toContain('burn_rate');
    expect(med.flags).toContain('young_high_vol');
    expect(med.risk).toBeGreaterThan(0.5);

    expect(leg.flags).toContain('narrow_custom');
    expect(leg.risk).toBeGreaterThan(0.20);
    expect(leg.risk).toBeLessThan(0.40);
  });

  it('legitimate peers (Dark Signal, Open Forge) carry no flags', () => {
    const ds = computeOnChainSybilRisk(darkSignal, ctx, NOW_MS);
    const of = computeOnChainSybilRisk(openForge, ctx, NOW_MS);
    expect(ds.flags).toHaveLength(0);
    expect(of.flags).toHaveLength(0);
    expect(ds.risk).toBe(0);
    expect(of.risk).toBe(0);
  });

  it('displayed score ranks Auralis siblings BELOW any legit peer', () => {
    const dsScore  = computeOnChainScore(darkSignal,     ctx, NOW_MS)!;
    const ofScore  = computeOnChainScore(openForge,      ctx, NOW_MS)!;
    const medScore = computeOnChainScore(auralisMedical, ctx, NOW_MS)!;
    const legScore = computeOnChainScore(auralisLegal,   ctx, NOW_MS)!;

    expect(dsScore).toBeGreaterThan(ofScore);  // Dark Signal > Open Forge
    expect(ofScore).toBeGreaterThan(medScore); // Open Forge > Auralis Medical
    expect(ofScore).toBeGreaterThan(legScore); // Open Forge > Auralis Legal
    expect(dsScore).toBeGreaterThan(legScore);
    expect(dsScore).toBeGreaterThan(medScore);
  });
});
