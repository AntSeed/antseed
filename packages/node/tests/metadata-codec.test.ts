import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function makeV6Metadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
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
      {
        name: 'claude-3-sonnet',
        pricing: {
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 15,
        },
      },
    ],
    providers: [],
    maxConcurrency: 10,
    currentLoad: 3,
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

function makeLegacyMetadata(version: number, overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version,
    services: [],
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus', 'claude-3-sonnet'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        servicePricing: {
          'claude-3-opus': {
            inputUsdPerMillion: 18,
            outputUsdPerMillion: 90,
          },
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    maxConcurrency: 10,
    currentLoad: 3,
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

describe('v6 service-centric encodeMetadata / decodeMetadata', () => {
  it('should round-trip a basic v6 metadata object', () => {
    const original = makeV6Metadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.version).toBe(METADATA_VERSION);
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.signature).toBe(original.signature);
    expect(decoded.services).toHaveLength(2);
    expect(decoded.services[0]!.name).toBe('claude-3-opus');
    expect(decoded.services[1]!.name).toBe('claude-3-sonnet');
    expect(decoded.maxConcurrency).toBe(10);
    expect(decoded.currentLoad).toBe(3);
    expect(decoded.providers).toEqual([]);
  });

  it('should handle float32 precision for service prices', () => {
    const original = makeV6Metadata();
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.services[0]!.pricing.inputUsdPerMillion).toBeCloseTo(15, 3);
    expect(decoded.services[0]!.pricing.outputUsdPerMillion).toBeCloseTo(75, 3);
  });

  it('should round-trip services with protocols and categories', () => {
    const original = makeV6Metadata({
      displayName: 'Node A',
      publicAddress: 'peer.example.com:6882',
      services: [
        {
          name: 'claude-3-opus',
          pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
          protocols: ['openai-chat-completions', 'anthropic-messages'],
          categories: ['privacy', 'coding'],
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.displayName).toBe('Node A');
    expect(decoded.publicAddress).toBe('peer.example.com:6882');
    expect(decoded.services[0]!.protocols).toEqual(['anthropic-messages', 'openai-chat-completions']);
    expect(decoded.services[0]!.categories).toEqual(['coding', 'privacy']);
  });

  it('should round-trip zero services', () => {
    const original = makeV6Metadata({ services: [] });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.services).toHaveLength(0);
  });

  it('should round-trip services without protocols or categories', () => {
    const original = makeV6Metadata({
      services: [
        {
          name: 'gpt-4',
          pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 },
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.services[0]!.protocols).toBeUndefined();
    expect(decoded.services[0]!.categories).toBeUndefined();
  });

  it('should round-trip offerings and on-chain data with v6', () => {
    const original = makeV6Metadata({
      offerings: [
        {
          capability: 'skill',
          name: 'summarize',
          description: 'Summarize text',
          pricing: { unit: 'request', pricePerUnit: 0.1, currency: 'USD' },
          services: ['claude-3-sonnet'],
        },
      ],
      evmAddress: '0x1111111111111111111111111111111111111111',
      onChainReputation: 88,
      onChainSessionCount: 123,
      onChainDisputeCount: 2,
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.offerings?.[0]?.name).toBe('summarize');
    expect(decoded.evmAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(decoded.onChainReputation).toBe(88);
    expect(decoded.onChainSessionCount).toBe(123);
    expect(decoded.onChainDisputeCount).toBe(2);
  });
});

describe('v5 backward-compatible decoding', () => {
  it('should decode v5 provider-centric metadata and convert to services', () => {
    const original = makeLegacyMetadata(5, {
      publicAddress: 'peer.example.com:6882',
    });
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.version).toBe(5);
    // Legacy providers should be preserved
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
    expect(decoded.providers[0]!.services).toEqual(['claude-3-opus', 'claude-3-sonnet']);
    // Services should be flattened from providers
    expect(decoded.services).toHaveLength(2);
    expect(decoded.services[0]!.name).toBe('claude-3-opus');
    expect(decoded.services[0]!.pricing.inputUsdPerMillion).toBeCloseTo(18, 3); // service pricing
    expect(decoded.services[1]!.name).toBe('claude-3-sonnet');
    expect(decoded.services[1]!.pricing.inputUsdPerMillion).toBeCloseTo(15, 3); // default pricing
    // Peer-level concurrency is summed from providers
    expect(decoded.maxConcurrency).toBe(10);
    expect(decoded.currentLoad).toBe(3);
  });

  it('should decode v5 with multiple providers and flatten services', () => {
    const original = makeLegacyMetadata(5, {
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4'],
          defaultPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 },
          maxConcurrency: 5,
          currentLoad: 0,
        },
        {
          provider: 'anthropic',
          services: ['claude-3-haiku'],
          defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
          maxConcurrency: 20,
          currentLoad: 10,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers).toHaveLength(2);
    expect(decoded.services).toHaveLength(2);
    expect(decoded.services[0]!.name).toBe('gpt-4');
    expect(decoded.services[1]!.name).toBe('claude-3-haiku');
    expect(decoded.maxConcurrency).toBe(25);
    expect(decoded.currentLoad).toBe(10);
  });

  it('should decode v5 with service categories and protocols', () => {
    const original = makeLegacyMetadata(5, {
      displayName: 'Node A',
      publicAddress: 'peer.example.com:6882',
      providers: [
        {
          provider: 'anthropic',
          services: ['claude-3-opus'],
          defaultPricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
          serviceCategories: { 'claude-3-opus': ['privacy', 'coding'] },
          serviceApiProtocols: { 'claude-3-opus': ['openai-chat-completions', 'anthropic-messages'] },
          maxConcurrency: 10,
          currentLoad: 3,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.services[0]!.categories).toEqual(['coding', 'privacy']);
    expect(decoded.services[0]!.protocols).toEqual(['anthropic-messages', 'openai-chat-completions']);
  });
});

describe('legacy backward-compatible binary layout', () => {
  it('should retain backward-compatible binary layout for metadata version 2', () => {
    const v2 = makeLegacyMetadata(2, {
      displayName: 'legacy',
    });
    const decoded = decodeMetadata(encodeMetadata(v2));
    expect(decoded.version).toBe(2);
    expect(decoded.displayName).toBeUndefined();
    expect(decoded.providers[0]!.serviceCategories).toBeUndefined();
    expect(decoded.providers[0]!.serviceApiProtocols).toBeUndefined();
  });

  it('should retain backward-compatible binary layout for metadata version 3', () => {
    const v3 = makeLegacyMetadata(3, {
      providers: [
        {
          provider: 'openai',
          services: ['service-a'],
          defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          serviceApiProtocols: { 'service-a': ['openai-chat-completions'] },
          maxConcurrency: 3,
          currentLoad: 1,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(v3));
    expect(decoded.version).toBe(3);
    expect(decoded.providers[0]!.serviceApiProtocols).toBeUndefined();
  });

  it('should retain backward-compatible binary layout for metadata version 4', () => {
    const v4 = makeLegacyMetadata(4, {
      publicAddress: 'peer.example.com:6882',
    });
    const decoded = decodeMetadata(encodeMetadata(v4));
    expect(decoded.version).toBe(4);
    expect(decoded.publicAddress).toBeUndefined();
  });
});

describe('encodeMetadataForSigning', () => {
  it('should produce a shorter buffer than encodeMetadata (no signature)', () => {
    const metadata = makeV6Metadata();
    const forSigning = encodeMetadataForSigning(metadata);
    const full = encodeMetadata(metadata);
    // Full includes 64 bytes of signature
    expect(full.length).toBe(forSigning.length + 64);
  });

  it('should produce deterministic output for the same input', () => {
    const metadata = makeV6Metadata();
    const a = encodeMetadataForSigning(metadata);
    const b = encodeMetadataForSigning(metadata);
    expect(a).toEqual(b);
  });
});
