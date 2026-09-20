import { describe, it, expect } from 'vitest';
import type { UnitBillingModelV2 } from '@antseed/protocol/billing';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, SERVICE_CAPABILITIES_METADATA_VERSION, SERVICE_UNIT_BILLING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

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
  function withComponents(components: UnitBillingModelV2['components']): PeerMetadata {
    return makeMetadata({ providers: [{ provider: 'openai', services: ['image'], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      serviceApiProtocols: { image: ['openai-images'] }, serviceUnitBillingModels: { image: { 'openai-images': { version: 2, components } } }, maxConcurrency: 1, currentLoad: 0 }] });
  }
  it('round-trips additive conditions and signs canonical condition order', () => {
    const original = withComponents([{ priceMicroUsdc: '40000' }, { priceMicroUsdc: '20000', match: { size: '1536x1024', quality: 'hd' } }]);
    const reordered = withComponents([{ priceMicroUsdc: '40000' }, { priceMicroUsdc: '20000', match: { quality: 'hd', size: '1536x1024' } }]);
    const encoded = encodeMetadata(original);
    expect(decodeMetadata(encoded).providers[0]?.serviceUnitBillingModels).toEqual(original.providers[0]?.serviceUnitBillingModels);
    expect(encodeMetadataForSigning(original)).toEqual(encodeMetadataForSigning(reordered));
    expect(encodeMetadataForSigning(original)).not.toEqual(encodeMetadataForSigning(withComponents([{ priceMicroUsdc: '40000' }, { priceMicroUsdc: '20000', match: { quality: 'standard', size: '1536x1024' } }])));
  });
  it('rejects unsupported conditions, oversized models, and truncated component bytes', () => {
    expect(() => encodeMetadata(withComponents([{ priceMicroUsdc: '1', match: { unsupported: 'x' } }]))).toThrow('unsupported');
    expect(() => encodeMetadata(withComponents(Array.from({ length: 256 }, () => ({ priceMicroUsdc: '0' }))))).toThrow('255');
    expect(() => encodeMetadata(withComponents([{ priceMicroUsdc: '1', match: { quality: 'é'.repeat(128) } }]))).toThrow('255');
    const encoded = encodeMetadata(withComponents([{ priceMicroUsdc: '1', match: { quality: 'hd' } }]));
    const keyOffset = Buffer.from(encoded).indexOf(Buffer.from('quality'));
    expect(keyOffset).toBeGreaterThan(0);
    expect(() => decodeMetadata(encoded.slice(0, keyOffset + 3))).toThrow('Truncated');
  });
  it('rejects duplicate condition keys on the wire', () => {
    const encoded = encodeMetadata(withComponents([{ priceMicroUsdc: '1', match: { model: 'a', quality: 'b' } }]));
    const keyOffset = Buffer.from(encoded).indexOf(Buffer.from('quality'));
    const malformed = Buffer.concat([encoded.slice(0, keyOffset - 1), Buffer.from([5]), Buffer.from('model'), encoded.slice(keyOffset + 7)]);
    expect(() => decodeMetadata(malformed)).toThrow('Duplicate billing condition key');
  });
  it('enforces the total metadata size for many valid components', () => {
    const components = Array.from({ length: 255 }, () => ({ priceMicroUsdc: '1', match: { model: 'a'.repeat(255), quality: 'b'.repeat(255), size: 'c'.repeat(255), resolution: 'd'.repeat(255) } }));
    expect(() => encodeMetadata(withComponents(components))).toThrow('exceeds max');
    expect(() => decodeMetadata(new Uint8Array(128 * 1024 + 1))).toThrow('maximum encoded size');
  });
  it('round-trips v12 catalogs with more than 255 service entries', () => {
    const services = Array.from({ length: 300 }, (_, index) => `service-${index}`);
    const servicePricing = Object.fromEntries(
      services.map((service) => [service, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]),
    );
    const serviceCategories = Object.fromEntries(services.map((service) => [service, ['chat']]));
    const serviceApiProtocols = Object.fromEntries(
      services.map((service) => [service, ['openai-images'] as const]),
    );
    const serviceUnitBillingModels = Object.fromEntries(
      services.map((service) => [service, {
        'openai-images': { version: 2 as const, components: [{ priceMicroUsdc: '40000' }] },
      }]),
    );
    const serviceCapabilities = Object.fromEntries(
      services.map((service) => [service, { inputs: ['text'] as const }]),
    );
    const original = makeMetadata({
      providers: [{
        provider: 'openai',
        services,
        defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        servicePricing,
        serviceCategories,
        serviceApiProtocols,
        serviceUnitBillingModels,
        serviceCapabilities,
        maxConcurrency: 10,
        currentLoad: 0,
      }],
    });

    const decoded = decodeMetadata(encodeMetadata(original));

    expect(decoded.version).toBe(METADATA_VERSION);
    expect(decoded.providers[0]?.services).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.servicePricing ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceCategories ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceApiProtocols ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceUnitBillingModels ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceCapabilities ?? {})).toHaveLength(300);
  });

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

  it('round-trips v13 quantity billing models and signs billing bytes', () => {
    const original = makeMetadata({
      version: METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': { version: 2, components: [{ priceMicroUsdc: "40000" }] },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.version).toBe(2);
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.components[0]?.priceMicroUsdc).toBe('40000');

    const changed = makeMetadata({
      ...original,
      providers: [{
        ...original.providers[0]!,
        serviceUnitBillingModels: {
          'gpt-image-1': {
            'openai-images': { version: 2, components: [{ priceMicroUsdc: "50000" }] },
          },
        },
      }],
    });
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(original));
  });

  it('round-trips v12 service capabilities and signs capability bytes', () => {
    const original = makeMetadata({
      version: SERVICE_CAPABILITIES_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-5.5', 'gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceCapabilities: {
            'gpt-5.5': {
              contextWindow: 200_000,
              maxOutputTokens: 16_384,
              inputs: ['text', 'image'],
              reasoning: true,
              toolUse: false,
            },
            'gpt-image-1': {
              inputs: ['text'],
              outputs: ['image'],
              // Deliberately unsorted: the codec canonicalizes to code-unit order.
              supportedParameters: ['size', 'background', 'quality', 'output_format'],
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-5.5']).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      inputs: ['text', 'image'],
      reasoning: true,
      toolUse: false,
    });
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-5.5']?.structuredOutput).toBeUndefined();
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-image-1']).toEqual({
      inputs: ['text'],
      outputs: ['image'],
      supportedParameters: ['background', 'output_format', 'quality', 'size'],
    });
    // Decoded metadata re-encodes to the same bytes, so signatures verify.
    expect(encodeMetadataForSigning({ ...decoded, signature: original.signature }))
      .toEqual(encodeMetadataForSigning(original));

    const changed = makeMetadata({
      ...original,
      providers: [{
        ...original.providers[0]!,
        serviceCapabilities: {
          ...original.providers[0]!.serviceCapabilities,
          'gpt-5.5': { contextWindow: 128_000 },
        },
      }],
    });
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(original));
  });

  it('excludes service capabilities from v10 metadata bytes', () => {
    const original = makeMetadata({
      version: 10,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-5.5'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceCapabilities: { 'gpt-5.5': { contextWindow: 200_000 } },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });

    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(10);
    expect(decoded.providers[0]?.serviceCapabilities).toBeUndefined();
  });

  it('rejects dropping service unit billing models from v10 metadata bytes', () => {
    const original = makeMetadata({
      version: 10,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': { version: 2, components: [{ priceMicroUsdc: "40000" }] },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });

    expect(() => encodeMetadata(original)).toThrow('Quantity billing requires metadata v13 or newer');
    expect(() => encodeMetadataForSigning(original)).toThrow('Quantity billing requires metadata v13 or newer');
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
      onChainChannelCount: 123,
      onChainGhostCount: 2,
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.offerings?.[0]?.name).toBe('summarize');
    expect(decoded.onChainChannelCount).toBe(123);
    expect(decoded.onChainGhostCount).toBe(2);
  });

  it("round-trips a v8 metadata with sellerContract", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: 8,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      sellerContract: "bb".repeat(20),
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.sellerContract).toEqual(meta.sellerContract);
  });

  it("round-trips v8 metadata with no sellerContract", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: 8,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.sellerContract).toBeUndefined();
  });

  it("round-trips domain verification claims", () => {
    const original = makeMetadata({
      verifications: {
        domains: [
          { domain: "example.com", methods: ["https-well-known", "dns-txt"] },
          { domain: "api.example.com" },
        ],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      domains: [
        { domain: "api.example.com" },
        { domain: "example.com", methods: ["dns-txt", "https-well-known"] },
      ],
    });
  });

  it("round-trips github verification claims", () => {
    const original = makeMetadata({
      verifications: {
        github: [
          { username: "Octocat", repository: "Proofs" },
          { username: "hubber" },
        ],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      github: [
        { username: "hubber" },
        { username: "octocat", repository: "proofs" },
      ],
    });
  });

  it("round-trips combined domain and github verification claims", () => {
    const original = makeMetadata({
      verifications: {
        domains: [{ domain: "example.com", methods: ["dns-txt"] }],
        github: [{ username: "octocat" }],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      domains: [{ domain: "example.com", methods: ["dns-txt"] }],
      github: [{ username: "octocat" }],
    });
  });

  it("round-trips v10 metadata with peer capabilities", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: METADATA_VERSION,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      capabilities: ["verification.response-auth.v1"],
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.capabilities).toEqual(["verification.response-auth.v1"]);
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
