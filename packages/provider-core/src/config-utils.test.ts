import { describe, expect, it } from 'vitest';
import { parseServiceBillingModelsJson } from './config-utils.js';

describe('parseServiceBillingModelsJson', () => {
  it('rejects unknown service API protocol keys', () => {
    expect(() => parseServiceBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'not-a-protocol': {
          version: 1,
          components: [],
        },
      },
    }))).toThrow(/known service API protocol/);
  });

  it('accepts known service API protocol keys', () => {
    expect(parseServiceBillingModelsJson(JSON.stringify({
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
