import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS } from './reasoning.js';
import { validateServiceCapabilityFields, type ServiceCapabilities } from './peer-metadata.js';

describe('reasoning effort capabilities', () => {
  it('accepts all supported labels and omission as unknown', () => {
    expect(validateServiceCapabilityFields({ reasoningEfforts: [...REASONING_EFFORTS] })).toEqual([]);
    expect(validateServiceCapabilityFields({})).toEqual([]);
    expect(validateServiceCapabilityFields({ reasoning: false, reasoningEfforts: ['none'] })).toEqual([]);
  });

  it.each([[], ['high', 'high'], ['unknown'], 'high', ['high', 3], null])('rejects malformed effort lists %j', (reasoningEfforts) => {
    expect(validateServiceCapabilityFields({ reasoningEfforts } as ServiceCapabilities)).not.toEqual([]);
  });

  it('rejects enabled reasoning when reasoning is false', () => {
    expect(validateServiceCapabilityFields({ reasoning: false, reasoningEfforts: ['high'] })).toContain('reasoningEfforts cannot enable reasoning when reasoning is false');
  });
});
