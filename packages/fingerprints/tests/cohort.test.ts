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

  it('counts one vote per seller: duplicate observations cannot sway consensus', () => {
    const probes = makeProbes(1);
    // Three honest sellers vs one attacker replaying its observation 3 times.
    // Counting duplicates would give 500 a 3-3 split (no strict majority);
    // deduped, the honest 100-cluster is a 3-of-4 majority.
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [100]),
      observation('0xattacker', 9, [500]),
      observation('0xattacker', 9, [500]),
      observation('0xATTACKER', 9, [500]), // case-variant peer id counts as the same seller
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.parseableCounts).toEqual([4]);
    expect(consensus.values[0]).toBeCloseTo(100, 5);
    expect(consensus.supportCounts).toEqual([3]);
  });

  it('a repeated agentId under fresh peer ids is still one vote', () => {
    const probes = makeProbes(1);
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [100]),
      observation('0xsybil-1', 9, [500]),
      observation('0xsybil-2', 9, [500]),
      observation('0xsybil-3', 9, [500]),
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.parseableCounts).toEqual([4]);
    expect(consensus.values[0]).toBeCloseTo(100, 5);
  });

  it('emits a consensus value consistent with support and scoring (wide-cluster case)', () => {
    // {0,0,40,80,80,80} with abs-40 tolerance: every answer is within 40 of
    // candidate 40, so the raw cluster spans all six sellers — but its median
    // 60 only covers {40,80,80,80}. Support must reflect the EMITTED value.
    const probes: KbfProbe[] = [
      {
        id: 'test:wide',
        name: 'wide',
        domain: 'test_domain',
        template: 'Wide quantity is ___.',
        consensus: 0,
        range: [-1000, 1000],
        tolerance: { mode: 'absolute', value: 40 },
      },
    ];
    const observations = [
      observation('a', 1, [0]),
      observation('b', 2, [0]),
      observation('c', 3, [40]),
      observation('d', 4, [80]),
      observation('e', 5, [80]),
      observation('f', 6, [80]),
    ];
    const consensus = computeCohortConsensus(observations, probes);
    expect(consensus.values[0]).toBe(60);
    expect(consensus.supportCounts).toEqual([4]); // NOT the raw 6-member cluster
    expect(consensus.validProbeIndices).toEqual([0]);

    // supportCounts[i] === number of sellers whose match entry is 1.
    const matchEntries = observations.map(
      (o) => scoreAgainstConsensus(o, consensus, probes)[0],
    );
    expect(matchEntries).toEqual([0, 0, 1, 1, 1, 1]);
    expect(matchEntries.filter((e) => e === 1)).toHaveLength(consensus.supportCounts[0]!);
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

  it('duplicate observations cannot fabricate the minimum cohort size', () => {
    const probes = makeProbes(20);
    // One seller's observation replayed 5 times is still a cohort of 1.
    const solo = observation('0xonly', 1, Array.from({ length: 20 }, (_, i) => 100 + i));
    const result = computeCohortVerdicts([solo, solo, solo, solo, solo], probes);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.verdict).toBe('UNDETERMINED');
    expect(result.verdicts[0]!.verdictReason).toMatch(/too small/);
  });

  it('a duplicated seller receives exactly one verdict entry', () => {
    const probeCount = 24;
    const probes = makeProbes(probeCount);
    const observations = makeCohort(5, probeCount);
    // The liar submits its observation three times.
    const liar = observation(
      '0xliar',
      99,
      Array.from({ length: probeCount }, (_, i) => 500 + i),
    );
    observations.push(liar, liar, { ...liar, answers: [...liar.answers] });

    const result = computeCohortVerdicts(observations, probes);
    expect(result.verdicts.filter((v) => v.sellerPeerId === '0xliar')).toHaveLength(1);
    expect(result.verdicts).toHaveLength(6);
    expect(result.verdicts.find((v) => v.sellerPeerId === '0xliar')!.verdict).toBe('DIFF');
  });

  it('surfaces every dropped duplicate through onWarning (peer-id and agentId)', () => {
    const probeCount = 24;
    const probes = makeProbes(probeCount);
    const observations = makeCohort(3, probeCount); // agents 1..3
    const answers = Array.from({ length: probeCount }, (_, i) => 100 + i);
    // Same seller replayed under a case-variant peer id…
    observations.push(observation('0xHONEST0', 9, answers));
    // …and a DISTINCT peer id colliding on an already-used agentId. The
    // collapse is intentional (on-chain identity is the agentId) but callers
    // that did not resolve agentIds on-chain must be able to see it happen.
    observations.push(observation('0xdistinct-peer', 2, answers));

    const warnings: string[] = [];
    const result = computeCohortVerdicts(observations, probes, {
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/0xHONEST0/);
    expect(warnings[0]).toMatch(/repeated sellerPeerId/);
    expect(warnings[1]).toMatch(/0xdistinct-peer/);
    expect(warnings[1]).toMatch(/agentId 2/);
    // Dropped observations receive no verdict entry; the rest are unaffected.
    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.some((v) => v.sellerPeerId === '0xdistinct-peer')).toBe(false);

    // A fully unique cohort never warns.
    const clean: string[] = [];
    computeCohortVerdicts(makeCohort(3, probeCount), probes, {
      onWarning: (message) => clean.push(message),
    });
    expect(clean).toEqual([]);
  });

  it('computeCohortConsensus surfaces the same drop diagnostics', () => {
    const probes = makeProbes(1);
    const observations = [
      observation('a', 1, [100]),
      observation('b', 2, [100]),
      observation('c', 3, [100]),
      observation('d', 1, [500]), // distinct peer, agentId 1 already used
    ];
    const warnings: string[] = [];
    const consensus = computeCohortConsensus(observations, probes, {
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/agentId 1/);
    expect(consensus.parseableCounts).toEqual([3]);
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
