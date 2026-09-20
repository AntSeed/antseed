import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { signData, verifySignature } from '@antseed/protocol';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import type { PeerMetadata, ServiceCapabilities } from '../src/discovery/peer-metadata.js';

function metadata(capabilities: ServiceCapabilities = { reasoning: true, reasoningEfforts: ['none', 'high', 'low'] }): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: 13,
    providers: [{
      provider: 'openai', services: ['model'],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      serviceApiProtocols: { model: ['openai-responses'] },
      serviceCapabilities: { model: capabilities }, maxConcurrency: 1, currentLoad: 0,
    }],
    region: 'us-east-1', timestamp: Date.now(), signature: 'b'.repeat(130),
  };
}

describe('reasoning effort announcements', () => {
  it('round trips signed efforts in canonical order and detects tampering', () => {
    const source = metadata();
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const signature = signData(wallet, encodeMetadataForSigning(source));
    const decoded = decodeMetadata(encodeMetadata(source));
    expect(validateMetadata(decoded)).toEqual([]);
    expect(decoded.providers[0]!.serviceCapabilities!.model!.reasoningEfforts).toEqual(['high', 'low', 'none']);
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(decoded))).toBe(true);
    decoded.providers[0]!.serviceCapabilities!.model!.reasoningEfforts = ['low'];
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(decoded))).toBe(false);
  });

  it.each([10, 11, 12])('rejects efforts on metadata v%s rather than silently dropping them', (version) => {
    const source = metadata();
    source.version = version;
    expect(() => encodeMetadata(source)).toThrow('v13');
    expect(validateMetadata(source).length).toBeGreaterThan(0);
  });

  it.each([[], ['high', 'high'], ['unknown'], 'high', ['high', 3]])('rejects invalid advertised efforts %j', (efforts) => {
    const source = metadata({ reasoningEfforts: efforts as never });
    expect(validateMetadata(source).length).toBeGreaterThan(0);
    expect(() => encodeMetadata(source)).toThrow();
  });

  it('rejects unknown, duplicate, empty, and truncated efforts on the wire', () => {
    const encoded = encodeMetadata(metadata({ reasoningEfforts: ['high', 'none'] }));
    const highOffset = Buffer.from(encoded).indexOf(Buffer.from('high'));
    const noneOffset = Buffer.from(encoded).indexOf(Buffer.from('none'));
    expect(highOffset).toBeGreaterThan(1);
    for (const replacement of ['oops', 'none']) {
      const malformed = encoded.slice();
      malformed.set(Buffer.from(replacement), highOffset);
      expect(() => decodeMetadata(malformed)).toThrow('reasoningEfforts');
    }
    const empty = Buffer.concat([encoded.slice(0, highOffset - 2), Buffer.from([0]), encoded.slice(noneOffset + 4)]);
    expect(() => decodeMetadata(empty)).toThrow('reasoningEfforts');
    expect(() => decodeMetadata(encoded.slice(0, highOffset + 2))).toThrow();
  });

  it.each([12, 13])('preserves capabilities without effort lists on v%s', (version) => {
    const source = metadata({ reasoning: true, toolUse: false });
    source.version = version;
    const decoded = decodeMetadata(encodeMetadata(source));
    expect(decoded.providers[0]!.serviceCapabilities).toEqual(source.providers[0]!.serviceCapabilities);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(source));
  });
});
