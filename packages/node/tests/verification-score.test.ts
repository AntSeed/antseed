import { describe, it, expect } from 'vitest';
import {
  computeModelVerificationScore,
  toPeerModelVerification,
  hasModelSubstitutionFlag,
} from '../src/routing/verification-score.js';
import type { ServiceVerificationStats } from '../src/payments/evm/verifier-client.js';

function stats(over: Partial<Parameters<typeof computeModelVerificationScore>[0]>) {
  return {
    sameCount: 0,
    diffCount: 0,
    distinctVerifierCount: 0,
    activeDiffVerifierCount: 0,
    ...over,
  };
}

function fullStats(over: Partial<ServiceVerificationStats>): ServiceVerificationStats {
  return {
    sameCount: 0,
    diffCount: 0,
    undeterminedCount: 0,
    distinctVerifierCount: 0,
    lastVerdict: 0,
    lastVerifier: '0x' + '0'.repeat(40),
    activeDiffVerifierCount: 0,
    ...over,
  };
}

describe('computeModelVerificationScore', () => {
  it('returns null with no evidence', () => {
    expect(computeModelVerificationScore(stats({}))).toBeNull();
  });

  it('returns null for a single-verifier clean history (not corroborated)', () => {
    expect(computeModelVerificationScore(stats({ sameCount: 5, distinctVerifierCount: 1 }))).toBeNull();
  });

  it('returns null for a single SAME even with a second (UNDETERMINED-only) verifier', () => {
    // SAME(1 attestation) + UNDETERMINED-only second verifier: the on-chain
    // stats cannot exclude UNDETERMINED-only verifiers from
    // distinctVerifierCount, so corroboration also requires >= 2 SAMEs.
    expect(computeModelVerificationScore(stats({ sameCount: 1, distinctVerifierCount: 2 }))).toBeNull();
  });

  it('scores a corroborated clean history positively', () => {
    const score = computeModelVerificationScore(stats({ sameCount: 8, distinctVerifierCount: 4 }));
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(80);
    expect(score!).toBeLessThanOrEqual(95);
  });

  it('caps clean scores below 100 (SAME is never proof)', () => {
    const score = computeModelVerificationScore(stats({ sameCount: 1000, distinctVerifierCount: 50 }));
    expect(score!).toBeLessThanOrEqual(95);
  });

  it('drives score low on a standing (active) DIFF regardless of verifier count', () => {
    const score = computeModelVerificationScore(stats({
      sameCount: 0, diffCount: 1, distinctVerifierCount: 1, activeDiffVerifierCount: 1,
    }));
    expect(score).toBe(0);
  });

  it('lets many clean attestations partially offset a standing DIFF, but keeps it low', () => {
    const score = computeModelVerificationScore(stats({
      sameCount: 9, diffCount: 1, distinctVerifierCount: 5, activeDiffVerifierCount: 1,
    }));
    expect(score!).toBeGreaterThan(0);
    expect(score!).toBeLessThanOrEqual(40);
  });

  it('lowers the ceiling further with each additional active accuser', () => {
    const one = computeModelVerificationScore(stats({
      sameCount: 9, diffCount: 1, distinctVerifierCount: 5, activeDiffVerifierCount: 1,
    }))!;
    const three = computeModelVerificationScore(stats({
      sameCount: 9, diffCount: 1, distinctVerifierCount: 5, activeDiffVerifierCount: 3,
    }))!;
    expect(three).toBeLessThan(one);
  });

  it('recovers when every DIFF accuser retracts (activeDiffVerifierCount drops to 0)', () => {
    const flagged = computeModelVerificationScore(stats({
      sameCount: 6, diffCount: 2, distinctVerifierCount: 3, activeDiffVerifierCount: 2,
    }))!;
    const retracted = computeModelVerificationScore(stats({
      sameCount: 8, diffCount: 2, distinctVerifierCount: 3, activeDiffVerifierCount: 0,
    }))!;
    expect(flagged).toBeLessThanOrEqual(40);
    expect(retracted).toBeGreaterThan(40);
  });

  it('caps a retracted-DIFF history below a spotless one (history stays a secondary signal)', () => {
    const retracted = computeModelVerificationScore(stats({
      sameCount: 1000, diffCount: 2, distinctVerifierCount: 8, activeDiffVerifierCount: 0,
    }))!;
    const spotless = computeModelVerificationScore(stats({
      sameCount: 1000, diffCount: 0, distinctVerifierCount: 8,
    }))!;
    expect(retracted).toBeLessThanOrEqual(75);
    expect(retracted).toBeLessThan(spotless);
  });

  it('scores more SAMEs and verifiers monotonically higher on clean history', () => {
    const low = computeModelVerificationScore(stats({ sameCount: 2, distinctVerifierCount: 2 }))!;
    const high = computeModelVerificationScore(stats({ sameCount: 20, distinctVerifierCount: 4 }))!;
    expect(high).toBeGreaterThan(low);
  });
});

describe('toPeerModelVerification', () => {
  it('projects raw on-chain stats (including activeDiffVerifierCount) and computes the score', () => {
    const mv = toPeerModelVerification(fullStats({
      sameCount: 6,
      diffCount: 1,
      undeterminedCount: 1,
      distinctVerifierCount: 3,
      lastVerdict: 1,
      activeDiffVerifierCount: 1,
    }));
    expect(mv.sameCount).toBe(6);
    expect(mv.undeterminedCount).toBe(1);
    expect(mv.activeDiffVerifierCount).toBe(1);
    expect(mv.score).not.toBeNull();
    // No threshold supplied at enrichment: the field is absent, not stamped 0.
    expect('exclusionThreshold' in mv).toBe(false);
  });

  it('stamps the chain-read exclusion threshold when supplied', () => {
    const mv = toPeerModelVerification(fullStats({ sameCount: 1 }), 3);
    expect(mv.exclusionThreshold).toBe(3);
  });
});

describe('hasModelSubstitutionFlag', () => {
  it('is false when unset or clean', () => {
    expect(hasModelSubstitutionFlag(undefined)).toBe(false);
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      sameCount: 3, distinctVerifierCount: 2, lastVerdict: 1,
    })))).toBe(false);
  });

  it('does NOT exclude on a single standing DIFF (one verifier is not corroboration)', () => {
    // A lone accuser only deprioritizes (lowers the authenticity score); it
    // must not blackball the seller, or one wrong/malicious verifier becomes a
    // routing kill-switch while the on-chain emissions penalty (which needs
    // >=2 distinct DIFF verifiers) has not even triggered.
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 1,
    })))).toBe(false);
  });

  it('excludes once a second distinct verifier corroborates the DIFF (>= threshold)', () => {
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      diffCount: 2, distinctVerifierCount: 2, lastVerdict: 2, activeDiffVerifierCount: 2,
    })))).toBe(true);
  });

  it('uses the exclusionThreshold stamped at enrichment time (chain-read policy value)', () => {
    // Policy raised to 3: two standing accusers no longer exclude…
    const twoAccusers = toPeerModelVerification(fullStats({
      diffCount: 2, distinctVerifierCount: 2, lastVerdict: 2, activeDiffVerifierCount: 2,
    }), 3);
    expect(hasModelSubstitutionFlag(twoAccusers)).toBe(false);
    // …but three do.
    const threeAccusers = toPeerModelVerification(fullStats({
      diffCount: 3, distinctVerifierCount: 3, lastVerdict: 2, activeDiffVerifierCount: 3,
    }), 3);
    expect(hasModelSubstitutionFlag(threeAccusers)).toBe(true);
    // Policy lowered to 1: a lone accuser excludes.
    const oneAccuser = toPeerModelVerification(fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 1,
    }), 1);
    expect(hasModelSubstitutionFlag(oneAccuser)).toBe(true);
  });

  it('ignores an invalid persisted stamp and falls back to the offline default', () => {
    // Persisted peer state can carry arbitrary JSON: anything outside the
    // contract setter's domain (integer >= 1) must not be trusted.
    const base = fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 1,
    });
    for (const bad of [0, -1, 1.5, NaN]) {
      const mv = { ...toPeerModelVerification(base), exclusionThreshold: bad };
      expect(hasModelSubstitutionFlag(mv)).toBe(false); // falls back to 2
    }
    const stringStamp = { ...toPeerModelVerification(base), exclusionThreshold: '1' as unknown as number };
    expect(hasModelSubstitutionFlag(stringStamp)).toBe(false);
  });

  it('lets an explicit caller override beat the stamped threshold', () => {
    const mv = toPeerModelVerification(fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 1,
    }), 2);
    expect(hasModelSubstitutionFlag(mv)).toBe(false);
    expect(hasModelSubstitutionFlag(mv, 1)).toBe(true);
  });

  it('honors an explicit corroboration threshold override', () => {
    const mv = toPeerModelVerification(fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 1,
    }));
    // With the default (2) a single accuser does not exclude; a caller that
    // deliberately lowers the bar to 1 gets the stricter exclusion.
    expect(hasModelSubstitutionFlag(mv)).toBe(false);
    expect(hasModelSubstitutionFlag(mv, 1)).toBe(true);
  });

  it('clears once every DIFF is retracted, despite the historical diffCount', () => {
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      sameCount: 4, diffCount: 2, distinctVerifierCount: 2, lastVerdict: 1, activeDiffVerifierCount: 0,
    })))).toBe(false);
  });

  it('does not flag after an owner clear even while lastVerdict is still DIFF', () => {
    // clearVerifierStanding decrements activeDiffVerifierCount to 0 but never
    // rewrites stats.lastVerdict (only submitAttestation does), so the exact
    // post-owner-clear state is activeDiffVerifierCount==0 with lastVerdict==DIFF.
    // Routing must track activeDiffVerifierCount alone so the block lifts in
    // lockstep with the on-chain points penalty and the CLI 502 gate.
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      diffCount: 1, distinctVerifierCount: 1, lastVerdict: 2, activeDiffVerifierCount: 0,
    })))).toBe(false);
  });

  it('flags whenever activeDiffVerifierCount reaches the corroboration threshold', () => {
    expect(hasModelSubstitutionFlag(toPeerModelVerification(fullStats({
      diffCount: 3, distinctVerifierCount: 3, lastVerdict: 2, activeDiffVerifierCount: 3,
    })))).toBe(true);
  });
});
