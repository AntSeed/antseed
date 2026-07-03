import { describe, it, expect } from 'vitest';
import {
  computeModelVerificationScore,
  toPeerModelVerification,
  hasModelSubstitutionFlag,
} from '../src/routing/verification-score.js';

function stats(over: Partial<Parameters<typeof computeModelVerificationScore>[0]>) {
  return { sameCount: 0, diffCount: 0, distinctVerifierCount: 0, ...over };
}

describe('computeModelVerificationScore', () => {
  it('returns null with no evidence', () => {
    expect(computeModelVerificationScore(stats({}))).toBeNull();
  });

  it('returns null for a single-verifier clean history (not corroborated)', () => {
    expect(computeModelVerificationScore(stats({ sameCount: 5, distinctVerifierCount: 1 }))).toBeNull();
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

  it('drives score low on any DIFF regardless of verifier count', () => {
    const score = computeModelVerificationScore(stats({ sameCount: 0, diffCount: 1, distinctVerifierCount: 1 }));
    expect(score).toBe(0);
  });

  it('lets many clean attestations partially offset a stale DIFF, but keeps it low', () => {
    const score = computeModelVerificationScore(stats({ sameCount: 9, diffCount: 1, distinctVerifierCount: 5 }));
    expect(score!).toBeGreaterThan(0);
    expect(score!).toBeLessThanOrEqual(40);
  });

  it('scores more SAMEs and verifiers monotonically higher on clean history', () => {
    const low = computeModelVerificationScore(stats({ sameCount: 2, distinctVerifierCount: 2 }))!;
    const high = computeModelVerificationScore(stats({ sameCount: 20, distinctVerifierCount: 4 }))!;
    expect(high).toBeGreaterThan(low);
  });
});

describe('toPeerModelVerification', () => {
  it('projects raw on-chain stats and computes the score', () => {
    const mv = toPeerModelVerification({
      sameCount: 6,
      diffCount: 0,
      undeterminedCount: 1,
      distinctVerifierCount: 3,
      lastVerdict: 1,
      lastVerifier: '0x' + '1'.repeat(40),
    });
    expect(mv.sameCount).toBe(6);
    expect(mv.undeterminedCount).toBe(1);
    expect(mv.score).not.toBeNull();
  });
});

describe('hasModelSubstitutionFlag', () => {
  it('is false when unset or clean', () => {
    expect(hasModelSubstitutionFlag(undefined)).toBe(false);
    expect(hasModelSubstitutionFlag(toPeerModelVerification({
      sameCount: 3, diffCount: 0, undeterminedCount: 0, distinctVerifierCount: 2, lastVerdict: 1, lastVerifier: '0x0',
    }))).toBe(false);
  });

  it('is true on a diffCount or a DIFF last verdict', () => {
    expect(hasModelSubstitutionFlag(toPeerModelVerification({
      sameCount: 0, diffCount: 1, undeterminedCount: 0, distinctVerifierCount: 1, lastVerdict: 2, lastVerifier: '0x0',
    }))).toBe(true);
  });
});
