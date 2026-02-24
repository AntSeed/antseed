import { describe, it, expect } from 'vitest';
import {
  validateMetadata,
  MAX_METADATA_SIZE,
  MAX_PROVIDERS,
  MAX_MODELS_PER_PROVIDER,
  MAX_MODEL_NAME_LENGTH,
  MAX_REGION_LENGTH,
} from '../src/discovery/metadata-validator.js';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

function validMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: 2,
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
