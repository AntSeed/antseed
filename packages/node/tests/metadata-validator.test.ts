import { describe, it, expect } from 'vitest';
import {
  validateMetadata,
  MAX_METADATA_SIZE,
  MAX_PROVIDERS,
  MAX_SERVICES_PER_PROVIDER,
  MAX_SERVICE_NAME_LENGTH,
  MAX_REGION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PUBLIC_ADDRESS_LENGTH,
  MAX_SERVICE_CATEGORY_LENGTH,
  MAX_SERVICE_API_PROTOCOLS_PER_SERVICE,
} from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function validMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    services: [
      {
        name: 'claude-3-opus',
        pricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
      },
    ],
    providers: [],
    maxConcurrency: 10,
    currentLoad: 3,
    region: 'us-east-1',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

/** Create legacy v5 metadata for testing provider-centric validation paths. */
function validLegacyMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: 5,
    services: [],
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    maxConcurrency: 10,
    currentLoad: 3,
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

  it('should reject version higher than current', () => {
    const errors = validateMetadata(validMetadata({ version: 99 }));
    expect(errors.some((e) => e.field === 'version')).toBe(true);
  });

  it('should reject version 0', () => {
    const errors = validateMetadata(validMetadata({ version: 0 }));
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

  it('should reject zero services (v6)', () => {
    const errors = validateMetadata(validMetadata({ services: [] }));
    expect(errors.some((e) => e.field === 'services')).toBe(true);
  });

  it('should reject zero providers (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({ providers: [] }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });

  it('should reject too many providers (legacy v5)', () => {
    const providers = Array.from({ length: MAX_PROVIDERS + 1 }, (_, i) => ({
      provider: `p${i}`,
      services: ['m'],
      defaultPricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
      maxConcurrency: 1,
      currentLoad: 0,
    }));
    const errors = validateMetadata(validLegacyMetadata({ providers }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });

  it('should reject too many services per provider (legacy v5)', () => {
    const services = Array.from({ length: MAX_SERVICES_PER_PROVIDER + 1 }, (_, i) => `service-${i}`);
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services,
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
    expect(errors.some((e) => e.field.includes('services'))).toBe(true);
  });

  it('should reject service name exceeding max length (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['x'.repeat(MAX_SERVICE_NAME_LENGTH + 1)],
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
    expect(errors.some((e) => e.field.includes('services'))).toBe(true);
  });

  it('should reject servicePricing entries with service names exceeding max length (legacy v5)', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            servicePricing: {
              [longServiceName]: {
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
    expect(errors.some((e) => e.field.includes('servicePricing'))).toBe(true);
  });

  it('should reject negative default input price (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
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

  it('should reject negative default output price (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
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

  it('should reject service pricing entries with missing output half (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
            defaultPricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
            servicePricing: {
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
    expect(errors.some((e) => e.field.includes('servicePricing.m.outputUsdPerMillion'))).toBe(true);
  });

  it('should reject maxConcurrency < 1 (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
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

  it('should reject currentLoad > maxConcurrency (legacy v5)', () => {
    const errors = validateMetadata(
      validLegacyMetadata({
        providers: [
          {
            provider: 'test',
            services: ['m'],
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

  it('should accept valid publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'peer.example.com:6882' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(false);
  });

  it('should reject empty publicAddress when present', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: '   ' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject too long publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'a'.repeat(MAX_PUBLIC_ADDRESS_LENGTH + 1) }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject malformed publicAddress', () => {
    const errors = validateMetadata(validMetadata({ publicAddress: 'peer.example.com' }));
    expect(errors.some((e) => e.field === 'publicAddress')).toBe(true);
  });

  it('should reject categories for a service not listed by provider (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            m2: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.m2'))).toBe(true);
  });

  it('should allow service categories when provider declares wildcard services (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            'any-service': ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.any-model'))).toBe(false);
  });

  it('should reject invalid service category value (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            m1: [`${'x'.repeat(MAX_SERVICE_CATEGORY_LENGTH)}!`],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories.m1'))).toBe(true);
  });

  it('should reject service category entries with service names exceeding max length (legacy v5)', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceCategories: {
            [longServiceName]: ['privacy'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceCategories'))).toBe(true);
  });

  it('should reject service API protocols for a service not listed by provider (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m2: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m2'))).toBe(true);
  });

  it('should allow service API protocols when provider declares wildcard services (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            'any-service': ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.any-model'))).toBe(false);
  });

  it('should reject unsupported service API protocol values (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m1: ['not-a-real-protocol' as any],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m1'))).toBe(true);
  });

  it('should reject too many service API protocols per service (legacy v5)', () => {
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: ['m1'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            m1: Array.from({ length: MAX_SERVICE_API_PROTOCOLS_PER_SERVICE + 1 }, (_, i) =>
              i % 2 === 0 ? 'openai-chat-completions' : 'anthropic-messages',
            ),
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols.m1'))).toBe(true);
  });

  it('should reject service API protocol entries with service names exceeding max length (legacy v5)', () => {
    const longServiceName = 'x'.repeat(MAX_SERVICE_NAME_LENGTH + 1);
    const errors = validateMetadata(validLegacyMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
          serviceApiProtocols: {
            [longServiceName]: ['openai-chat-completions'],
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    }));
    expect(errors.some((e) => e.field.includes('serviceApiProtocols'))).toBe(true);
  });
});

describe('constants', () => {
  it('should export reasonable constant values', () => {
    expect(MAX_METADATA_SIZE).toBe(1000);
    expect(MAX_PROVIDERS).toBe(10);
    expect(MAX_SERVICES_PER_PROVIDER).toBe(20);
    expect(MAX_SERVICE_NAME_LENGTH).toBe(64);
    expect(MAX_REGION_LENGTH).toBe(32);
  });
});
