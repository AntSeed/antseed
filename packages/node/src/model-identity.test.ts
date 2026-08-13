import { describe, expect, it } from 'vitest';
import { canonicalModelKey, sameCanonicalModel } from './model-identity.js';

describe('canonicalModelKey', () => {
  it('merges cosmetic variants and conservative Claude family aliases', () => {
    expect(canonicalModelKey('anthropic/claude-opus-5-20260813')).toBe('opus5');
    expect(canonicalModelKey('Opus 5')).toBe('opus5');
    expect(sameCanonicalModel('Claude Sonnet 5', 'sonnet-5')).toBe(true);
  });

  it('does not strip Claude from unknown family names', () => {
    expect(canonicalModelKey('claude-fable-5')).not.toBe(canonicalModelKey('fable-5'));
  });
});
