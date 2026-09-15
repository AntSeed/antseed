import { describe, expect, it } from 'vitest';
import { passedSellerNodeClaims, teeBadgeLabel, TEE_REQUIRED_CLAIMS, type TeeEvidence } from './tee-status.js';

describe('seller-node TEE evidence', () => {
  const claims = TEE_REQUIRED_CLAIMS.map((claim) => ({ claim, ok: true }));
  it('requires both claims and rejects missing, unrelated and conflicting duplicate claims', () => {
    expect(passedSellerNodeClaims(claims)).toBe(true);
    expect(passedSellerNodeClaims([...claims, claims[0]!])).toBe(true);
    expect(passedSellerNodeClaims([])).toBe(false);
    expect(passedSellerNodeClaims(claims.slice(1))).toBe(false);
    expect(passedSellerNodeClaims([{ claim: 'inference-verified', ok: true }])).toBe(false);
    expect(passedSellerNodeClaims([...claims, { ...claims[0]!, ok: false }])).toBe(false);
  });
  it('distinguishes unavailable checks from failed verification and downgrades expired success', () => {
    const evidence: TeeEvidence = { peerId: 'seller', verifierId: 'antseed-verifier', fingerprint: 'caps', checkedAt: 100, expiresAt: 200, sellerNodeVerified: true, claims };
    expect(teeBadgeLabel(undefined, 100)).toBe('TEE advertised');
    expect(teeBadgeLabel(evidence, 199)).toBe('Seller node verified');
    expect(teeBadgeLabel(evidence, 200)).toBe('TEE advertised');
    expect(teeBadgeLabel({ ...evidence, sellerNodeVerified: false }, 150)).toBe('Verification failed');
    expect(teeBadgeLabel({ ...evidence, sellerNodeVerified: false, unavailable: true }, 150)).toBe('Verification unavailable');
    expect(teeBadgeLabel({ ...evidence, checking: true }, 150)).toBe('Checking TEE…');
  });
});
