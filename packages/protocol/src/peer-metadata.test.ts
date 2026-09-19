import { describe, expect, it } from 'vitest';
import { METADATA_VERSION, validateServiceCapabilityFields, type ServiceCapabilities } from './peer-metadata.js';

describe('routing service capabilities', () => {
  it('supports metadata through v14', () => {
    expect(METADATA_VERSION).toBe(14);
  });

  it.each([true, false, undefined])('accepts routing %s', (routing) => {
    expect(validateServiceCapabilityFields({ routing })).toEqual([]);
  });

  it.each([null, 0, 1, 'true', 'false', [], {}].map((routing) => ({ routing })))('rejects non-boolean routing $routing', ({ routing }) => {
    expect(validateServiceCapabilityFields({ routing } as ServiceCapabilities)).toContain('routing must be a boolean');
  });
});
