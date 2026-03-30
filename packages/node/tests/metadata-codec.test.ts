import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function makeMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
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
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(130),
    ...overrides,
  };
}

describe('encodeMetadata / decodeMetadata', () => {
  it('should round-trip a basic metadata object', () => {
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.version).toBe(original.version);
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.signature).toBe(original.signature);
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
    expect(decoded.providers[0]!.services).toEqual(['claude-3-opus', 'claude-3-sonnet']);
    expect(decoded.providers[0]!.maxConcurrency).toBe(10);
    expect(decoded.providers[0]!.currentLoad).toBe(3);
  });

  it('should handle float32 precision for prices', () => {
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);
    // Float32 has limited precision — allow small delta
    expect(decoded.providers[0]!.defaultPricing.inputUsdPerMillion).toBeCloseTo(15, 3);
    expect(decoded.providers[0]!.defaultPricing.outputUsdPerMillion).toBeCloseTo(75, 3);
    expect(decoded.providers[0]!.servicePricing?.['claude-3-opus']?.inputUsdPerMillion).toBeCloseTo(18, 3);
    expect(decoded.providers[0]!.servicePricing?.['claude-3-opus']?.outputUsdPerMillion).toBeCloseTo(90, 3);
  });

  it('should round-trip multiple providers', () => {
    const original = makeMetadata({
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4'],
          defaultPricing: {
            inputUsdPerMillion: 10,
            outputUsdPerMillion: 30,
          },
          maxConcurrency: 5,
          currentLoad: 0,
        },
        {
          provider: 'anthropic',
          services: ['claude-3-haiku'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 5,
          },
          servicePricing: {
            'claude-3-haiku': {
              inputUsdPerMillion: 0.9,
              outputUsdPerMillion: 4.5,
            },
          },
          maxConcurrency: 20,
          currentLoad: 10,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers).toHaveLength(2);
    expect(decoded.providers[0]!.provider).toBe('openai');
    expect(decoded.providers[1]!.provider).toBe('anthropic');
  });

  it('should round-trip zero providers', () => {
    const original = makeMetadata({ providers: [] });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers).toHaveLength(0);
  });

  it('should round-trip empty services list', () => {
    const original = makeMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 0,
            outputUsdPerMillion: 0,
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.services).toEqual([]);
  });

  it('should round-trip display name, service categories, and service API protocols', () => {
    const original = makeMetadata({
      displayName: 'Node A',
      publicAddress: 'peer.example.com:6882',
      providers: [
        {
          provider: 'anthropic',
          services: ['claude-3-opus'],
          defaultPricing: {
            inputUsdPerMillion: 15,
            outputUsdPerMillion: 75,
          },
          serviceCategories: {
            'claude-3-opus': ['privacy', 'coding'],
          },
          serviceApiProtocols: {
            'claude-3-opus': ['openai-chat-completions', 'anthropic-messages'],
          },
          maxConcurrency: 10,
          currentLoad: 3,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.displayName).toBe('Node A');
    expect(decoded.publicAddress).toBe('peer.example.com:6882');
    expect(decoded.providers[0]!.serviceCategories?.['claude-3-opus']).toEqual(['coding', 'privacy']);
    expect(decoded.providers[0]!.serviceApiProtocols?.['claude-3-opus']).toEqual(['anthropic-messages', 'openai-chat-completions']);
  });

  it('should decode offerings and optional trailer fields after v2 provider pricing payload', () => {
    const original = makeMetadata({
      offerings: [
        {
          capability: 'skill',
          name: 'summarize',
          description: 'Summarize text',
          pricing: { unit: 'request', pricePerUnit: 0.1, currency: 'USD' },
          services: ['claude-3-sonnet'],
        },
      ],
      onChainReputation: 88,
      onChainChannelCount: 123,
      onChainDisputeCount: 2,
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.offerings?.[0]?.name).toBe('summarize');
    expect(decoded.onChainReputation).toBe(88);
    expect(decoded.onChainChannelCount).toBe(123);
    expect(decoded.onChainDisputeCount).toBe(2);
  });

  // v2/v3/v4/v5 roundtrip tests removed — pre-v6 format is rejected by the decoder.
});

describe('encodeMetadataForSigning', () => {
  it('should produce a shorter buffer than encodeMetadata (no signature)', () => {
    const metadata = makeMetadata();
    const forSigning = encodeMetadataForSigning(metadata);
    const full = encodeMetadata(metadata);
    // Full includes 65 bytes of signature (EVM secp256k1 r+s+v)
    expect(full.length).toBe(forSigning.length + 65);
  });

  it('should produce deterministic output for the same input', () => {
    const metadata = makeMetadata();
    const a = encodeMetadataForSigning(metadata);
    const b = encodeMetadataForSigning(metadata);
    expect(a).toEqual(b);
  });
});
