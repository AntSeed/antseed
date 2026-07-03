import { describe, expect, it } from 'vitest';
import {
  computeCohortConsensus,
  computeCohortVerdicts,
  scoreAgainstConsensus,
} from '../src/cohort.js';
import { generateProbeSet } from '../src/probe-bank.js';
import type { KbfProbe, SellerObservation } from '../src/types.js';

function makeProbes(count: number): KbfProbe[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `test:probe-${i}`,
    name: `probe ${i}`,
    domain: 'test_domain',
    template: `Test quantity ${i} is ___.`,
    consensus: 100 + i, // advisory; cohort consensus is what matters
    range: [0, 100000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 1 },
  }));
}

function observation(
  sellerPeerId: string,
  agentId: number,
  answers: Array<number | null>,
): SellerObservation {
  return {
    sellerPeerId,
    agentId,
    answers,
    requestIds: [`req-${sellerPeerId}`],
  };
}

/** Honest sellers answer `100 + i`; the substitute answers `500 + i`. */
function makeCohort(honest: number, probeCount: number): SellerObservation[] {
  const observations: SellerObservation[] = [];
  for (let s = 0; s < honest; s++) {
    observations.push(
      observation(
        `0xhonest${s}`,
        s + 1,
        Array.from({ length: probeCount }, (_, i) => 100 + i),
      ),
    );
  }
  return observations;
}

describe('computeCohortConsensus', () => {
  it('finds the majority cluster per probe', () => {
    const probes = makeProbes(2);
    const observations = [
      observation('a', 1, [100, 101]),
      observation('b', 2, [100.5, 101.2]),
      observation('c', 3, [99.8, 101]),
      observation('d', 4, [500, 900]),
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.validProbeIndices).toEqual([0, 1]);
    expect(consensus.values[0]).toBeCloseTo(100, 5);
    expect(consensus.values[1]).toBeCloseTo(101, 5);
    expect(consensus.supportCounts).toEqual([3, 3]);
    expect(consensus.parseableCounts).toEqual([4, 4]);
  });

  it('requires a strict majority of parseable answers', () => {
    const probes = makeProbes(1);
    // 2 vs 2 split: largest cluster is not a strict majority.
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [500]),
      observation('d', 4, [500]),
    ];
    const consensus = computeCohortConsensus(observations, probes, { minConsensusSellers: 2 });
    expect(consensus.values[0]).toBeNull();
    expect(consensus.validProbeIndices).toEqual([]);
  });

  it('requires at least minConsensusSellers in the winning cluster', () => {
    const probes = makeProbes(1);
    // 2 agree out of 3 parseable: strict majority but below default min of 3.
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [500]),
    ];
    expect(computeCohortConsensus(observations, probes).values[0]).toBeNull();
    expect(
      computeCohortConsensus(observations, probes, { minConsensusSellers: 2 }).values[0],
    ).toBeCloseTo(100, 5);
  });

  it('ignores unparseable and out-of-range answers', () => {
    const probes = makeProbes(1);
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [100]),
      observation('d', 4, [null]),
      observation('e', 5, [-50]), // out of range [0, 100000]
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.parseableCounts).toEqual([3]);
    expect(consensus.values[0]).toBeCloseTo(100, 5);
  });

  it('yields empty consensus when all sellers disagree on everything', () => {
    const probes = makeProbes(3);
    const observations = [
      observation('a', 1, [1, 10, 100]),
      observation('b', 2, [2000, 3000, 4000]),
      observation('c', 3, [50000, 60000, 70000]),
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.validProbeIndices).toEqual([]);
    expect(consensus.values).toEqual([null, null, null]);
  });
});

describe('scoreAgainstConsensus', () => {
  it('scores over consensus-valid probes only', () => {
    const probes = makeProbes(3);
    const observations = [
      observation('a', 1, [100, 5, 300]),
      observation('b', 2, [100, 900, 300]),
      observation('c', 3, [100, 7000, 300.5]),
    ];
    const consensus = computeCohortConsensus(observations, probes);
    // Probe 1 has no consensus (all disagree); probes 0 and 2 do.
    expect(consensus.validProbeIndices).toEqual([0, 2]);
    const mv = scoreAgainstConsensus(observation('d', 4, [100.4, 42, 999]), consensus, probes);
    expect(mv).toEqual([1, 0]);
    const mvNull = scoreAgainstConsensus(observation('e', 5, [null, 42, null]), consensus, probes);
    expect(mvNull).toEqual([null, null]);
  });
});

describe('computeCohortVerdicts', () => {
  it('flags the substitute DIFF and honest sellers SAME (10 honest + 1 liar)', () => {
    const probeCount = 24;
    const probes = makeProbes(probeCount);
    const observations = makeCohort(10, probeCount);
    // The substitute answers a consistently different value on every probe.
    observations.push(
      observation(
        '0xliar',
        99,
        Array.from({ length: probeCount }, (_, i) => 500 + i),
      ),
    );

    const result = computeCohortVerdicts(observations, probes);
    expect(result.consensusProbeCount).toBe(probeCount);
    expect(result.p0).toBeCloseTo(0.02, 10); // epsilon floor over median 0

    const liar = result.verdicts.find((v) => v.sellerPeerId === '0xliar')!;
    expect(liar.verdict).toBe('DIFF');
    expect(liar.stats.mismatches).toBe(probeCount);
    expect(liar.stats.pValue).toBeLessThan(1e-20);

    for (const v of result.verdicts.filter((x) => x.sellerPeerId !== '0xliar')) {
      expect(v.verdict).toBe('SAME');
      expect(v.stats.agreementRate).toBe(1);
    }
    expect(result.perSellerAgreementRate['0xliar']).toBe(0);
  });

  it('tolerates honest noise while still catching the liar', () => {
    const probeCount = 30;
    const probes = makeProbes(probeCount);
    const observations = makeCohort(8, probeCount);
    // One honest seller misses two probes (unparseable) and flubs one.
    observations[0]!.answers[3] = null;
    observations[0]!.answers[7] = null;
    observations[0]!.answers[11] = 9999;
    observations.push(
      observation(
        '0xliar',
        99,
        Array.from({ length: probeCount }, (_, i) => 700 + i),
      ),
    );

    const result = computeCohortVerdicts(observations, probes);
    const noisyHonest = result.verdicts.find((v) => v.sellerPeerId === '0xhonest0')!;
    expect(noisyHonest.verdict).toBe('SAME');
    expect(result.verdicts.find((v) => v.sellerPeerId === '0xliar')!.verdict).toBe('DIFF');
  });

  it('cohort of 1-2 sellers → all UNDETERMINED', () => {
    const probes = makeProbes(20);
    for (const size of [1, 2]) {
      const result = computeCohortVerdicts(makeCohort(size, 20), probes);
      expect(result.verdicts).toHaveLength(size);
      for (const v of result.verdicts) {
        expect(v.verdict).toBe('UNDETERMINED');
        expect(v.verdictReason).toMatch(/too small/);
      }
      expect(result.p0).toBeNull();
    }
  });

  it('all sellers disagreeing on everything → UNDETERMINED for all', () => {
    const probes = makeProbes(15);
    const observations = [
      observation('a', 1, Array.from({ length: 15 }, (_, i) => i * 3)),
      observation('b', 2, Array.from({ length: 15 }, (_, i) => 1000 + i * 7)),
      observation('c', 3, Array.from({ length: 15 }, (_, i) => 90000 - i * 11)),
    ];
    const result = computeCohortVerdicts(observations, probes);
    expect(result.consensusProbeCount).toBe(0);
    for (const v of result.verdicts) {
      expect(v.verdict).toBe('UNDETERMINED');
    }
  });

  it('UNDETERMINED when consensus probes are below minConsensusProbes', () => {
    const probeCount = 8; // below the default minimum of 10
    const probes = makeProbes(probeCount);
    const result = computeCohortVerdicts(makeCohort(5, probeCount), probes);
    for (const v of result.verdicts) {
      expect(v.verdict).toBe('UNDETERMINED');
      expect(v.verdictReason).toMatch(/consensus probes/);
    }
    const relaxed = computeCohortVerdicts(makeCohort(5, probeCount), probes, {
      minConsensusProbes: 5,
    });
    for (const v of relaxed.verdicts) {
      expect(v.verdict).toBe('SAME');
    }
  });

  it('a seller below coverage is UNDETERMINED, others still get verdicts', () => {
    const probeCount = 20;
    const probes = makeProbes(probeCount);
    const observations = makeCohort(6, probeCount);
    // Seller 0 answers only 4 of 20 probes → coverage 0.2 < 0.5.
    observations[0]!.answers = observations[0]!.answers.map((a, i) => (i < 4 ? a : null));
    const result = computeCohortVerdicts(observations, probes);
    expect(result.verdicts.find((v) => v.sellerPeerId === '0xhonest0')!.verdict).toBe(
      'UNDETERMINED',
    );
    for (const v of result.verdicts.filter((x) => x.sellerPeerId !== '0xhonest0')) {
      expect(v.verdict).toBe('SAME');
    }
  });

  it('is deterministic across runs and observation copies', () => {
    const probeSet = generateProbeSet({
      service: 'kimi-k2',
      count: 20,
      seed: 'cohort-determinism',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const observations = makeCohort(7, 20);
    observations.push(
      observation('0xliar', 99, Array.from({ length: 20 }, (_, i) => 555 + i)),
    );
    const a = computeCohortVerdicts(observations, probeSet.probes);
    const b = computeCohortVerdicts(
      observations.map((o) => ({ ...o, answers: [...o.answers] })),
      probeSet.probes,
    );
    expect(a).toEqual(b);
  });
});
