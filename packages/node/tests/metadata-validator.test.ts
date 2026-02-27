import { describe, it, expect } from 'vitest';
import {
  validateMetadata,
  MAX_METADATA_SIZE,
  MAX_PROVIDERS,
  MAX_MODELS_PER_PROVIDER,
  MAX_MODEL_NAME_LENGTH,
  MAX_REGION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_MODEL_CATEGORY_LENGTH,
  MAX_MODEL_API_PROTOCOLS_PER_MODEL,
} from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function validMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        models: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    region: 'us-east-1',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

describe('validateMetadata', () => {
  it('should return no errors for valid metadata', () => {
    const errors = validateMetadata(validMetadata());
    expect(errors).toEqual([]);
  });

  it('should reject wrong version', () => {
    const errors = validateMetadata(validMetadata({ version: 99 }));
    expect(errors.some((e) => e.field === 'version')).toBe(true);
  });

  it('should reject invalid peerId (too short)', () => {
    const errors = validateMetadata(validMetadata({ peerId: 'abc' as any }));
    expect(errors.some((e) => e.field === 'peerId')).toBe(true);
  });

  it('should reject invalid peerId (uppercase)', () => {
    const errors = validateMetadata(validMetadata({ peerId: 'A'.repeat(64) as any }));
    expect(errors.some((e) => e.field === 'peerId')).toBe(true);
  });

  it('should reject empty region', () => {
    const errors = validateMetadata(validMetadata({ region: '' }));
    expect(errors.some((e) => e.field === 'region')).toBe(true);
  });

  it('should reject region exceeding max length', () => {
    const errors = validateMetadata(validMetadata({ region: 'x'.repeat(MAX_REGION_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'region')).toBe(true);
  });

  it('should reject non-positive timestamp', () => {
    const errors = validateMetadata(validMetadata({ timestamp: 0 }));
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('should reject NaN timestamp', () => {
    const errors = validateMetadata(validMetadata({ timestamp: NaN }));
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('should reject zero providers', () => {
    const errors = validateMetadata(validMetadata({ providers: [] }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });

  it('should reject too many providers', () => {
    const providers = Array.from({ length: MAX_PROVIDERS + 1 }, (_, i) => ({
      provider: `p${i}`,
      models: ['m'],
      defaultPricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
      maxConcurrency: 1,
      currentLoad: 0,
    }));
    const errors = validateMetadata(validMetadata({ providers }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });

  it('should reject too many models per provider', () => {
    const models = Array.from({ length: MAX_MODELS_PER_PROVIDER + 1 }, (_, i) => `model-${i}`);
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models,
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('models'))).toBe(true);
  });

  it('should reject model name exceeding max length', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['x'.repeat(MAX_MODEL_NAME_LENGTH + 1)],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('models'))).toBe(true);
  });

  it('should reject modelPricing entries with model names exceeding max length', () => {
    const longModelName = 'x'.repeat(MAX_MODEL_NAME_LENGTH + 1);
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            modelPricing: {
              [longModelName]: {
                inputUsdPerMillion: 2,
                outputUsdPerMillion: 3,
              },
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('modelPricing'))).toBe(true);
  });

  it('should reject negative default input price', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: -1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('defaultPricing.inputUsdPerMillion'))).toBe(true);
  });

  it('should reject negative default output price', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: -1,
            },
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('defaultPricing.outputUsdPerMillion'))).toBe(true);
  });

  it('should reject model pricing entries with missing output half', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            modelPricing: {
              m: {
                inputUsdPerMillion: 2,
              } as any,
            } as any,
            maxConcurrency: 1,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('modelPricing.m.outputUsdPerMillion'))).toBe(true);
  });

  it('should reject maxConcurrency < 1', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 0,
            currentLoad: 0,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('maxConcurrency'))).toBe(true);
  });

  it('should reject currentLoad > maxConcurrency', () => {
    const errors = validateMetadata(
      validMetadata({
        providers: [
          {
            provider: 'test',
            models: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            maxConcurrency: 5,
            currentLoad: 6,
          },
        ],
      })
    );
    expect(errors.some((e) => e.field.includes('currentLoad'))).toBe(true);
  });

  it('should reject invalid signature format', () => {
    const errors = validateMetadata(validMetadata({ signature: 'xyz' }));
    expect(errors.some((e) => e.field === 'signature')).toBe(true);
  });

  it('should reject signature with uppercase hex', () => {
    const errors = validateMetadata(validMetadata({ signature: 'B'.repeat(128) }));
    expect(errors.some((e) => e.field === 'signature')).toBe(true);
  });

  it('should reject empty displayName when present', () => {
    const errors = validateMetadata(validMetadata({ displayName: '   ' }));
    expect(errors.some((e) => e.field === 'displayName')).toBe(true);
  });

  it('should reject too long displayName', () => {
    const errors = validateMetadata(validMetadata({ displayName: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'displayName')).toBe(true);
  });

  it('should reject categories for a model not listed by provider', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelCategories: {
            m2: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelCategories.m2'))).toBe(true);
  });

  it('should allow model categories when provider declares wildcard models', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelCategories: {
            'any-model': ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelCategories.any-model'))).toBe(false);
  });

  it('should reject invalid model category value', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelCategories: {
            m1: [`${'x'.repeat(MAX_MODEL_CATEGORY_LENGTH)}!`],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelCategories.m1'))).toBe(true);
  });

  it('should reject model category entries with model names exceeding max length', () => {
    const longModelName = 'x'.repeat(MAX_MODEL_NAME_LENGTH + 1);
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelCategories: {
            [longModelName]: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelCategories'))).toBe(true);
  });

  it('should reject model API protocols for a model not listed by provider', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelApiProtocols: {
            m2: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelApiProtocols.m2'))).toBe(true);
  });

  it('should allow model API protocols when provider declares wildcard models', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelApiProtocols: {
            'any-model': ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelApiProtocols.any-model'))).toBe(false);
  });

  it('should reject unsupported model API protocol values', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelApiProtocols: {
            m1: ['not-a-real-protocol' as any],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelApiProtocols.m1'))).toBe(true);
  });

  it('should reject too many model API protocols per model', () => {
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelApiProtocols: {
            m1: Array.from({ length: MAX_MODEL_API_PROTOCOLS_PER_MODEL + 1 }, (_, i) =>
              i % 2 === 0 ? 'openai-chat-completions' : 'anthropic-messages',
            ),
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelApiProtocols.m1'))).toBe(true);
  });

  it('should reject model API protocol entries with model names exceeding max length', () => {
    const longModelName = 'x'.repeat(MAX_MODEL_NAME_LENGTH + 1);
    const errors = validateMetadata(validMetadata({
      providers: [
        {
          provider: 'test',
          models: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          modelApiProtocols: {
            [longModelName]: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('modelApiProtocols'))).toBe(true);
  });
});

describe('constants', () => {
  it('should export reasonable constant values', () => {
    expect(MAX_METADATA_SIZE).toBe(1000);
    expect(MAX_PROVIDERS).toBe(10);
    expect(MAX_MODELS_PER_PROVIDER).toBe(20);
    expect(MAX_MODEL_NAME_LENGTH).toBe(64);
    expect(MAX_REGION_LENGTH).toBe(32);
  });
});
