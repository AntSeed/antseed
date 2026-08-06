import { describe, expect, it } from 'vitest';
import { parseServiceCapabilitiesJson, parseServiceUnitBillingModelsJson } from './config-utils.js';

describe('parseServiceUnitBillingModelsJson', () => {
  it('rejects unknown service API protocol keys', () => {
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'not-a-protocol': {
          version: 1,
          components: [],
        },
      },
    }))).toThrow(/known service API protocol/);
  });

  it('accepts known service API protocol keys', () => {
    expect(parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'openai-images': {
          version: 1,
          components: [],
        },
      },
    }))).toEqual({
      'gpt-image-1': {
        'openai-images': {
          version: 1,
          components: [],
        },
      },
    });
  });
});

describe('parseServiceCapabilitiesJson', () => {
  it('returns undefined for empty input', () => {
    expect(parseServiceCapabilitiesJson(undefined)).toBeUndefined();
    expect(parseServiceCapabilitiesJson('{}')).toBeUndefined();
  });

  it('parses and normalizes a full capabilities map', () => {
    expect(parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image', 'text'],
        reasoning: true,
        toolUse: false,
      },
    }))).toEqual({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image'],
        reasoning: true,
        toolUse: false,
      },
    });
  });

  it('rejects unknown input modalities', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { inputs: ['text', 'hologram'] },
    }))).toThrow(/inputs must be an array of/);
  });

  it('rejects non-integer token counts', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { contextWindow: -1 },
    }))).toThrow(/positive integer/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { maxOutputTokens: 1.5 },
    }))).toThrow(/positive integer/);
  });

  it('rejects non-boolean flags', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { reasoning: 'yes' },
    }))).toThrow(/must be a boolean/);
  });
});
