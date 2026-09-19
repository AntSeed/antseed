import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { signData, verifySignature } from '@antseed/protocol/signing';
import { createPerCallBillingModel, perCallPriceMicroUsdc } from '../src/types/billing.js';
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
  it.each([
    [10, '7fbaff7b6bf576f77b540c6451116131f9dc59a5c69c6bb7e6dbf57cf9d90192'],
    [11, 'df3b03a4dd68378b40583606fe32f9a246ae3fd5ca18df23eb534a66b4eb58b0'],
    [12, '2e7d69eb927b550484287475aad0ba6b0f295e2eadaba574ce60e2e5c0e8129a'],
  ] as const)('preserves the v%s wire baseline', (version, expectedHash) => {
    const metadata = makeMetadata({ version });
    const provider = metadata.providers[0]!;
    provider.serviceApiProtocols = { 'claude-3-opus': ['anthropic-messages'] };
    if (version >= 11) {
      provider.serviceUnitBillingModels = { 'claude-3-opus': { 'anthropic-messages': createPerCallBillingModel('16777217') } };
    }
    if (version >= 12) {
      provider.serviceCapabilities = {
        'claude-3-opus': {
          contextWindow: 200000,
          maxOutputTokens: 8192,
          inputs: ['text', 'image'],
          outputs: ['text'],
          reasoning: false,
          toolUse: true,
          structuredOutput: true,
          supportedParameters: ['temperature', 'seed'],
        },
      };
    }
    const encoded = encodeMetadata(metadata);
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(expectedHash);
    expect(encodeMetadata(decodeMetadata(encoded))).toEqual(encoded);
  });

  it.each([true, false, undefined])('verifies signed v13 routing %s after round-trip', (routing) => {
    const wallet = new Wallet('0x' + '01'.repeat(32));
    const metadata = makeMetadata({ version: 13, peerId: wallet.address.slice(2).toLowerCase() as PeerMetadata['peerId'] });
    metadata.providers[0]!.serviceCapabilities = {
      'claude-3-opus': {
        ...(routing !== undefined ? { routing } : {}),
        reasoning: false,
        toolUse: true,
        structuredOutput: true,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        inputs: ['text', 'image'],
        outputs: ['text'],
        supportedParameters: ['seed', 'temperature'],
      },
      'claude-3-sonnet': { toolUse: false },
    };
    metadata.providers[0]!.serviceUnitBillingModels = {
      'claude-3-opus': {
        'anthropic-messages': createPerCallBillingModel('16777217'),
        'openai-chat-completions': createPerCallBillingModel('0'),
      },
    };
    metadata.signature = Buffer.from(signData(wallet, encodeMetadataForSigning(metadata))).toString('hex');
    const decoded = decodeMetadata(encodeMetadata(metadata));
    expect(decoded.providers[0]!.serviceCapabilities).toEqual(metadata.providers[0]!.serviceCapabilities);
    expect(decoded.providers[0]!.serviceUnitBillingModels).toEqual(metadata.providers[0]!.serviceUnitBillingModels);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(metadata));
    expect(verifySignature(decoded.peerId, Buffer.from(decoded.signature, 'hex'), encodeMetadataForSigning(decoded))).toBe(true);
    decoded.providers[0]!.serviceCapabilities!['claude-3-opus']!.routing = routing !== true;
    expect(verifySignature(decoded.peerId, Buffer.from(decoded.signature, 'hex'), encodeMetadataForSigning(decoded))).toBe(false);
  });

  it.each([10, 11, 12])('rejects routing capability downgrades to v%s', (version) => {
    for (const routing of [true, false]) {
      const metadata = makeMetadata({ version });
      metadata.providers[0]!.serviceCapabilities = { 'claude-3-opus': { routing } };
      expect(() => encodeMetadata(metadata)).toThrow('Service routing capability requires metadata v13 or newer');
      expect(() => encodeMetadataForSigning(metadata)).toThrow('Service routing capability requires metadata v13 or newer');
    }
  });

  it('rejects non-boolean routing during encoding', () => {
    const metadata = makeMetadata({ version: 13 });
    metadata.providers[0]!.serviceCapabilities = { 'claude-3-opus': { routing: 'true' as unknown as boolean } };
    expect(() => encodeMetadata(metadata)).toThrow('Service routing capability must be a boolean');
  });

  it.each([
    { presence: 0x0200, value: 0, message: 'Unknown service capability presence bits' },
    { presence: 0x0100, value: 0x10, message: 'Unknown service capability value bits' },
    { presence: 0, value: 0x08, message: 'Service routing capability value requires presence bit' },
  ])('rejects malformed v13 capability flags $presence/$value', ({ presence, value, message }) => {
    const metadata = makeMetadata({ version: 13 });
    metadata.providers[0]!.serviceCapabilities = { 'claude-3-opus': { routing: true } };
    const encoded = Buffer.from(encodeMetadata(metadata));
    const presenceOffset = encoded.lastIndexOf('claude-3-opus') + Buffer.byteLength('claude-3-opus');
    encoded.writeUInt16BE(presence, presenceOffset);
    encoded[presenceOffset + 2] = value;
    expect(() => decodeMetadata(encoded)).toThrow(message);
  });

  it('rejects routing value bits in a v12 capability entry', () => {
    const metadata = makeMetadata({ version: 12 });
    metadata.providers[0]!.serviceCapabilities = { 'claude-3-opus': { reasoning: false } };
    const encoded = Buffer.from(encodeMetadata(metadata));
    const presenceOffset = encoded.lastIndexOf('claude-3-opus') + Buffer.byteLength('claude-3-opus');
    encoded[presenceOffset + 1] = 0x08;
    expect(() => decodeMetadata(encoded)).toThrow('Unknown service capability value bits');
  });

  it.each([7, 8, 9, 10])('rejects a per-call advertisement downgraded to metadata v%s', (version) => {
    const metadata = makeMetadata({ version });
    metadata.providers[0]!.serviceUnitBillingModels = { 'claude-3-opus': { 'anthropic-messages': createPerCallBillingModel('5000') } };
    expect(() => encodeMetadata(metadata)).toThrow('Service unit billing requires metadata v11 or newer');
    expect(() => encodeMetadataForSigning(metadata)).toThrow('Service unit billing requires metadata v11 or newer');
  });
  it.each(['0', '1', '5000', '16777217', '4294967295'])('round-trips per-call pricing without float32 rounding: %s', (amount) => {
    const original = makeMetadata();
    original.providers[0]!.serviceUnitBillingModels = { 'claude-3-opus': { 'anthropic-messages': createPerCallBillingModel(amount) } };
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(perCallPriceMicroUsdc(decoded.providers[0]!.serviceUnitBillingModels?.['claude-3-opus']?.['anthropic-messages'])).toBe(BigInt(amount));
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });
  it.each([12, 13])('round-trips v%s catalogs with more than 255 service entries', (version) => {
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
        'openai-images': {
          version: 1 as const,
          components: [{ unit: 'output_images' as const, priceUsd: 0.04 }],
        },
      }]),
    );
    const serviceCapabilities = Object.fromEntries(
      services.map((service) => [service, { inputs: ['text'] as const }]),
    );
    const original = makeMetadata({
      version,
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

    expect(decoded.version).toBe(version);
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

  it('round-trips v11 service unit billing models and signs billing bytes', () => {
    const original = makeMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': {
                version: 1,
                components: [
                  { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
                ],
              },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.components).toHaveLength(1);
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.components[0]?.priceUsd).toBeCloseTo(0.04, 5);

    const changed = makeMetadata({
      ...original,
      providers: [{
        ...original.providers[0]!,
        serviceUnitBillingModels: {
          'gpt-image-1': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.05 }],
            },
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
              'openai-images': {
                version: 1,
                components: [{ unit: 'output_images', priceUsd: 0.04 }],
              },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });

    expect(() => encodeMetadata(original)).toThrow('Service unit billing requires metadata v11 or newer');
    expect(() => encodeMetadataForSigning(original)).toThrow('Service unit billing requires metadata v11 or newer');
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
